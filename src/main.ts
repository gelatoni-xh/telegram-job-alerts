import { screenHtml } from './ui.js';
import { InlineKeyboard } from 'grammy';
import type { Update } from 'grammy/types';
import { readConfig } from './config.js';
import { createDb,verifyDatabase,acquireRuntimeLock } from './db.js';
import { createBot } from './bot.js';
import { createHttp } from './http.js';
import { enqueue,runOne,safeError } from './tasks.js';
import { syncSource,checkStatuses } from './jobs.js';
import { generateDigest,deliverDigest,scheduleUsers } from './digests.js';
import { cleanup } from './maintenance.js';
const config=readConfig();
if(config.NODE_ENV==='production'&&(!/^\d+:[\w-]+$/.test(config.BOT_TOKEN)||config.WEBHOOK_SECRET.length<32))throw new Error('Production bot credentials are missing or invalid');
const db=createDb(config);await verifyDatabase(db,config.EXPECTED_DATABASE);
const releaseLock=await acquireRuntimeLock(db);
const bot=config.BOT_TOKEN?createBot(db,config):null;
if(bot)await bot.init();
const app=createHttp(db,config);
await db.delivery.updateMany({where:{status:'sending'},data:{status:'uncertain',nextAttemptAt:new Date(Date.now()+120000),error:'Process restarted during send'}});
await app.listen({host:'0.0.0.0',port:config.PORT});
console.log(JSON.stringify({event:'started',port:config.PORT}));
let stopped=false;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function worker(types:string[]) {
 while(!stopped){try{
  const ran=await runOne(db,types,async task=>{
   const p=task.payload as Record<string,string>;
   switch(task.type){
    case 'inbox':{if(!bot)throw new Error('Bot is not configured');const row=await db.inboxUpdate.findUnique({where:{id:BigInt(p.updateId!)}});if(row?.payload&&row.status!=='done'){await bot.handleUpdate(row.payload as unknown as Update);await db.inboxUpdate.updateMany({where:{id:row.id},data:{status:'done',processedAt:new Date()}});}break;}
    case 'sync':await syncSource(db);break;
    case 'status':{let pages=0;while(!stopped&&pages++<100){const n=await db.job.count({where:{status:{not:'closed'},checkedAt:{lt:new Date(Date.now()-3600_000)}}});if(!n)break;await checkStatuses(db);}break;}
    case 'digest':await generateDigest(db,BigInt(p.userId!));break;
    case 'deliver':if(!bot||!config.DELIVERY_ENABLED)throw new Error('Delivery is disabled');await deliverDigest(db,p.id!,{send:async(chat,text,id)=>(await bot.api.sendMessage(String(chat),screenHtml(text),{parse_mode:'HTML',reply_markup:new InlineKeyboard().text('View daily matches →',`D|${id}|0`),link_preview_options:{is_disabled:true}})).message_id});break;
    case 'cleanup':await cleanup(db);break;
   }
  });
  if(!ran)await pause(2000);
 }catch(e){console.error(JSON.stringify({event:'worker_error',lane:types,error:safeError(e)}));await pause(5000);}}
}
async function scheduler(){while(!stopped){try{
 const hour=Math.floor(Date.now()/3600000),day=Math.floor(Date.now()/86400000);
 if(config.SOURCE_SYNC_ENABLED){await enqueue(db,'sync',`sync:${hour}`);await enqueue(db,'status',`status:${hour}`);}
 if(config.SCHEDULER_ENABLED)await scheduleUsers(db);
 await enqueue(db,'cleanup',`cleanup:${day}`);
 }catch(e){console.error(JSON.stringify({event:'scheduler_error',error:safeError(e)}));}
 await pause(30000);
}}
const loops=[worker(['inbox']),worker([...(config.SOURCE_SYNC_ENABLED?['sync','status']:[]),...(config.SCHEDULER_ENABLED?['digest']:[]),'cleanup']),...(config.DELIVERY_ENABLED?[worker(['deliver'])]:[]),scheduler()];
async function shutdown(){if(stopped)return;stopped=true;await app.close();await Promise.race([Promise.all(loops),pause(25000)]);releaseLock();await db.$disconnect();process.exit(0);}
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
