import type { Db } from './db.js';
import { boundary, lockUser } from './db.js';
import { normalizeFilters, filterHash, type Filters, nextDue } from './rules.js';
export async function saveSubscription(db:Db,userId:bigint,f:Filters,id?:string) {
 f=normalizeFilters(f);
 return db.$transaction(async tx=>{
  await lockUser(tx,userId);
  const watermark=await boundary(tx), hash=filterHash(f);
  const duplicate=await tx.subscription.findUnique({where:{userId_filterHash:{userId,filterHash:hash}}});
  if(duplicate&&duplicate.id!==id)return duplicate;
  const name=[f.countries.join(', ')||'Any country',f.categories.join(', ')||'Any occupation',f.keyword].filter(Boolean).join(' · ').slice(0,180);
  if(id){const old=await tx.subscription.findFirst({where:{id,userId}});if(!old)throw new Error('Subscription not found');await tx.deferredMatch.deleteMany({where:{subscriptionId:id}});return tx.subscription.update({where:{id},data:{...f,name,filterHash:hash,watermark,revision:{increment:1}}});}
  return tx.subscription.create({data:{userId,...f,name,filterHash:hash,watermark}});
 });
}
export async function setPaused(db:Db,userId:bigint,id:string,paused:boolean) {
 await db.$transaction(async tx=>{
  await lockUser(tx,userId);const sub=await tx.subscription.findFirst({where:{id,userId}});if(!sub)throw new Error('Subscription not found');
  const watermark=await boundary(tx);
  await tx.subscription.update({where:{id},data:{paused,watermark,revision:{increment:1}}});
  await tx.deferredMatch.deleteMany({where:{subscriptionId:id}});
 });
}
export async function pauseAll(db:Db,userId:bigint,paused:boolean) {
 await db.$transaction(async tx=>{
  await lockUser(tx,userId);const watermark=await boundary(tx);
  await tx.user.update({where:{id:userId},data:{paused}});
  await tx.subscription.updateMany({where:{userId},data:{watermark,revision:{increment:1}}});
  const subs=await tx.subscription.findMany({where:{userId},select:{id:true}});
  await tx.deferredMatch.deleteMany({where:{subscriptionId:{in:subs.map(s=>s.id)}}});
 });
}
export async function setSchedule(db:Db,userId:bigint,timezone:string,sendTime:string) {
 const due=nextDue(timezone,sendTime);
 await db.user.update({where:{id:userId},data:{timezone,timezoneConfirmed:true,sendTime,nextDue:due}});
}
