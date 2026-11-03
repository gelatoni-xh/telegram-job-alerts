import { Bot, InlineKeyboard, GrammyError, type Context } from 'grammy';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { countryOptions, snippet, type Filters } from './rules.js';
import { categories,searchJobs } from './jobs.js';
import { saveSubscription,setPaused,pauseAll,setSchedule } from './subscriptions.js';
import { deleteUser } from './privacy.js';
import type { Match } from './digests.js';
import type { User, Prisma } from '@prisma/client';
type State={step?:string;filters?:Filters;editId?:string;query?:string;choices?:string[];pendingSubscribe?:boolean;zone?:string;page?:number};
const empty=():Filters=>({countries:[],categories:[],keyword:''});
const state=(u:User)=>(u.interaction??{}) as State;
const cb=(u:User,action:string,arg='')=>`${u.interactionVersion}|${action}|${arg}`;
const button=(kb:InlineKeyboard,u:User,label:string,action:string,arg='')=>kb.text(label,cb(u,action,arg));
async function view(ctx:Context,text:string,kb:InlineKeyboard) {
 if(ctx.callbackQuery?.message){try{await ctx.editMessageText(text.slice(0,4050),{reply_markup:kb,link_preview_options:{is_disabled:true}});return;}catch(e){if(e instanceof GrammyError&&e.error_code===400&&e.description.includes('not modified'))return;if(!(e instanceof GrammyError&&e.error_code===400))throw e;}}
 await ctx.reply(text.slice(0,4050),{reply_markup:kb,link_preview_options:{is_disabled:true}});
}
async function put(db:Db,u:User,s:State){return db.user.update({where:{id:u.id},data:{interaction:s as Prisma.InputJsonValue,interactionVersion:{increment:1}}});}
export function createBot(db:Db,config:Config,botInfo?:ConstructorParameters<typeof Bot>[1]) {
 const bot=new Bot(config.BOT_TOKEN,botInfo);
 let apiTail:Promise<unknown>=Promise.resolve(), lastSend=0;
 bot.api.config.use(async (prev,method,payload,signal)=>{
  if(!['sendMessage','editMessageText'].includes(method))return prev(method,payload,signal);
  const call=apiTail.catch(()=>{}).then(async()=>{const ms=Math.max(0,1000-(Date.now()-lastSend));if(ms)await new Promise(r=>setTimeout(r,ms));lastSend=Date.now();return prev(method,payload,signal);});apiTail=call;return call;
 });
 async function user(ctx:Context){if(!ctx.from||!ctx.chat||ctx.chat.type!=='private'||ctx.from.is_bot)return null;return db.user.upsert({where:{id:BigInt(ctx.from.id)},create:{id:BigInt(ctx.from.id),chatId:BigInt(ctx.chat.id)},update:{chatId:BigInt(ctx.chat.id),unreachable:false}});}
 async function event(ctx:Context,u:User,type:string,dimensions:Prisma.InputJsonValue={}) {const key=`${ctx.update.update_id}:${type}`;await db.event.upsert({where:{key},create:{key,type,userId:u.id,dimensions},update:{}});}
 async function menu(ctx:Context,u:User){const kb=new InlineKeyboard();button(kb,u,'Find jobs','find').row();button(kb,u,'My subscriptions','subs').row();button(kb,u,'Settings','settings').row();button(kb,u,'Data status','status');await view(ctx,'Find remote jobs and get one daily digest of new matches.\n\nCurrent source: Jobicy. Coverage follows this source; country matching is not a work-rights or visa check.\n\nFree to use. No job listings are our own postings.',kb);}
 async function selection(ctx:Context,u:User,kind:'country'|'category',page=0,query=''){
  const s=state(u),f=s.filters??empty();
  const actual=kind==='country'?countryOptions.map(c=>({key:c.code,name:c.name})):await categoryOptions();
  const options=actual.filter(c=>`${c.key} ${c.name}`.toLowerCase().includes(query.toLowerCase()));
  const p=Math.max(0,Math.min(page,Math.max(0,Math.ceil(options.length/8)-1))),shown=options.slice(p*8,p*8+8);
  u=await put(db,u,{...s,step:kind,query,page:p,choices:shown.map(v=>v.key)});
  const selected=kind==='country'?f.countries:f.categories,kb=new InlineKeyboard();
  button(kb,u,`${selected.length?'':'✓ '}Any ${kind==='country'?'country':'occupation'}`,'any',kind).row();
  shown.forEach((v,i)=>{button(kb,u,`${selected.includes(v.key)?'✓ ':''}${v.name}`,'pick',String(i)).row();});
  if(p>0)button(kb,u,'Previous','selectpage',String(p-1));if((p+1)*8<options.length)button(kb,u,'Next','selectpage',String(p+1));kb.row();
  button(kb,u,'Search names','lookup',kind).row();button(kb,u,'Continue',kind==='country'?'category':'keyword').row();button(kb,u,'Main menu','menu');
  await view(ctx,`Choose ${kind==='country'?'countries':'occupations'} (multiple allowed).\nSelected: ${selected.join(', ')||'Any'}\n${options.length} options${query?` for “${query}”`:''}. Page ${p+1}.`,kb);
 }
 async function categoryOptions(){const rows=await db.$queryRaw<{name:string}[]>`SELECT DISTINCT unnest(categories) AS name FROM "Job"`;return [...new Set([...categories,...rows.map(r=>r.name)])].sort().map(name=>({key:name,name}));}
 async function keyword(ctx:Context,u:User){u=await put(db,u,{...state(u),step:'keyword'});const kb=new InlineKeyboard();button(kb,u,'Skip keyword','skip').row();button(kb,u,'Back to occupations','category');await view(ctx,'Send an optional keyword or phrase (title or description). Matching is literal and ignores case. Or skip it.',kb);}
 async function results(ctx:Context,u:User,page=0){const s=state(u),f=s.filters??empty();let {jobs,count}=await searchJobs(db,f,Math.max(0,page)*5);if(page>0&&page*5>=count){page=Math.max(0,Math.ceil(count/5)-1);({jobs,count}=await searchJobs(db,f,page*5));}u=await put(db,u,{...s,step:'results',page});
  const latest=await db.syncRun.findFirst({where:{status:'complete'},orderBy:{finishedAt:'desc'}});
  const delayed=!latest?.finishedAt||Date.now()-latest.finishedAt.getTime()>2*3600_000;
  const text=`${count?`${count} matching jobs`:'No jobs found in our current listings'}\nCountries: ${f.countries.join(', ')||'Any'}\nOccupations: ${f.categories.join(', ')||'Any'}\nKeyword: ${f.keyword||'None'}\n\n${jobs.map((j,i)=>`${page*5+i+1}. ${j.title.slice(0,120)} — ${j.company.slice(0,70)}\n${j.geo||'Location unspecified'} · ${j.publishedAt?.toISOString().slice(0,10)??'Discovered '+j.firstSeenAt.toISOString().slice(0,10)}\n${j.salary??'Salary not specified'}\n${snippet(j.description,f.keyword,120)}`).join('\n\n')}\n\nSource: Jobicy. Last complete sync: ${latest?.finishedAt?.toISOString()??'not available'}${delayed?' — updates delayed':''}.\nLocation matching does not confirm visa or work rights.`;
  const kb=new InlineKeyboard();jobs.forEach((j,i)=>{button(kb,u,`Open ${page*5+i+1}`,'job',j.id).row();});if(page>0)button(kb,u,'Previous','resultpage',String(page-1));if((page+1)*5<count)button(kb,u,'Next','resultpage',String(page+1));kb.row();button(kb,u,s.editId?'Save changes':'Subscribe','subscribe').row();button(kb,u,'Edit filters','country').row();button(kb,u,'Main menu','menu');await view(ctx,text,kb);await event(ctx,u,'search_completed',{countries:f.countries,categories:f.categories,hasKeyword:Boolean(f.keyword),count});}
 async function subscriptions(ctx:Context,u:User){u=await put(db,u,{step:'subscriptions'});const subs=await db.subscription.findMany({where:{userId:u.id},orderBy:{createdAt:'asc'}});const kb=new InlineKeyboard();subs.slice(0,40).forEach((s,i)=>{button(kb,u,`${i+1}. ${s.paused?'Paused':'Active'}: ${s.name.slice(0,42)}`,'sub',s.id).row();});if(subs.length>40)button(kb,u,'Next subscriptions','subpage','1').row();button(kb,u,'Find jobs','find').row();button(kb,u,'Main menu','menu');await view(ctx,`Your subscriptions: ${subs.length}\n${u.paused?'All reminders are paused.\n':''}Daily time: ${u.sendTime} (${u.timezone})`,kb);}
 async function subscription(ctx:Context,u:User,id:string){const sub=await db.subscription.findFirst({where:{id,userId:u.id}});if(!sub)return subscriptions(ctx,u);const kb=new InlineKeyboard();button(kb,u,'Edit / view current jobs','editsub',sub.id).row();button(kb,u,sub.paused?'Resume':'Pause',sub.paused?'resume':'pause',sub.id).row();button(kb,u,'Delete','deletesub',sub.id).row();button(kb,u,'All subscriptions','subs');await view(ctx,`${sub.name}\n\nStatus: ${sub.paused?'Paused':'Active'}${u.paused?' (all reminders paused)':''}\nNew matches only, daily at ${u.sendTime} (${u.timezone}).`,kb);}
 async function settings(ctx:Context,u:User){const kb=new InlineKeyboard();button(kb,u,'Set timezone / time','timezone').row();button(kb,u,u.paused?'Resume all reminders':'Pause all reminders',u.paused?'resumeall':'pauseall').row();button(kb,u,'Delete my personal data','deleteuser').row();button(kb,u,'Main menu','menu');await view(ctx,`Daily time: ${u.sendTime}\nTimezone: ${u.timezone}${u.timezoneConfirmed?'':' (not yet confirmed)'}\nNext scheduled check: ${u.nextDue?.toISOString()??'not set'}\n\nInteraction payloads: 7 days; activity and digests: 90 days; backups: normally 14 days. Deleting personal data also cancels reminders. Backup retention may extend during a backup failure. Deletion records prevent resurrection on restore.`,kb);}
 async function zones(ctx:Context,u:User,page=0,query=''){const all=Intl.supportedValuesOf('timeZone');if(!all.includes('UTC'))all.unshift('UTC');const filtered=all.filter(v=>v.replaceAll('_',' ').toLowerCase().includes(query.replaceAll('_',' ').toLowerCase()));const p=Math.max(0,Math.min(page,Math.max(0,Math.ceil(filtered.length/8)-1)));const shown=filtered.slice(p*8,p*8+8);u=await put(db,u,{...state(u),step:'timezone',query,page:p,choices:shown});const kb=new InlineKeyboard();shown.forEach((v,i)=>{button(kb,u,v,'zone',String(i)).row();});if(p>0)button(kb,u,'Previous','zonepage',String(p-1));if((p+1)*8<filtered.length)button(kb,u,'Next','zonepage',String(p+1));kb.row();button(kb,u,'Search city / timezone','lookup','timezone').row();button(kb,u,'Main menu','menu');await view(ctx,`Choose your timezone. Daylight saving changes follow local time.\n${filtered.length} options${query?` for “${query}”`:''}.`,kb);}
 async function times(ctx:Context,u:User,zone:string){u=await put(db,u,{...state(u),step:'time',zone});const kb=new InlineKeyboard();for(const v of ['08:00','09:00','12:00','18:00'])button(kb,u,v,'time',v).row();button(kb,u,'Main menu','menu');await view(ctx,`Timezone: ${zone}\nChoose your daily local time, or send HH:MM (24-hour clock).`,kb);}
 async function finishTime(ctx:Context,u:User,time:string){const s=state(u);await setSchedule(db,u.id,s.zone??u.timezone,time);u=await db.user.findUniqueOrThrow({where:{id:u.id}});if(s.pendingSubscribe){const sub=await saveSubscription(db,u.id,s.filters??empty(),s.editId);await event(ctx,u,s.editId?'subscription_edited':'subscription_created',{subscriptionId:sub.id});u=await put(db,u,{step:'subscriptions'});await subscription(ctx,u,sub.id);}else await settings(ctx,u);}
 async function digestPage(ctx:Context,u:User,id:string,page=0){const d=await db.digest.findFirst({where:{id,userId:u.id}});if(!d){await ctx.reply('This digest is no longer available.');return;}const total=await db.digestItem.count({where:{digestId:id}});page=Math.min(Math.max(0,page),Math.max(0,Math.ceil(total/5)-1));const items=await db.digestItem.findMany({where:{digestId:id},orderBy:{position:'asc'},skip:page*5,take:5,include:{job:true}});const kb=new InlineKeyboard();items.forEach((item,i)=>kb.text(`Open ${page*5+i+1}`,cb(u,'job',item.jobId)).row());if(page>0)kb.text('Previous',`D|${id}|${page-1}`);if((page+1)*5<total)kb.text('Next',`D|${id}|${page+1}`);kb.row();button(kb,u,'Main menu','menu');await view(ctx,`Digest ${d.localDate} · ${total} jobs · Page ${page+1}\n\n${items.map((i,n)=>`${page*5+n+1}. ${i.job.title.slice(0,130)} — ${i.job.company.slice(0,60)}\n${i.job.geo}\n${i.job.salary??'Salary not specified'}\nStatus: ${i.job.status}${Date.now()-i.job.checkedAt.getTime()>24*3600_000?' (last check is outdated)':''}\nMatched: ${(i.matches as Match[]).map(m=>m.name).join('; ').slice(0,180)}`).join('\n\n')}\n\nSource: Jobicy. Membership and order are fixed.`,kb);await event(ctx,u,'result_page_viewed',{digestId:id,page});}
 bot.on('message:text',async ctx=>{
  const foundUser=await user(ctx);if(!foundUser)return;let u:User=foundUser;const text=ctx.message.text.trim(),s=state(u);
  if(text.startsWith('/start')||text==='/menu'||text==='/cancel'){u=await put(db,u,{});await event(ctx,u,'start');return menu(ctx,u);}
  if(text==='/privacy')return settings(ctx,u);
  if(s.step==='lookup'){
   if(s.zone==='timezone')return zones(ctx,u,0,text.slice(0,80));
   return selection(ctx,u,s.zone==='category'?'category':'country',0,text.slice(0,80));
  }
  if(s.step==='keyword'){if(text.length>200)return ctx.reply('Please use a phrase of up to 200 characters.');u=await put(db,u,{...s,filters:{...(s.filters??empty()),keyword:text},step:'results'});return results(ctx,u);}
  if(s.step==='time'){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(text))return ctx.reply('Use HH:MM, for example 09:00.');return finishTime(ctx,u,text);}
  return menu(ctx,u);
 });
 bot.on('callback_query:data',async ctx=>{
  const foundUser=await user(ctx);if(!foundUser)return;let u:User=foundUser;
  try{await ctx.answerCallbackQuery();}catch(e){if(!(e instanceof GrammyError&&e.error_code===400))throw e;}
  const [version,action,arg='']=ctx.callbackQuery.data.split('|');
  if(version==='D')return digestPage(ctx,u,action!,Number(arg)||0);
  if(Number(version)!==u.interactionVersion){await ctx.reply('This menu has changed. Here is the current menu.');return menu(ctx,u);}
  const s=state(u),f=s.filters??empty();
  switch(action){
   case 'menu':u=await put(db,u,{});return menu(ctx,u);
   case 'find':u=await put(db,u,{filters:empty()});return selection(ctx,u,'country');
   case 'country':return selection(ctx,u,'country');
   case 'category':return selection(ctx,u,'category');
   case 'keyword':return keyword(ctx,u);
   case 'skip':u=await put(db,u,{...s,filters:{...f,keyword:''}});return results(ctx,u);
   case 'lookup':u=await put(db,u,{...s,step:'lookup',zone:arg});return view(ctx,`Send a ${arg==='timezone'?'city or timezone':'name'} to search.`,button(new InlineKeyboard(),u,'Main menu','menu'));
   case 'selectpage':return selection(ctx,u,s.step==='category'?'category':'country',Number(arg),s.query);
   case 'pick':{const choice=s.choices?.[Number(arg)];if(!choice)return;const key=s.step==='category'?'categories':'countries';const selected=f[key].includes(choice)?f[key].filter(v=>v!==choice):[...f[key],choice];u=await put(db,u,{...s,filters:{...f,[key]:selected}});return selection(ctx,u,s.step==='category'?'category':'country',s.page,s.query);}
   case 'any':u=await put(db,u,{...s,filters:{...f,[arg==='country'?'countries':'categories']:[]}});return selection(ctx,u,arg==='country'?'country':'category',s.page,s.query);
   case 'resultpage':return results(ctx,u,Number(arg));
   case 'subscribe':{if(!u.timezoneConfirmed){u=await put(db,u,{...s,pendingSubscribe:true});return zones(ctx,u);}const sub=await saveSubscription(db,u.id,f,s.editId);await event(ctx,u,s.editId?'subscription_edited':'subscription_created',{subscriptionId:sub.id});u=await put(db,u,{step:'subscriptions'});return subscription(ctx,u,sub.id);}
   case 'subs':return subscriptions(ctx,u);
   case 'subpage':{const page=Math.max(0,Number(arg)||0),subs=await db.subscription.findMany({where:{userId:u.id},orderBy:{createdAt:'asc'},skip:page*40,take:41});const kb=new InlineKeyboard();subs.slice(0,40).forEach(sub=>button(kb,u,sub.name.slice(0,45),'sub',sub.id).row());if(page>0)button(kb,u,'Previous','subpage',String(page-1));if(subs.length>40)button(kb,u,'Next','subpage',String(page+1));kb.row();button(kb,u,'Main menu','menu');return view(ctx,`Subscriptions · Page ${page+1}`,kb);}
   case 'sub':return subscription(ctx,u,arg);
   case 'editsub':{const sub=await db.subscription.findFirst({where:{id:arg,userId:u.id}});if(!sub)return subscriptions(ctx,u);u=await put(db,u,{filters:{countries:sub.countries,categories:sub.categories,keyword:sub.keyword},editId:sub.id});return results(ctx,u);}
   case 'pause':case 'resume':await setPaused(db,u.id,arg,action==='pause');await event(ctx,u,action==='pause'?'subscription_paused':'subscription_resumed');return subscription(ctx,u,arg);
   case 'deletesub':{const sub=await db.subscription.findFirst({where:{id:arg,userId:u.id}});if(!sub)return subscriptions(ctx,u);const kb=new InlineKeyboard();button(kb,u,'Confirm delete','confirmdel',arg).row();button(kb,u,'Cancel','sub',arg);return view(ctx,`Delete this subscription?\n${sub.name}`,kb);}
   case 'confirmdel':await db.$transaction(async tx=>{const sub=await tx.subscription.findFirst({where:{id:arg,userId:u.id}});if(sub){await tx.deferredMatch.deleteMany({where:{subscriptionId:arg}});await tx.subscription.delete({where:{id:arg}});}});await event(ctx,u,'subscription_deleted');return subscriptions(ctx,u);
   case 'settings':return settings(ctx,u);
   case 'timezone':u=await put(db,u,{...s,pendingSubscribe:false});return zones(ctx,u);
   case 'zonepage':return zones(ctx,u,Number(arg),s.query);
   case 'zone':{const zone=s.choices?.[Number(arg)];if(!zone)return;return times(ctx,u,zone);}
   case 'time':return finishTime(ctx,u,arg);
   case 'pauseall':case 'resumeall':await pauseAll(db,u.id,action==='pauseall');u=await db.user.findUniqueOrThrow({where:{id:u.id}});return settings(ctx,u);
   case 'deleteuser':{const kb=new InlineKeyboard();button(kb,u,'Delete my data and reminders','confirmuser').row();button(kb,u,'Cancel','settings');return view(ctx,'Delete all subscriptions, settings and identifiable activity? This stops reminders. Backups normally expire after 14 days; backup failures can delay cleanup.',kb);}
   case 'confirmuser':await deleteUser(db,u.id,config.DELETION_JOURNAL_PATH);return ctx.reply('Your personal data and reminders have been deleted. You can use /start to begin again.');
   case 'status':{const latest=await db.syncRun.findFirst({where:{status:'complete'},orderBy:{finishedAt:'desc'}});const count=await db.job.count({where:{status:'active'}});return view(ctx,`Source: Jobicy\nActive stored listings: ${count}\nLast complete sync: ${latest?.finishedAt?.toISOString()??'not yet complete'}\n\nThe source feed covers recent listings with a delay. Older stored jobs are checked separately. No results does not mean there are no jobs in the market.`,button(new InlineKeyboard(),u,'Main menu','menu'));}
   case 'job':{const job=await db.job.findUnique({where:{id:arg}});if(!job)return ctx.reply('This listing is no longer available.');await event(ctx,u,'job_open_clicked',{jobId:job.id,source:job.source});const kb=new InlineKeyboard().url('View full listing / apply on Jobicy',job.url).row();button(kb,u,'Main menu','menu');return view(ctx,`${job.title}\n${job.company}\n${job.geo}\n${job.salary??'Salary not specified'}\nStatus: ${job.status}\nLast checked: ${job.checkedAt.toISOString()}\n\n${snippet(job.description,f.keyword,900)}\n\nSource: Jobicy. Location matching does not confirm visa or work rights. Open the original listing for all requirements.`,kb);}
  }
 });
 return bot;
}
