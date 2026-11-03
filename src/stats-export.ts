import { GrammyError, type Api } from 'grammy';
import type { Db } from './db.js';
import { collectStats } from './stats.js';

export const statsPrefix='Remote Job Radar · Daily statistics export\n';
export async function exportStats(db:Db,api:Pick<Api,'sendMessage'|'editMessageText'|'pinChatMessage'>,adminId:string,now=new Date()) {
 const report=await collectStats(db,BigInt(adminId),now);
 // A non-runnable record keeps the Telegram message pointer across cleanup/restarts.
 const dedupeKey=`stats-message:${adminId}`;
 const state=await db.task.findUnique({where:{dedupeKey}});
 let messageId=(state?.payload as {messageId?:number}|undefined)?.messageId;
 const text=statsPrefix+JSON.stringify(report);
 if(text.length>4096)throw new Error('Statistics export exceeds Telegram message limit');
 if(messageId){
  try{await api.editMessageText(adminId,messageId,text);}
  catch(e){
   if(e instanceof GrammyError&&e.error_code===400&&e.description.includes('message is not modified')){}
   else if(e instanceof GrammyError&&e.error_code===400&&e.description.includes('message to edit not found'))messageId=undefined;
   else throw e;
  }
 }
 if(!messageId){
  const sent=await api.sendMessage(adminId,text,{disable_notification:true,protect_content:true});messageId=sent.message_id;
  // Persist before pinning, so a pin failure does not send duplicate messages on retry.
  await db.task.upsert({where:{dedupeKey},create:{type:'stats-message',dedupeKey,status:'held',payload:{messageId}},update:{payload:{messageId}}});
 }
 await api.pinChatMessage(adminId,messageId,{disable_notification:true});
}
