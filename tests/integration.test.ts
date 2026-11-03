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
test('complete Telegram flow: search, keyword skip, timezone, daily time, subscribe, pause',async()=>{
 await page([1]);const bot=createBot(db,config,{botInfo:{id:123456,is_bot:true,first_name:'Local test',username:'local_test_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,can_manage_bots:false,supports_join_request_queries:false}});
 let messages:{text:string;reply_markup?:{inline_keyboard:{text:string;callback_data?:string}[][]}}[]=[];
 bot.api.config.use(async(_prev,method,payload)=>{
  if(method==='answerCallbackQuery')return {ok:true,result:true} as never;
  const p=payload as {text?:string;reply_markup?:unknown};messages.push({text:p.text??'',reply_markup:p.reply_markup as never});
  return {ok:true,result:{message_id:1,date:1,chat:{id:99,type:'private'},text:p.text}} as never;
 });
 let id=1;const from={id:99,is_bot:false,first_name:'Tester'},chat={id:99,type:'private' as const,first_name:'Tester'};
 await bot.handleUpdate({update_id:id++,message:{message_id:1,date:1,from,chat,text:'/start'}});
 async function click(action:string,value?:string){const keys=messages.at(-1)!.reply_markup!.inline_keyboard.flat();const key=keys.find(k=>{const p=k.callback_data?.split('|');return p?.[1]===action&&(value===undefined||p[2]===value);});assert.ok(key,`missing ${action}: ${messages.at(-1)?.text}`);await bot.handleUpdate({update_id:id++,callback_query:{id:String(id),from,chat_instance:'test',data:key.callback_data,message:{message_id:1,date:1,chat,text:'menu'}}} as Update);}
 await click('find');await click('any','country');await click('category');await click('keyword');await click('skip');assert.match(messages.at(-1)!.text,/1 matching jobs/);await click('subscribe');assert.match(messages.at(-1)!.text,/timezone/i);await click('zone','0');await click('time','09:00');assert.equal(await db.subscription.count({where:{userId:99n}}),1);await click('pause');assert.equal((await db.subscription.findFirstOrThrow({where:{userId:99n}})).paused,true);
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
 assert.match(sent,/Engineer 1/);assert.doesNotMatch(sent,/Engineer 2/);assert.match(sent,/updates delayed/);
 assert.equal((await db.delivery.findUniqueOrThrow({where:{id:delivery.id}})).status,'sent');
 assert.equal(await db.deferredMatch.count({where:{jobId:'jobicy:2'}}),1);
});
