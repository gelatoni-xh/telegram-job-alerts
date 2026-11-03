import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.js';
import { verifyDatabase } from './db.js';
import type { Config } from './config.js';
import type { Prisma } from '@prisma/client';
const updateSchema=z.object({update_id:z.number().int().nonnegative(),message:z.object({chat:z.object({id:z.number().int(),type:z.string()})}).passthrough().optional(),callback_query:z.object({from:z.object({id:z.number().int()}),message:z.object({chat:z.object({id:z.number().int(),type:z.string()})}).passthrough().optional()}).passthrough().optional()}).passthrough();
export function createHttp(db:Db,config:Config) {
 const app=Fastify({bodyLimit:1024*1024,logger:false,requestTimeout:15000});
 app.get('/healthz',async()=>({ok:true}));
 app.get('/readyz',async(_req,reply)=>{try{await verifyDatabase(db,config.EXPECTED_DATABASE);await db.discoveryCounter.count();return {ok:true};}catch{return reply.code(503).send({ok:false});}});
 app.post('/bots/telegram-job-alerts/webhook',async(req,reply)=>{
  const supplied=req.headers['x-telegram-bot-api-secret-token'];
  if(typeof supplied!=='string'||!config.WEBHOOK_SECRET||Buffer.byteLength(supplied)!==Buffer.byteLength(config.WEBHOOK_SECRET)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(config.WEBHOOK_SECRET)))return reply.code(403).send({ok:false});
  const parsed=updateSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({ok:false});
  const update=parsed.data,chat=update.message?.chat??update.callback_query?.message?.chat;
  if(!chat||chat.type!=='private')return {ok:true};
  try {
   await db.$transaction(async tx=>{
    const existing=await tx.inboxUpdate.findUnique({where:{id:BigInt(update.update_id)},select:{id:true}});if(existing)return;
    // Excess requests receive 429 without being acknowledged, so Telegram can retry.
    const recent=await tx.inboxUpdate.count({where:{chatId:BigInt(chat.id),createdAt:{gt:new Date(Date.now()-60000)}}});
    if(recent>=60)throw new Error('Chat rate limit');
    await tx.inboxUpdate.create({data:{id:BigInt(update.update_id),chatId:BigInt(chat.id),payload:update as Prisma.InputJsonValue,status:'pending'}});
    await tx.task.create({data:{type:'inbox',dedupeKey:`inbox:${update.update_id}`,payload:{updateId:String(update.update_id),chatId:String(chat.id)}}});
   });
   return {ok:true};
  }catch(e){if(e instanceof Error&&e.message==='Chat rate limit')return reply.header('retry-after','60').code(429).send({ok:false});if((e as {code?:string}).code==='P2002')return {ok:true};return reply.code(503).send({ok:false});}
 });
 return app;
}
