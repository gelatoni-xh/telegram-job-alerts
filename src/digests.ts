import { Prisma, type DigestItem, type Job } from '@prisma/client';
import type { Db } from './db.js';
import { boundary,lockUser } from './db.js';
import { localDate,nextDue } from './rules.js';
import { matchSql,checkStatuses } from './jobs.js';
import { enqueue } from './tasks.js';
export type Match={id:string;revision:number;name:string};
export async function generateDigest(db:Db,userId:bigint,now=new Date()) {
 return db.$transaction(async tx=>{
  await lockUser(tx,userId);
  const user=await tx.user.findUnique({where:{id:userId}});
  if(!user||user.paused||user.unreachable||!user.timezoneConfirmed)return null;
  const date=localDate(user.timezone,now);
  const old=await tx.digest.findUnique({where:{userId_localDate:{userId,localDate:date}}});
  const due=nextDue(user.timezone,user.sendTime,now);
  if(old){await tx.user.update({where:{id:userId},data:{nextDue:due}});return old;}
  const upper=await boundary(tx);
  const digest=await tx.digest.create({data:{userId,localDate:date,timezone:user.timezone}});
  const subs=await tx.subscription.findMany({where:{userId,paused:false}});
  const candidates=new Map<string,Match[]>();
  for(const sub of subs) {
   const jobs=await tx.$queryRaw<{id:string;status:string;checkedAt:Date}[]>`SELECT j.id,j.status,j."checkedAt" FROM "Job" j WHERE j.discovery>${sub.watermark} AND j.discovery<=${upper} AND j.status<>'closed' ${matchSql(sub)}`;
   const deferred=await tx.deferredMatch.findMany({where:{subscriptionId:sub.id,revision:sub.revision},select:{jobId:true}});
   const extra=deferred.length?await tx.job.findMany({where:{id:{in:deferred.map(j=>j.jobId)}},select:{id:true,status:true,checkedAt:true}}):[];
   const byId=new Map([...jobs,...extra].map(j=>[j.id,j]));
   for(const job of byId.values()) {
    if(job.status==='closed'){await tx.deferredMatch.deleteMany({where:{subscriptionId:sub.id,jobId:job.id}});continue;}
    if(job.status!=='active'||job.checkedAt.getTime()<now.getTime()-24*3600_000){await tx.deferredMatch.upsert({where:{subscriptionId_revision_jobId:{subscriptionId:sub.id,revision:sub.revision,jobId:job.id}},create:{subscriptionId:sub.id,revision:sub.revision,jobId:job.id},update:{}});continue;}
    candidates.set(job.id,[...(candidates.get(job.id)??[]),{id:sub.id,revision:sub.revision,name:sub.name}]);
    await tx.deferredMatch.deleteMany({where:{subscriptionId:sub.id,jobId:job.id}});
   }
   await tx.subscription.update({where:{id:sub.id},data:{watermark:upper}});
  }
  const sorted=candidates.size?await tx.$queryRaw<{id:string}[]>`SELECT id FROM "Job" WHERE id IN (${Prisma.join([...candidates.keys()])}) ORDER BY COALESCE("publishedAt","firstSeenAt") DESC,id DESC`:[];
  if(sorted.length) {
   await tx.digestItem.createMany({data:sorted.map((j,i)=>({digestId:digest.id,jobId:j.id,position:i,matches:candidates.get(j.id)!}))});
   await tx.delivery.create({data:{digestId:digest.id}});
  }else await tx.digest.update({where:{id:digest.id},data:{status:'empty'}});
  await tx.user.update({where:{id:userId},data:{nextDue:due}});
  await tx.event.upsert({where:{key:`generated:${digest.id}`},create:{key:`generated:${digest.id}`,type:'digest_generated',userId,dimensions:{digestId:digest.id,count:sorted.length}},update:{}});
  return digest;
 },{timeout:20000});
}
export async function scheduleUsers(db:Db) {
 const due=await db.user.findMany({where:{paused:false,unreachable:false,timezoneConfirmed:true,nextDue:{lte:new Date()}},take:100,select:{id:true,timezone:true}});
 for(const user of due) await enqueue(db,'digest',`digest:${user.id}:${localDate(user.timezone)}`,{userId:String(user.id)});
 const deliveries=await db.delivery.findMany({where:{status:{in:['pending','uncertain']},nextAttemptAt:{lte:new Date()}},take:100});
 for(const d of deliveries)await enqueue(db,'deliver',`delivery:${d.id}:${d.attempts}:${Math.floor(Date.now()/300000)}`,{id:d.id});
}
export type Messenger={send:(chatId:bigint,text:string,digestId:string)=>Promise<number>};
export async function deliverDigest(db:Db,id:string,messenger:Messenger,now=new Date()) {
 let d=await db.delivery.findUnique({where:{id},include:{digest:{include:{user:true}}}});
 if(!d||!['pending','uncertain'].includes(d.status))return;
 const userId=d.digest.userId;
 // Combine outstanding days into the most recent pending digest, preserving the full member set.
 const prepared=await db.$transaction(async tx=>{
  await lockUser(tx,userId);
  const user=await tx.user.findUnique({where:{id:userId}});
  if(!user||user.paused||user.unreachable)return null;
  const pending=await tx.delivery.findMany({where:{digest:{userId},status:{in:['pending','uncertain']}},include:{digest:true},orderBy:{digest:{createdAt:'desc'}}});
  const latest=pending[0];if(!latest)return null;
  for(const old of pending.slice(1)){
   const items=await tx.digestItem.findMany({where:{digestId:old.digestId}});
   for(const item of items){const existing=await tx.digestItem.findUnique({where:{digestId_jobId:{digestId:latest.digestId,jobId:item.jobId}}});
    if(existing){const matches=[...existing.matches as Match[],...item.matches as Match[]];const unique=[...new Map(matches.map(m=>[`${m.id}:${m.revision}`,m])).values()];await tx.digestItem.update({where:{id:existing.id},data:{matches:unique}});}
    else await tx.digestItem.create({data:{digestId:latest.digestId,jobId:item.jobId,matches:item.matches as Prisma.InputJsonValue,position:item.position}});
   }
   await tx.delivery.update({where:{id:old.id},data:{status:'superseded'}});
   await tx.digest.update({where:{id:old.digestId},data:{status:'superseded'}});
  }
  return {deliveryId:latest.id,digestId:latest.digestId,chatId:user.chatId};
 },{timeout:20000});
 if(!prepared)return;
 const items=await db.digestItem.findMany({where:{digestId:prepared.digestId},include:{job:true}});
 // Only refresh stale IDs; routine requests share the source limit and batch size.
 const stale=items.filter(i=>i.job.checkedAt.getTime()<now.getTime()-3600_000).map(i=>i.jobId);
 for(let i=0;i<stale.length;i+=100) await checkStatuses(db,stale.slice(i,i+100));
 const subs=await db.subscription.findMany({where:{userId,paused:false}}),valid=new Map(subs.map(s=>[s.id,s.revision]));
 const current=await db.digestItem.findMany({where:{digestId:prepared.digestId},include:{job:true}});
 const retained:(DigestItem&{job:Job})[]=[];
 for(const item of current) {
  const matches=(item.matches as Match[]).filter(m=>valid.get(m.id)===m.revision);
  if(matches.length&&item.job.status==='unknown'){
   for(const match of matches) await db.deferredMatch.upsert({where:{subscriptionId_revision_jobId:{subscriptionId:match.id,revision:match.revision,jobId:item.jobId}},create:{subscriptionId:match.id,revision:match.revision,jobId:item.jobId},update:{}});
  }
  if(!matches.length||item.job.status!=='active'){await db.digestItem.delete({where:{id:item.id}});continue;}
  await db.digestItem.update({where:{id:item.id},data:{matches}});retained.push({...item,matches});
 }
 retained.sort((a,b)=>(b.job.publishedAt??b.job.firstSeenAt).getTime()-(a.job.publishedAt??a.job.firstSeenAt).getTime()||b.jobId.localeCompare(a.jobId));
 await db.$transaction(retained.map((item,position)=>db.digestItem.update({where:{id:item.id},data:{position}})));
 if(!retained.length){await db.delivery.update({where:{id:prepared.deliveryId},data:{status:'cancelled'}});return;}
 const live=await db.user.findUnique({where:{id:userId}});if(!live||live.paused||live.unreachable)return;
 const source=await db.syncRun.findFirst({where:{status:'complete'},orderBy:{finishedAt:'desc'}});
 const text=`${retained.length} new matching job${retained.length===1?'':'s'}\n\n${retained.slice(0,3).map((i,n)=>`${n+1}. ${i.job.title.slice(0,150)} — ${i.job.company.slice(0,80)}\n${i.job.geo}\n${(i.matches as Match[]).map(m=>m.name).join('; ').slice(0,140)}`).join('\n\n')}\n\nSource: Jobicy. View all to see every match.\nLast complete sync: ${source?.finishedAt?.toISOString()??'not yet complete'}`;
 // Persist sending first: a crash after this point is an uncertain outcome, never an assumed success.
 await db.delivery.update({where:{id:prepared.deliveryId},data:{status:'sending',attempts:{increment:1}}});
 try {
  const messageId=await messenger.send(prepared.chatId,text.slice(0,3900),prepared.digestId);
  await db.$transaction([
   db.delivery.update({where:{id:prepared.deliveryId},data:{status:'sent',messageId:BigInt(messageId),error:null}}),
   db.digest.update({where:{id:prepared.digestId},data:{status:'sent'}}),
   db.event.upsert({where:{key:`sent:${prepared.digestId}`},create:{key:`sent:${prepared.digestId}`,type:'digest_sent',userId,dimensions:{digestId:prepared.digestId,count:retained.length}},update:{}})
  ]);
 }catch(e){
  const err=e as {error_code?:number;parameters?:{retry_after?:number}};
  if(err.error_code===403){await db.user.update({where:{id:userId},data:{unreachable:true}});await db.delivery.update({where:{id:prepared.deliveryId},data:{status:'unreachable',error:'Telegram 403'}});return;}
  const definite=typeof err.error_code==='number';
  const fresh=await db.delivery.findUniqueOrThrow({where:{id:prepared.deliveryId}});
  await db.delivery.update({where:{id:prepared.deliveryId},data:{status:fresh.attempts>=8?'failed':definite?'pending':'uncertain',error:definite?`Telegram ${err.error_code}`:'Delivery outcome unknown',nextAttemptAt:new Date(Date.now()+(err.parameters?.retry_after??Math.min(3600,60*2**fresh.attempts))*1000)}});
 }
}
