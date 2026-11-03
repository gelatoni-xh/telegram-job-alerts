import { randomUUID } from 'node:crypto';
import type { Prisma, Task } from '@prisma/client';
import type { Db } from './db.js';
export async function enqueue(db:Db,type:string,key:string,payload:Prisma.InputJsonValue={},dueAt=new Date()) {
 return db.task.upsert({where:{dedupeKey:key},create:{type,dedupeKey:key,payload,dueAt},update:{}});
}
export async function claim(db:Db,types:string[]) {
 const token=randomUUID();
 return db.$transaction(async tx=>{
  const rows=await tx.$queryRaw<Task[]>`
   SELECT t.* FROM "Task" t WHERE t.type=ANY(${types}::text[])
   AND ((t.status='pending' AND t."dueAt"<=now()) OR (t.status='running' AND t."leaseUntil"<now()))
   AND (t.type<>'inbox' OR NOT EXISTS (SELECT 1 FROM "Task" older WHERE older.type='inbox'
    AND older.payload->>'chatId'=t.payload->>'chatId' AND (older."createdAt",older.id)<(t."createdAt",t.id) AND older.status IN ('pending','running')))
   ORDER BY t."createdAt",t.id FOR UPDATE SKIP LOCKED LIMIT 1`;
  if(!rows[0])return null;
  return tx.task.update({where:{id:rows[0].id},data:{status:'running',attempts:{increment:1},leaseUntil:new Date(Date.now()+90000),leaseToken:token}});
 });
}
export function safeError(e:unknown){if(e instanceof Error)return e.name==='ZodError'?'Input/schema validation failed':e.message.replace(/https?:\/\/\S+/g,'[url]').replace(/postgres(?:ql)?:\/\/\S+/g,'[database]').replace(/\b\d{6,}:[A-Za-z0-9_-]+/g,'[token]').slice(0,300);return 'Unknown error';}
export async function runOne(db:Db,types:string[],handler:(task:Task)=>Promise<void>) {
 const task=await claim(db,types);if(!task)return false;
 let lost=false;
 const heartbeat=setInterval(()=>{db.task.updateMany({where:{id:task.id,status:'running',leaseToken:task.leaseToken},data:{leaseUntil:new Date(Date.now()+90000)}}).then(r=>{if(!r.count)lost=true;}).catch(()=>{lost=true;});},20000);
 try {
  await handler(task);
  if(lost)throw new Error('Task lease lost');
  await db.task.updateMany({where:{id:task.id,leaseToken:task.leaseToken},data:{status:'done',leaseUntil:null}});
 }catch(e){
  const retryAfter=typeof (e as {retryAfter?:number})?.retryAfter==='number'?(e as {retryAfter:number}).retryAfter:Math.min(3600,30*2**Math.min(task.attempts-1,7));
  await db.task.updateMany({where:{id:task.id,leaseToken:task.leaseToken},data:{status:task.attempts>=8?'failed':'pending',dueAt:new Date(Date.now()+(retryAfter+Math.random()*10)*1000),leaseUntil:null,error:safeError(e)}});
 }finally{clearInterval(heartbeat);}
 return true;
}
