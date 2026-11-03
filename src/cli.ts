import { readConfig } from './config.js';
import { createDb,verifyDatabase } from './db.js';
import { createBot } from './bot.js';
import { doctor } from './maintenance.js';
import { syncSource,checkStatuses } from './jobs.js';
import { replayDeletions } from './privacy.js';
import { safeError } from './tasks.js';
const config=readConfig(),db=createDb(config);
try{
 await verifyDatabase(db,config.EXPECTED_DATABASE);
 switch(process.argv[2]){
  case 'identity':console.log('Database identity verified');break;
  case 'doctor':{const status=await doctor(db);console.log(JSON.stringify(status,null,2));if(status.failed||status.uncertain)process.exitCode=1;break;}
  case 'sync':await syncSource(db);console.log('Source traversal complete or source interval not yet elapsed');break;
  case 'status':await checkStatuses(db);console.log('Status batch checked');break;
  case 'webhook':{if(config.WEBHOOK_SECRET.length<32)throw new Error('Webhook secret must be at least 32 characters');const bot=createBot(db,config);await bot.api.setWebhook(config.WEBHOOK_URL,{secret_token:config.WEBHOOK_SECRET,max_connections:1,allowed_updates:['message','callback_query'],drop_pending_updates:false});const info=await bot.api.getWebhookInfo();console.log(JSON.stringify({url:info.url,pending:info.pending_update_count,lastError:info.last_error_message??null}));break;}
  case 'commands':{const bot=createBot(db,config);const commands=[{command:'start',description:'Open Remote Job Radar'},{command:'menu',description:'Home and your current search'},{command:'help',description:'How search and daily alerts work'},{command:'privacy',description:'Privacy and your data'}];await bot.api.setMyCommands(commands);if(config.ADMIN_TELEGRAM_ID)await bot.api.setMyCommands([...commands,{command:'stats',description:'Private business activity report'}],{scope:{type:'chat',chat_id:config.ADMIN_TELEGRAM_ID}});console.log('Bot command menu updated');break;}
  case 'remove-webhook':{const bot=createBot(db,config);await bot.api.deleteWebhook({drop_pending_updates:false});console.log('Webhook removed; pending updates preserved');break;}
  case 'replay-deletions':{const at=process.argv[3];if(!at||!Number.isFinite(Date.parse(at)))throw new Error('Provide backup timestamp');await replayDeletions(db,config.DELETION_JOURNAL_PATH,new Date(at));console.log('Deletion journal replayed');break;}
  case 'retry-failed':{const id=process.argv[3];if(!id)throw new Error('Provide a task ID');await db.task.update({where:{id},data:{status:'pending',attempts:0,dueAt:new Date(),leaseUntil:null,leaseToken:null}});console.log('Task queued');break;}
  default:throw new Error('Unknown operation');
 }
}catch(e){console.error(safeError(e));process.exitCode=1;}finally{await db.$disconnect();}
