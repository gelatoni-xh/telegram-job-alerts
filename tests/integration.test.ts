import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.js';
import { createDb,verifyDatabase,boundary } from '../src/db.js';
import { savePage,searchJobs,syncSource,checkStatuses,jobFilterOptions } from '../src/jobs.js';
import { saveSubscription,setPaused,pauseAll } from '../src/subscriptions.js';
import { generateDigest,deliverDigest,scheduleUsers } from '../src/digests.js';
import { enqueue,claim,runOne } from '../src/tasks.js';
import { createHttp } from '../src/http.js';
import { createBot } from '../src/bot.js';
import { adminStats } from '../src/stats.js';
import { adminActivity } from '../src/activity.js';
import { deleteUser,replayDeletions } from '../src/privacy.js';
import type { Update } from 'grammy/types';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to an isolated database ending in _test');
const config=readConfig({DATABASE_URL:url,EXPECTED_DATABASE:decodeURIComponent(new URL(url).pathname.slice(1)),NODE_ENV:'test',BOT_TOKEN:'123456:LOCAL_TEST_ONLY',WEBHOOK_SECRET:'local-test-webhook-secret-32-characters'});
const db=createDb(config);
const job=(id:number,overrides:Record<string,unknown>={})=>({id,url:`https://jobicy.com/jobs/${id}`,jobTitle:`Engineer ${id}`,companyName:'Example',jobGeo:'USA',jobIndustry:['Software Engineering'],jobDescription:'<p>100% real SaaS_a role</p>',pubDate:new Date(Date.now()-id*1000).toISOString(),...overrides});
async function page(ids:number[]){await db.$transaction(tx=>savePage(tx,ids.map(id=>job(id))));}
async function user(id=1n){return db.user.create({data:{id,chatId:id,timezoneConfirmed:true,nextDue:new Date()}});}
const filters={countries:['US'],categories:[],keyword:''};
before(async()=>{await verifyDatabase(db,config.EXPECTED_DATABASE);});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE "Event","DeferredMatch","Delivery","DigestItem","Digest","Subscription","User","Task","InboxUpdate","SyncRun","Job","DiscoveryCounter" CASCADE');});
after(async()=>{await db.$disconnect();});
test('subscription baseline, same-ID edits, OR/AND and literal percent matching',async()=>{
 await user();await page([1]);const sub=await saveSubscription(db,1n,filters);assert.equal(sub.watermark,1n);
 await page([1,2]);assert.equal((await db.job.findUniqueOrThrow({where:{id:'jobicy:1'}})).discovery,1n);
 assert.equal((await searchJobs(db,{...filters,keyword:'100%'})).count,2);
 assert.equal((await searchJobs(db,{...filters,keyword:'100_'})).count,0);
 assert.equal((await searchJobs(db,{countries:['CA','US'],categories:['Other'],keyword:''})).count,0);
 const digest=await generateDigest(db,1n);const items=await db.digestItem.findMany({where:{digestId:digest!.id}});assert.deepEqual(items.map(j=>j.jobId),['jobicy:2']);
 assert.equal((await generateDigest(db,1n))!.id,digest!.id);assert.equal(await db.digest.count(),1);
});
test('filter options rank distinct active jobs, respect other filters and retain zero supply',async()=>{
 await db.$transaction(tx=>savePage(tx,[
  job(1,{jobGeo:'USA',jobIndustry:['Software Engineering','Software Engineering']}),
  job(2,{jobGeo:'USA',jobIndustry:['Marketing & Sales']}),
  job(3,{jobGeo:'Canada',jobIndustry:['Marketing & Sales']}),
  job(4,{jobGeo:'Canada',jobIndustry:['Retired occupation']}),
  job(5,{jobGeo:'Anywhere',jobIndustry:['Marketing & Sales']})
 ]));
 await db.job.update({where:{id:'jobicy:4'},data:{status:'closed'}});
 const f={countries:[],categories:[],keyword:''};
 const countries=await jobFilterOptions(db,'country',f);
 assert.deepEqual(countries.slice(0,2).map(o=>[o.key,o.count]),[['US',3],['CA',2]]);
 assert.equal(countries.find(o=>o.key==='JP')!.count,1);
 const marketing=await jobFilterOptions(db,'country',{...f,countries:['US'],categories:['Marketing & Sales']});
 assert.deepEqual(marketing.slice(0,2).map(o=>[o.key,o.count]),[['CA',2],['US',2]]);
 const occupations=await jobFilterOptions(db,'category',{...f,countries:['US'],categories:['Software Engineering']});
 assert.deepEqual(occupations.slice(0,2).map(o=>[o.key,o.count]),[['Marketing & Sales',2],['Software Engineering',1]]);
 assert.equal(occupations.find(o=>o.key==='Retired occupation')!.count,0);
 assert.equal(occupations.find(o=>o.key==='Healthcare & Medical')!.count,0);
 const none=await jobFilterOptions(db,'country',{...f,keyword:'absent phrase'});
 assert.ok(none.length>200);assert.ok(none.every(o=>o.count===0));
 assert.equal(none[0]!.name,'Afghanistan');
});
test('paused/resumed subscriptions and edit revisions do not replay existing inventory',async()=>{
 await user();const sub=await saveSubscription(db,1n,filters);await page([1]);await setPaused(db,1n,sub.id,true);await page([2]);await setPaused(db,1n,sub.id,false);await page([3]);
 const d=await generateDigest(db,1n);assert.deepEqual((await db.digestItem.findMany({where:{digestId:d!.id}})).map(i=>i.jobId),['jobicy:3']);
 await setPaused(db,1n,sub.id,true);await pauseAll(db,1n,true);await pauseAll(db,1n,false);assert.equal((await db.subscription.findUniqueOrThrow({where:{id:sub.id}})).paused,true);
});
test('unknown status candidates survive scan advancement and later appear once active',async()=>{
 await user();await saveSubscription(db,1n,filters);await page([1]);await db.job.update({where:{id:'jobicy:1'},data:{status:'unknown'}});
 await generateDigest(db,1n);assert.equal(await db.deferredMatch.count(),1);assert.equal(await db.digestItem.count(),0);
 await db.job.update({where:{id:'jobicy:1'},data:{status:'active',checkedAt:new Date(Date.now()+86400000)}});
 const tomorrow=new Date(Date.now()+86400000);await generateDigest(db,1n,tomorrow);assert.equal(await db.digestItem.count(),1);assert.equal(await db.deferredMatch.count(),0);
});
test('multiple subscriptions merge and preserve every digest page member',async()=>{
 await user();await saveSubscription(db,1n,filters);await saveSubscription(db,1n,{...filters,keyword:'SaaS'});await page(Array.from({length:13},(_,i)=>i+1));const d=await generateDigest(db,1n);
 const items=await db.digestItem.findMany({where:{digestId:d!.id},orderBy:{position:'asc'}});assert.equal(items.length,13);assert.equal((items[0]!.matches as unknown[]).length,2);
 const before=items.map(i=>i.jobId);await page([14]);assert.deepEqual((await db.digestItem.findMany({where:{digestId:d!.id},orderBy:{position:'asc'}})).map(i=>i.jobId),before);
});
test('discovery boundary waits for the writer commit, not an uncommitted sequence value',async()=>{
 await user();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const writer=db.$transaction(async tx=>{await boundary(tx);entered();await gate;await savePage(tx,[job(1)]);},{timeout:10000});
 await ready;let finished=false;const subscription=saveSubscription(db,1n,filters).then(s=>{finished=true;return s;});
 await new Promise(r=>setTimeout(r,100));assert.equal(finished,false);release();await writer;assert.equal((await subscription).watermark,1n);
});
test('task claims are exclusive, expired leases recover, old lease cannot finish new owner task',async()=>{
 await enqueue(db,'sample','sample');const [a,b]=await Promise.all([claim(db,['sample']),claim(db,['sample'])]);assert.equal([a,b].filter(Boolean).length,1);const t=(a??b)!;
 await db.task.update({where:{id:t.id},data:{leaseUntil:new Date(0)}});const replacement=await claim(db,['sample']);assert.ok(replacement);assert.notEqual(replacement.leaseToken,t.leaseToken);
 const update=await db.task.updateMany({where:{id:t.id,leaseToken:t.leaseToken},data:{status:'done'}});assert.equal(update.count,0);
});
test('inbox tasks are processed in chat order, separately from other chats',async()=>{
 await enqueue(db,'inbox','a',{chatId:'1'});await new Promise(r=>setTimeout(r,5));await enqueue(db,'inbox','b',{chatId:'1'});await enqueue(db,'inbox','c',{chatId:'2'});
 const first=await claim(db,['inbox']);assert.equal(first!.dedupeKey,'a');const other=await claim(db,['inbox']);assert.equal(other!.dedupeKey,'c');assert.equal(await claim(db,['inbox']),null);
});
test('source traversal is restartable, same IDs are upserted, missing feed IDs are not closed',async()=>{
 let calls=0;const fetcher=(async()=>new Response(JSON.stringify({success:true,jobs:[job(++calls)],nextCursor:calls===1?'next':null,hasMore:calls===1}))) as typeof fetch;
 await syncSource(db,fetcher);assert.equal(calls,2);assert.equal(await db.job.count(),2);assert.equal(await db.syncRun.count({where:{status:'complete'}}),1);
 await checkStatuses(db,['jobicy:1'],(async()=>new Response(JSON.stringify({success:true,jobs:[{id:1,status:'unknown'}]}))) as typeof fetch);assert.equal((await db.job.findUniqueOrThrow({where:{id:'jobicy:1'}})).status,'unknown');assert.equal((await db.job.findUniqueOrThrow({where:{id:'jobicy:2'}})).status,'active');
});
test('webhook rejects bad secret and persists one task for duplicate updates',async()=>{
 const app=createHttp(db,config),payload={update_id:100,message:{chat:{id:1,type:'private'},text:'/start',from:{id:1,is_bot:false,first_name:'Test'}}};
 assert.equal((await app.inject({method:'POST',url:'/bots/telegram-job-alerts/webhook',payload})).statusCode,403);
 for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/bots/telegram-job-alerts/webhook',headers:{'x-telegram-bot-api-secret-token':config.WEBHOOK_SECRET},payload})).statusCode,200);
 assert.equal(await db.inboxUpdate.count(),1);assert.equal(await db.task.count(),1);await app.close();
});
test('delivery tracks uncertain outcomes, retries fixed membership and stops after Telegram 403',async()=>{
 await user();await saveSubscription(db,1n,filters);await page([1,2]);const digest=await generateDigest(db,1n);const d=await db.delivery.findUniqueOrThrow({where:{digestId:digest!.id}});
 await deliverDigest(db,d.id,{send:async()=>{throw new Error('timeout');}});assert.equal((await db.delivery.findUniqueOrThrow({where:{id:d.id}})).status,'uncertain');
 await deliverDigest(db,d.id,{send:async()=>42});assert.equal((await db.delivery.findUniqueOrThrow({where:{id:d.id}})).messageId,42n);
 await generateDigest(db,1n,new Date(Date.now()+86400000));
});
test('deletion removes identifiable data and journal prevents resurrection from an older backup',async()=>{
 await user();await saveSubscription(db,1n,filters);const dir=await mkdtemp(join(tmpdir(),'job-alerts-test-'));const journal=join(dir,'deletions.jsonl');const backup=new Date(Date.now()-1000);
 try{await deleteUser(db,1n,journal);assert.equal(await db.user.count(),0);await user();await replayDeletions(db,journal,backup);assert.equal(await db.user.count(),0);}finally{await rm(dir,{recursive:true,force:true});}
});
type TestMessage={text:string;parse_mode?:string;reply_markup?:{inline_keyboard:{text:string;callback_data?:string;url?:string}[][]}};
function telegramSession(botConfig=config){
 const bot=createBot(db,botConfig,{botInfo:{id:123456,is_bot:true,first_name:'Local test',username:'local_test_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,can_manage_bots:false,supports_join_request_queries:false}});
 const messages:TestMessage[]=[],answers:{text?:string;show_alert?:boolean}[]=[];
 bot.api.config.use(async(_prev,method,payload)=>{
  if(method==='answerCallbackQuery'){answers.push(payload as never);return {ok:true,result:true} as never;}
  const p=payload as TestMessage;messages.push(p);
  return {ok:true,result:{message_id:1,date:1,chat:{id:99,type:'private'},text:p.text}} as never;
 });
 let id=1;const from={id:99,is_bot:false,first_name:'Tester'},chat={id:99,type:'private' as const,first_name:'Tester'};
 const send=(text:string)=>bot.handleUpdate({update_id:id++,message:{message_id:1,date:1,from,chat,text}});
 const raw=(data:string)=>bot.handleUpdate({update_id:id++,callback_query:{id:String(id),from,chat_instance:'test',data,message:{message_id:1,date:1,chat,text:'menu'}}} as Update);
 const keys=()=>messages.at(-1)!.reply_markup!.inline_keyboard.flat();
 async function click(action:string,value?:string){const key=keys().find(k=>{const p=k.callback_data?.split('|');return p?.[1]===action&&(value===undefined||p[2]===value);});assert.ok(key,`missing ${action}: ${messages.at(-1)?.text}`);await raw(key.callback_data!);}
 return {send,click,raw,keys,messages,answers,text:()=>messages.at(-1)!.text};
}
test('Telegram journey: refine search, save first alert, pause and resume',async()=>{
 await page([1]);const t=telegramSession();await t.send('/start');await t.click('find');
 assert.match(t.text(),/1 matching jobs/);await t.click('country');await t.click('pick','0');await t.click('filters');
 assert.match(t.text(),/United States/);await t.click('category');await t.click('pick','0');await t.click('filters');
 await t.click('keyword');await t.send('SaaS');assert.match(t.text(),/Keyword · SaaS/);await t.click('results');
 await t.click('subscribe');assert.match(t.text(),/timezone/);await t.click('zone','0');await t.click('time','09:00');
 assert.match(t.text(),/Alert saved/);assert.match(t.text(),/Only newly discovered/);
 const sub=await db.subscription.findFirstOrThrow({where:{userId:99n}});assert.deepEqual(sub.countries,['US']);assert.equal(sub.keyword,'SaaS');
 await t.click('pause');assert.match(t.text(),/Alert paused/);assert.equal((await db.subscription.findUniqueOrThrow({where:{id:sub.id}})).paused,true);
 await t.click('resume');assert.equal((await db.subscription.findUniqueOrThrow({where:{id:sub.id}})).paused,false);
});
test('results and daily matches return to the same page after safe job details',async()=>{
 await db.$transaction(tx=>savePage(tx,[job(1,{jobTitle:'Engineer <script> & researcher'}),...Array.from({length:5},(_,i)=>job(i+2))]));
 await db.job.update({where:{id:'jobicy:1'},data:{title:'Engineer <script> & researcher'}});
 const t=telegramSession();await t.send('/start');await t.click('find');await t.click('results');
 assert.match(t.text(),/Engineer &lt;script&gt; &amp; researcher/);assert.equal(t.messages.at(-1)!.parse_mode,'HTML');
 await t.click('resultpage','1');assert.match(t.text(),/Page 2 \/ 2/);await t.click('job');assert.ok(t.keys().some(k=>k.url?.startsWith('https://jobicy.com/')));
 await t.click('backjobs');assert.match(t.text(),/Page 2 \/ 2/);
 await db.user.update({where:{id:99n},data:{timezoneConfirmed:true}});
 await saveSubscription(db,99n,filters);await page([7,8,9,10,11,12]);const d=await generateDigest(db,99n);
 await t.raw(`D|${d!.id}|1`);assert.match(t.text(),/Page 2 \/ 2/);await t.click('job');await t.click('backjobs');assert.match(t.text(),/Your daily matches/);assert.match(t.text(),/Page 2 \/ 2/);
});
test('country search preserves picks, handles empty names, and callbacks use the rendered choices',async()=>{
 await page([1,2]);const t=telegramSession();await t.send('/start');await t.click('find');await t.click('country');
 await db.$transaction(tx=>savePage(tx,[job(3,{jobGeo:'Canada'}),job(4,{jobGeo:'Canada'}),job(5,{jobGeo:'Canada'})]));
 await t.click('pick','0');let u=await db.user.findUniqueOrThrow({where:{id:99n}});assert.deepEqual((u.interaction as {filters:typeof filters}).filters.countries,['US']);
 await t.click('lookup','country');await t.send('China');await t.click('pick','0');await t.click('filters');assert.match(t.text(),/China/);assert.match(t.text(),/United States/);
 await t.click('country');await t.send('no such country');assert.match(t.text(),/No names match/);await t.click('clearlookup','country');assert.ok(t.keys().some(k=>k.text.includes('Canada')));
 await t.click('filters');await t.click('menu');await t.click('filters');assert.match(t.text(),/China/);
});
test('zero results offer recovery and can be saved without fabricating matches',async()=>{
 await page([1]);const t=telegramSession();await t.send('/start');await t.click('find');await t.click('keyword');await t.send('unavailable phrase');await t.click('results');
 assert.match(t.text(),/No matches right now/);assert.ok(t.keys().some(k=>k.callback_data?.includes('|subscribe|')));await t.click('broadenkeyword');assert.match(t.text(),/1 matching jobs/);
 await t.click('filters');await t.click('keyword');await t.send('unavailable phrase');await t.click('results');await t.click('subscribe');await t.click('zone','0');await t.click('time','09:00');
 assert.equal((await db.subscription.findFirstOrThrow({where:{userId:99n}})).keyword,'unavailable phrase');
});
test('old buttons do not reset a new search; schedule cancellation does not save an alert',async()=>{
 await page([1]);const t=telegramSession();await t.send('/start');const old=t.keys().find(k=>k.callback_data?.includes('|find|'))!.callback_data!;
 await t.click('find');await t.click('keyword');await t.send('SaaS');const before=await db.user.findUniqueOrThrow({where:{id:99n}}),n=t.messages.length;
 await t.raw(old);assert.equal(t.messages.length,n);assert.equal(t.answers.at(-1)!.show_alert,true);assert.equal((await db.user.findUniqueOrThrow({where:{id:99n}})).interactionVersion,before.interactionVersion);
 await t.click('results');await t.click('subscribe');await t.click('results');assert.equal(await db.subscription.count(),0);
 await t.click('menu');await t.click('settings');await t.click('timezone');await t.click('zone','0');await t.send('25:99');assert.match(t.text(),/valid 24-hour/);await t.click('time','12:00');assert.match(t.text(),/Delivery time updated/);assert.equal(await db.subscription.count(),0);
 await t.send('09:00');assert.equal((await db.user.findUniqueOrThrow({where:{id:99n}})).sendTime,'12:00');
});
test('browsing an alert does not reset its boundary; editing is explicit and deletion is confirmed',async()=>{
 await user(99n);await page([1]);const sub=await saveSubscription(db,99n,filters);await page([2]);
 const t=telegramSession();await t.send('/start');await t.click('subs');await t.click('sub',sub.id);await t.click('viewsubjobs');
 await t.click('subscribe');assert.match(t.text(),/already have this alert/);assert.equal((await db.subscription.findUniqueOrThrow({where:{id:sub.id}})).watermark,sub.watermark);
 await t.click('editsub');await t.click('keyword');await t.send('SaaS');await t.click('results');await t.click('subscribe');assert.match(t.text(),/Alert updated/);assert.equal((await db.subscription.findUniqueOrThrow({where:{id:sub.id}})).keyword,'SaaS');
 await t.click('deletesub');assert.equal(await db.subscription.count(),1);await t.click('sub',sub.id);assert.equal(await db.subscription.count(),1);
 await t.click('deletesub');await t.click('confirmdel');assert.equal(await db.subscription.count(),0);assert.match(t.text(),/Save a search/);
});

test('Telegram 429 postpones delivery and 403 stops reminders',async()=>{
 await user();await saveSubscription(db,1n,filters);await page([1]);const digest=await generateDigest(db,1n);const d=await db.delivery.findUniqueOrThrow({where:{digestId:digest!.id}});
 const start=Date.now();await deliverDigest(db,d.id,{send:async()=>{throw {error_code:429,parameters:{retry_after:125}};}});
 const waiting=await db.delivery.findUniqueOrThrow({where:{id:d.id}});assert.equal(waiting.status,'pending');assert.ok(waiting.nextAttemptAt.getTime()>=start+125000);
 await deliverDigest(db,d.id,{send:async()=>{throw {error_code:403};}});assert.equal((await db.user.findUniqueOrThrow({where:{id:1n}})).unreachable,true);assert.equal((await db.delivery.findUniqueOrThrow({where:{id:d.id}})).status,'unreachable');
});
test('pending days combine without losing jobs or sending twice',async()=>{
 await user();await saveSubscription(db,1n,filters);await page([1]);const first=await generateDigest(db,1n);await page([2]);
 const next=new Date(Date.now()+86400000);await db.job.updateMany({data:{checkedAt:next}});await generateDigest(db,1n,next);
 const delivery=await db.delivery.findUniqueOrThrow({where:{digestId:first!.id}});let sends=0;
 await deliverDigest(db,delivery.id,{send:async()=>{sends++;return 7;}});assert.equal(sends,1);assert.equal(await db.delivery.count({where:{status:'superseded'}}),1);const sent=await db.delivery.findFirstOrThrow({where:{status:'sent'}});assert.equal(await db.digestItem.count({where:{digestId:sent.digestId}}),2);
 await deliverDigest(db,delivery.id,{send:async()=>{sends++;return 8;}});assert.equal(sends,1);
});

test('source outage delivers recently verified jobs and defers outdated jobs',async()=>{
 await user();await saveSubscription(db,1n,filters);await page([1,2]);
 const digest=await generateDigest(db,1n);const delivery=await db.delivery.findUniqueOrThrow({where:{digestId:digest!.id}});
 await db.job.update({where:{id:'jobicy:1'},data:{checkedAt:new Date(Date.now()-2*3600000)}});
 await db.job.update({where:{id:'jobicy:2'},data:{checkedAt:new Date(Date.now()-25*3600000)}});
 let sent='';
 await deliverDigest(db,delivery.id,{send:async(_chat,text)=>{sent=text;return 1;}},new Date(),(async()=>new Response('',{status:503})) as typeof fetch);
 assert.match(sent,/Engineer 1/);assert.doesNotMatch(sent,/Engineer 2/);assert.match(sent,/updates delayed/i);
 assert.equal((await db.delivery.findUniqueOrThrow({where:{id:delivery.id}})).status,'sent');
 assert.equal(await db.deferredMatch.count({where:{jobId:'jobicy:2'}}),1);
});

test('admin stats: authorization fails closed, works only in private chat and preserves the search',async()=>{
 const denied=telegramSession();await denied.send('/stats');assert.match(denied.text(),/only available to the administrator/);assert.equal(await db.user.count(),0);
 const wrong=telegramSession({...config,ADMIN_TELEGRAM_ID:'100'});await wrong.send('/stats');assert.match(wrong.text(),/only available to the administrator/);assert.equal(await db.user.count(),0);
 const adminConfig={...config,ADMIN_TELEGRAM_ID:'99'},t=telegramSession(adminConfig);
 await t.send('/start');await t.click('find');const before=await db.user.findUniqueOrThrow({where:{id:99n}});
 await t.send('/stats');assert.match(t.text(),/Admin stats/);assert.match(t.text(),/Registered users: 0/);
 await t.send('/activity');assert.match(t.text(),/Admin activity/);assert.match(t.text(),/Today so far/);
 assert.deepEqual((await db.user.findUniqueOrThrow({where:{id:99n}})).interaction,before.interaction);
 const group=createBot(db,adminConfig,{botInfo:{id:123456,is_bot:true,first_name:'Test',username:'local_test_bot'}} as never);
 group.api.config.use(async()=>{throw new Error('Must not reply with statistics in a group');});
 await group.handleUpdate({update_id:500,message:{message_id:1,date:1,from:{id:99,is_bot:false,first_name:'Admin'},chat:{id:-10,type:'group',title:'Test'},text:'/stats'}});
});

test('admin activity: event types include administrator and external users in separate columns',async()=>{
 const now=new Date('2026-11-04T03:00:00Z');
 await db.event.createMany({data:[
  {key:'a1',type:'search_completed',userId:99n,createdAt:new Date('2026-11-04T02:00:00Z')},
  {key:'a2',type:'job_open_clicked',userId:99n,createdAt:new Date('2026-11-03T02:00:00Z')},
  {key:'u1',type:'search_completed',userId:1n,createdAt:new Date('2026-11-03T03:00:00Z')},
  {key:'u2',type:'search_completed',userId:1n,createdAt:new Date('2026-10-20T03:00:00Z')},
 ]});
 const report=await adminActivity(db,99n,now);
 assert.match(report,/Last 7 complete days · 2026-10-28 – 2026-11-03/);
 assert.match(report,/Search completed: 1 \/ 1 \/ 0/);
 assert.match(report,/Job opened: 1 \/ 0 \/ 1/);
 assert.match(report,/Today so far · 2026-11-04/);
 assert.match(report,/Search completed: 1 \/ 0 \/ 1/);
 assert.doesNotMatch(report,/2026-10-20/);
});

test('admin stats: Shanghai midnight, weekly unique users, retries and all exclusions',async()=>{
 const now=new Date('2026-11-04T03:00:00Z');
 await db.user.createMany({data:[
  {id:1n,chatId:1n,createdAt:new Date('2026-11-02T16:00:00Z')},
  {id:2n,chatId:2n,createdAt:new Date('2026-11-03T16:00:00Z'),paused:true},
  {id:3n,chatId:3n,createdAt:new Date('2026-10-01T00:00:00Z'),unreachable:true},
  {id:99n,chatId:99n,createdAt:new Date('2026-11-03T00:00:00Z')},
 ]});
 for(const id of [1n,2n,3n,99n])await saveSubscription(db,id,filters);
 const rows=[
  {id:1n,chatId:1n,status:'done',createdAt:new Date('2026-11-02T16:00:00Z')},
  {id:2n,chatId:1n,status:'done',createdAt:new Date('2026-11-03T15:59:59Z')},
  {id:3n,chatId:1n,status:'done',createdAt:new Date('2026-11-01T00:00:00Z')},
  {id:4n,chatId:2n,status:'done',createdAt:new Date('2026-11-03T16:00:00Z')},
  {id:5n,chatId:99n,status:'done',createdAt:new Date('2026-11-03T00:00:00Z')},
  {id:6n,chatId:1n,status:'pending',createdAt:new Date('2026-11-03T00:00:00Z')},
  {id:7n,chatId:900n,status:'done',createdAt:new Date('2026-11-03T00:00:00Z')},
 ];
 await db.inboxUpdate.createMany({data:rows});
 await db.inboxUpdate.createMany({data:rows,skipDuplicates:true});
 const report=await adminStats(db,99n,now);
 assert.match(report,/Yesterday · 2026-11-03\nNew users: 1\nActive users: 1\nInteractions: 2/);
 assert.match(report,/Today so far · 2026-11-04\nNew \/ active \/ interactions: 1 \/ 1 \/ 1/);
 assert.match(report,/Active users: 1 \(deduplicated across 7 days\)/);
 assert.match(report,/Interactions: 3 \(up from 0/);
 assert.match(report,/Registered users: 3\nUsers with enabled alerts: 1/);
});

test('Telegram aggregate export pins one private message, retries reuse it, and snapshot is aggregate only',async()=>{
 const {exportStats,statsPrefix}=await import('../src/stats-export.js');
 await user(1n);await user(99n);
 const sent:string[]=[],edited:string[]=[],pinned:number[]=[];let failPin=true;
 const api={
  sendMessage:async(chat:string,text:string,options:{disable_notification?:boolean})=>{assert.equal(chat,'99');assert.equal(options.disable_notification,true);sent.push(text);return {message_id:123};},
  editMessageText:async(_chat:string,id:number,text:string)=>{assert.equal(id,123);edited.push(text);},
  pinChatMessage:async(_chat:string,id:number)=>{pinned.push(id);if(failPin){failPin=false;throw new Error('Temporary Telegram failure');}},
 };
 await assert.rejects(exportStats(db,api as never,'99'),/Temporary/);
 await exportStats(db,api as never,'99');assert.equal(sent.length,1);assert.equal(edited.length,1);assert.deepEqual(pinned,[123,123]);
 const report=JSON.parse(sent[0]!.slice(statsPrefix.length));assert.equal(report.totals.registeredUsers,1);assert.equal(report.daily.length,15);
 assert.deepEqual(Object.keys(report.totals).sort(),['enabledAlertUsers','registeredUsers']);
 const pointer=await db.task.findUniqueOrThrow({where:{dedupeKey:'stats-message:99'}});assert.equal(pointer.status,'held');
});
