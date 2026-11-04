import { Bot, InlineKeyboard, GrammyError, type Context } from 'grammy';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { adminStats } from './stats.js';
import { adminActivity } from './activity.js';
import { snippet, type Filters } from './rules.js';
import { jobFilterOptions,searchJobs } from './jobs.js';
import { saveSubscription,setPaused,pauseAll,setSchedule } from './subscriptions.js';
import { deleteUser } from './privacy.js';
import type { Match } from './digests.js';
import type { User, Prisma } from '@prisma/client';
import { clip,countryName,filterSummary,localTime,updatedAt,jobCard,screenHtml,zoneLabel,suggestedZones } from './ui.js';
type ReturnTo={kind:'results'|'digest';page:number;id?:string};
type State={step?:string;filters?:Filters;editId?:string;query?:string;choices?:string[];pendingSubscribe?:boolean;zone?:string;page?:number;returnTo?:ReturnTo};
const empty=():Filters=>({countries:[],categories:[],keyword:''});
const state=(u:User)=>(u.interaction??{}) as State;
const cb=(u:User,action:string,arg='')=>`${u.interactionVersion}|${action}|${arg}`;
const button=(kb:InlineKeyboard,u:User,label:string,action:string,arg='')=>kb.text(label,cb(u,action,arg));
const homeButton=(kb:InlineKeyboard,u:User)=>button(kb,u,'⌂ Home','menu');
const pageSize=8;
async function view(ctx:Context,text:string,kb:InlineKeyboard) {
 const body=screenHtml(text),options={reply_markup:kb,parse_mode:'HTML' as const,link_preview_options:{is_disabled:true}};
 if(ctx.callbackQuery?.message){try{await ctx.editMessageText(body,options);return;}catch(e){if(e instanceof GrammyError&&e.error_code===400&&e.description.includes('not modified'))return;if(!(e instanceof GrammyError&&e.error_code===400))throw e;}}
 await ctx.reply(body,options);
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
 async function menu(ctx:Context,u:User){
  const [count,subs,latest]=await Promise.all([db.job.count({where:{status:'active'}}),db.subscription.count({where:{userId:u.id}}),db.syncRun.findFirst({where:{status:'complete'},orderBy:{finishedAt:'desc'}})]);
  const kb=new InlineKeyboard();button(kb,u,'🔎 Find remote jobs','find').primary().row();
  if(state(u).filters)button(kb,u,'Continue your search','filters').row();
  button(kb,u,`🔔 My alerts${subs?` · ${subs}`:''}`,'subs').row();button(kb,u,'Settings','settings');button(kb,u,'About & data','status');
  await view(ctx,`Remote Job Radar\n\nFind your next remote role. Save a search and get a daily alert when new matches arrive.\n\n${count.toLocaleString('en')} active jobs · Jobicy\n${updatedAt(latest?.finishedAt)}${u.paused?'\n\n⏸ All your alerts are paused. Resume them in Settings.':''}`,kb);
 }
 async function filters(ctx:Context,u:User){
  const s=state(u),f=s.filters??empty();const {count}=await searchJobs(db,f,0,0);
  u=await put(db,u,{...s,step:'filters',filters:f,pendingSubscribe:false});
  const kb=new InlineKeyboard();button(kb,u,`Show ${count.toLocaleString('en')} jobs →`,'results').primary().row();
  button(kb,u,`🌍 Location · ${clip(f.countries.map(countryName).join(', ')||'Any',35)}`,'country').row();
  button(kb,u,`💼 Occupation · ${clip(f.categories.join(', ')||'Any',35)}`,'category').row();
  button(kb,u,`✎ Keyword · ${clip(f.keyword||'None',35)}`,'keyword').row();
  if(f.countries.length||f.categories.length||f.keyword)button(kb,u,'Reset filters','resetfilters').row();
  if(s.editId)button(kb,u,'Cancel editing','sub',s.editId).row();homeButton(kb,u);
  await view(ctx,`${s.editId?'Edit alert':'Find remote jobs'}\n\n${filterSummary(f)}\n\n${count?`${count.toLocaleString('en')} matching jobs. Browse now or refine your search below.`:'No matches yet. Broaden a filter, or view results to save an alert for future jobs.'}\n\nLocation means where you live. Country matching does not verify visa or work rights.${s.editId?'\nChanges take effect only when you save.':''}`,kb);
 }
 async function selection(ctx:Context,u:User,kind:'country'|'category',page=0,query=''){
  const s=state(u),f=s.filters??empty();const actual=await jobFilterOptions(db,kind,f);
  const aliases:Record<string,string>={usa:'US',uk:'GB',uae:'AE'};
  const options=actual.filter(c=>`${c.key} ${c.name}`.toLowerCase().includes(query.toLowerCase())||(kind==='country'&&c.key===aliases[query.trim().toLowerCase()]));
  const p=Math.max(0,Math.min(page,Math.max(0,Math.ceil(options.length/pageSize)-1))),shown=options.slice(p*pageSize,p*pageSize+pageSize);
  u=await put(db,u,{...s,step:kind,query,page:p,choices:shown.map(v=>v.key)});
  const selected=kind==='country'?f.countries:f.categories,kb=new InlineKeyboard();
  button(kb,u,'✓ Done · Back to search','filters').primary().row();
  button(kb,u,`${selected.length?'○':'✓'} Any ${kind==='country'?'country':'occupation'}`,'any',kind);if(!selected.length)kb.success();kb.row();
  shown.forEach((v,i)=>{const checked=selected.includes(v.key);button(kb,u,`${checked?'✓':'○'} ${clip(v.name,48)} · ${v.count}`,'pick',String(i));if(checked)kb.success();kb.row();});
  if(p>0)button(kb,u,'‹ Previous','selectpage',String(p-1));if((p+1)*pageSize<options.length)button(kb,u,'Next ›','selectpage',String(p+1));kb.row();
  button(kb,u,`⌕ Search ${kind==='country'?'countries':'occupations'}`,'lookup',kind).row();if(query)button(kb,u,'Clear search · Show all','clearlookup',kind).row();
  const selectedNames=selected.map(key=>actual.find(o=>o.key===key)?.name??key);
  await view(ctx,`${kind==='country'?'🌍 Where do you live?':'💼 Choose occupations'}\n\n${kind==='country'?'Choose your country of residence. You can select more than one.':'Choose one or more occupations, or keep Any occupation.'}\n\nSelected · ${clip(selectedNames.join(', ')||'Any',500)}\n\n${options.length?`Most jobs first · Page ${p+1} / ${Math.max(1,Math.ceil(options.length/pageSize))}\nNumbers show active jobs matching your other filters.`:`No names match “${clip(query,80)}”. Try another name or clear the search.`}\n\nTap to select or unselect. Your choices are kept across pages.`,kb);
 }
 async function keyword(ctx:Context,u:User,error=''){
  u=await put(db,u,{...state(u),step:'keyword'});const f=state(u).filters??empty(),kb=new InlineKeyboard();
  if(f.keyword)button(kb,u,'Clear keyword','clearkeyword').row();
  button(kb,u,f.keyword?'Keep current keyword':'No keyword · Show all roles','filters').row();button(kb,u,'‹ Back to search','filters');
  await view(ctx,`✎ Add a keyword\n\n${error?`${error}\n\n`:''}Current · ${clip(f.keyword||'None',200)}\n\nSend a word or phrase, for example:\nProduct designer\nPython\nCustomer success\n\nWe look for that exact phrase in job titles and descriptions, ignoring case. Up to 200 characters.`,kb);
 }
 async function results(ctx:Context,u:User,page=0){
  const s=state(u),f=s.filters??empty();page=Math.max(0,page);let {jobs,count}=await searchJobs(db,f,page*5);
  if(page>0&&page*5>=count){page=Math.max(0,Math.ceil(count/5)-1);({jobs,count}=await searchJobs(db,f,page*5));}
  u=await put(db,u,{...s,step:'results',page,returnTo:{kind:'results',page}});
  const latest=await db.syncRun.findFirst({where:{status:'complete'},orderBy:{finishedAt:'desc'}});
  const delayed=!latest?.finishedAt||Date.now()-latest.finishedAt.getTime()>2*3600_000;
  const kb=new InlineKeyboard();
  jobs.forEach((j,i)=>button(kb,u,`${page*5+i+1}. ${clip(j.title,45)} →`,'job',j.id).row());
  if(page>0)button(kb,u,'‹ Previous','resultpage',String(page-1));if((page+1)*5<count)button(kb,u,'Next ›','resultpage',String(page+1));kb.row();
  button(kb,u,s.editId?'✓ Save alert changes':'🔔 Alert me to new matches','subscribe').primary().row();button(kb,u,'Adjust filters','filters');homeButton(kb,u);
  if(!count&&f.keyword)button(kb.row(),u,'Try without keyword','broadenkeyword');
  const content=count?`Page ${page+1} / ${Math.ceil(count/5)} · Newest first\n\n${jobs.map((j,i)=>jobCard(j,page*5+i+1,f.keyword)).join('\n\n')}`:
   'Try removing the keyword or choosing a broader occupation.\n\nYou can still save this search. We’ll alert you when a new matching job appears.';
  await view(ctx,`${count?`${count.toLocaleString('en')} matching jobs`:'No matches right now'}\n\n${filterSummary(f)}\n\n${content}\n\nJobicy · ${updatedAt(latest?.finishedAt)}${delayed?' · Updates delayed':''}`,kb);
  await event(ctx,u,'search_completed',{countries:f.countries,categories:f.categories,hasKeyword:Boolean(f.keyword),count});await event(ctx,u,'result_page_viewed',{scene:'search',page});if(!count)await event(ctx,u,'zero_results',{countries:f.countries,categories:f.categories,hasKeyword:Boolean(f.keyword)});
 }
 async function subscriptions(ctx:Context,u:User,page=0){
  const count=await db.subscription.count({where:{userId:u.id}});page=Math.min(Math.max(0,page),Math.max(0,Math.ceil(count/8)-1));
  const subs=await db.subscription.findMany({where:{userId:u.id},orderBy:{createdAt:'asc'},skip:page*8,take:8});
  u=await put(db,u,{...state(u),step:'subscriptions',pendingSubscribe:false});const kb=new InlineKeyboard();
  subs.forEach(sub=>button(kb,u,`${u.paused||sub.paused?'⏸':'🔔'} ${clip([sub.countries.map(countryName).join(', ')||'Any country',sub.categories.join(', ')||'Any occupation',sub.keyword].filter(Boolean).join(' · '),48)}`,'sub',sub.id).row());
  if(page>0)button(kb,u,'‹ Previous','subpage',String(page-1));if((page+1)*8<count)button(kb,u,'Next ›','subpage',String(page+1));kb.row();
  button(kb,u,'＋ Create an alert','find').primary().row();if(count)button(kb,u,'Delivery settings','settings').row();homeButton(kb,u);
  await view(ctx,`🔔 My alerts${count?` · ${count}`:''}\n\n${count?`${u.paused?'⏸ All alerts are paused.':'One daily digest combines new matches from your active alerts.'}\nDelivery · ${u.sendTime} (${zoneLabel(u.timezone)})\n\nTap an alert to view jobs, edit filters, or pause it.\nPage ${page+1} / ${Math.ceil(count/8)}`:'Save a search to start watching for new jobs.\n\nYou’ll get one daily digest only when there are new matches. It’s free, and you can pause or delete alerts at any time.'}`,kb);
 }
 async function subscription(ctx:Context,u:User,id:string,notice=''){
  const sub=await db.subscription.findFirst({where:{id,userId:u.id}});if(!sub)return subscriptions(ctx,u);
  u=await put(db,u,{...state(u),step:'subscription',pendingSubscribe:false,editId:undefined});const kb=new InlineKeyboard();
  button(kb,u,'Browse matching jobs','viewsubjobs',sub.id).primary().row();button(kb,u,'Edit filters','editsub',sub.id).row();
  button(kb,u,sub.paused?'▶ Resume this alert':'⏸ Pause this alert',sub.paused?'resume':'pause',sub.id).row();
  if(u.paused)button(kb,u,'Resume all in Settings','settings').row();
  button(kb,u,'Delete alert','deletesub',sub.id).row();button(kb,u,'‹ My alerts','subs');homeButton(kb,u);
  await view(ctx,`${notice||'🔔 Your alert'}\n\n${filterSummary(sub)}\n\n${sub.paused?'⏸ This alert is paused.':u.paused?'⏸ All alerts are paused in Settings.':'● Watching for new matches'}\nDelivery · ${u.sendTime} (${zoneLabel(u.timezone)})${!sub.paused&&!u.paused?`\nNext check · ${localTime(u.nextDue,u.timezone)}`:''}\n\nOnly newly discovered matches are included. Existing listings are available through Browse matching jobs. No new matches means no message.`,kb);
 }
 async function settings(ctx:Context,u:User,notice=''){
  u=await put(db,u,{...state(u),step:'settings',pendingSubscribe:false});
  const kb=new InlineKeyboard();button(kb,u,'Change delivery time','timezone').row();button(kb,u,u.paused?'▶ Resume all alerts':'⏸ Pause all alerts',u.paused?'resumeall':'pauseall').row();button(kb,u,'Privacy & my data','privacy').row();homeButton(kb,u);
  await view(ctx,`Settings\n\n${notice?`${notice}\n\n`:''}Daily delivery · ${u.sendTime}\nTimezone · ${zoneLabel(u.timezone)}${u.timezoneConfirmed?'':' (confirm when creating your first alert)'}\nAlerts · ${u.paused?'Paused':'Enabled'}\n\nOne digest per day, only when there are new matches. Times follow your timezone, including daylight saving changes.`,kb);
 }
 async function privacy(ctx:Context,u:User){u=await put(db,u,{...state(u),step:'privacy',pendingSubscribe:false});const kb=new InlineKeyboard();button(kb,u,'Delete my data & alerts','deleteuser').danger().row();button(kb,u,'‹ Settings','settings');homeButton(kb,u);await view(ctx,'Privacy & your data\n\nWe store your Telegram account ID, search filters and delivery preferences to run your alerts.\n\nInteraction payloads are kept for 7 days; activity and digests for 90 days. Backups normally expire after 14 days; a backup failure can delay cleanup.\n\nDeleting your data stops alerts and removes your settings, subscriptions and identifiable activity. Deletion records prevent these from returning after a backup restore.',kb);}
 async function zones(ctx:Context,u:User,page=0,query=''){
  const s=state(u),all=Intl.supportedValuesOf('timeZone');if(!all.includes('UTC'))all.push('UTC');
  const suggestions=[...new Set([...(u.timezoneConfirmed?[u.timezone]:[]),...suggestedZones(s.filters?.countries??[],u.timezone)])].filter(v=>all.includes(v));
  const ordered=[...suggestions,...all.filter(v=>!suggestions.includes(v))];
  const filtered=ordered.filter(v=>zoneLabel(v).toLowerCase().includes(query.replaceAll('_',' ').toLowerCase()));
  const p=Math.max(0,Math.min(page,Math.max(0,Math.ceil(filtered.length/8)-1))),shown=filtered.slice(p*8,p*8+8);
  u=await put(db,u,{...s,step:'timezone',query,page:p,choices:shown});const kb=new InlineKeyboard();
  shown.forEach((v,i)=>{button(kb,u,`${v===u.timezone?'✓ ':''}${zoneLabel(v)}`,'zone',String(i)).row();});
  if(p>0)button(kb,u,'‹ Previous','zonepage',String(p-1));if((p+1)*8<filtered.length)button(kb,u,'Next ›','zonepage',String(p+1));kb.row();
  button(kb,u,'⌕ Search city / timezone','lookup','timezone').row();if(query)button(kb,u,'Clear search · Show all','clearlookup','timezone').row();
  button(kb,u,s.pendingSubscribe?'‹ Back to results':'‹ Settings',s.pendingSubscribe?'results':'settings');
  await view(ctx,`🕘 When should we send your digest?\n\n${s.pendingSubscribe?'Choose your timezone to finish saving this alert.':'Choose the timezone for all your alerts.'}\nCurrent · ${zoneLabel(u.timezone)}\n\n${filtered.length?`${!query&&p===0?'Suggested timezones first · ':''}Page ${p+1} / ${Math.ceil(filtered.length/8)}\nChoose a city in your timezone, or type its name.`:`No timezone matches “${clip(query,80)}”. Try a nearby major city.`}\n\nDaylight saving changes are handled automatically.`,kb);
 }
 async function times(ctx:Context,u:User,zone:string,error=''){
  u=await put(db,u,{...state(u),step:'time',zone});const kb=new InlineKeyboard();
  for(const v of ['08:00','09:00','12:00','18:00']){button(kb,u,`${v===u.sendTime?'✓ ':''}${v}`,'time',v);if(v==='09:00'||v==='18:00')kb.row();}
  button(kb,u,'‹ Change timezone','backzones').row();button(kb,u,state(u).pendingSubscribe?'Cancel · Back to results':'Cancel · Settings',state(u).pendingSubscribe?'results':'settings');
  await view(ctx,`🕘 Choose your daily delivery time\n\n${error?`${error}\n\n`:''}Timezone · ${zoneLabel(zone)}\n\nPick a time below, or send a time such as 07:30 (24-hour clock).\n\n${state(u).pendingSubscribe?'Choosing a time saves your alert.':'This updates the delivery time for all your alerts.'}\nYou’ll only receive a digest when there are new matches.`,kb);
 }
 async function saveAlert(ctx:Context,u:User){
  const s=state(u);const sub=await saveSubscription(db,u.id,s.filters??empty(),s.editId);
  if(!sub.alreadyExists)await event(ctx,u,s.editId?'subscription_edited':'subscription_created',{subscriptionId:sub.id});
  u=await put(db,u,{...s,step:'subscription',pendingSubscribe:false,editId:undefined});
  return subscription(ctx,u,sub.id,sub.alreadyExists?'✓ You already have this alert':s.editId?'✓ Alert updated':'✓ Alert saved');
 }
 async function finishTime(ctx:Context,u:User,time:string){const s=state(u);await setSchedule(db,u.id,s.zone??u.timezone,time);u=await db.user.findUniqueOrThrow({where:{id:u.id}});if(s.pendingSubscribe)return saveAlert(ctx,u);return settings(ctx,u,'✓ Delivery time updated');}
 async function digestPage(ctx:Context,u:User,id:string,page=0){
  const d=await db.digest.findFirst({where:{id,userId:u.id}});if(!d)return view(ctx,'Digest no longer available\n\nDigests are kept for 90 days. You can browse current jobs from Home.',homeButton(new InlineKeyboard(),u));
  const total=await db.digestItem.count({where:{digestId:id}});page=Math.min(Math.max(0,page),Math.max(0,Math.ceil(total/5)-1));
  const items=await db.digestItem.findMany({where:{digestId:id},orderBy:{position:'asc'},skip:page*5,take:5,include:{job:true}});
  u=await put(db,u,{...state(u),step:'digest',returnTo:{kind:'digest',page,id}});const kb=new InlineKeyboard();
  items.forEach((item,i)=>button(kb,u,`${page*5+i+1}. ${clip(item.job.title,45)} →`,'job',item.jobId).row());
  if(page>0)kb.text('‹ Previous',`D|${id}|${page-1}`);if((page+1)*5<total)kb.text('Next ›',`D|${id}|${page+1}`);kb.row();button(kb,u,'Manage alerts','subs');homeButton(kb,u);
  await view(ctx,`Your daily matches · ${d.localDate}\n\n${total} jobs · Page ${page+1} / ${Math.max(1,Math.ceil(total/5))}\n\n${items.map((i,n)=>`${jobCard(i.job,page*5+n+1,(i.matches as Match[]).map(m=>m.keyword??'').find(Boolean)??'')}\n${i.job.status!=='active'?`Status · ${i.job.status}\n`:''}Alert · ${clip((i.matches as Match[]).map(m=>m.name).join('; '),140)}`).join('\n\n')}\n\nSource · Jobicy`,kb);await event(ctx,u,'result_page_viewed',{digestId:id,page});
 }
 async function jobDetail(ctx:Context,u:User,id:string){
  const job=await db.job.findUnique({where:{id}});if(!job)return view(ctx,'Listing no longer available\n\nReturn to your results to browse other roles.',button(new InlineKeyboard(),u,'‹ Back to results','backjobs'));
  await event(ctx,u,'job_open_clicked',{jobId:job.id,source:job.source});
  u=await put(db,u,{...state(u),step:'job'});
  const s=state(u);const kb=new InlineKeyboard().url('View listing & apply ↗',job.url).primary().row();button(kb,u,s.returnTo?.kind==='digest'?'‹ Back to daily matches':'‹ Back to results','backjobs').row();homeButton(kb,u);
  const status=job.status==='closed'?'⛔ This listing has closed.':job.status==='unknown'?'Status could not be confirmed. Check the original listing.':'● Active listing';
  await view(ctx,`${clip(job.title,180)}\n${clip(job.company,120)}\n\n🌍 ${clip(job.geo||'Location unspecified',250)}\n💰 ${clip(job.salary??'Salary not listed',150)}\n💼 ${clip(job.categories.join(', ')||'Uncategorized',200)}\n${job.publishedAt?'Posted':'Found'} · ${(job.publishedAt??job.firstSeenAt).toISOString().slice(0,10)}\n${status}\n\n${snippet(job.description,s.filters?.keyword??'',1400)}\n\nJobicy · ${updatedAt(job.checkedAt).replace('Updated','Status checked')}\nRead the full listing for responsibilities, eligibility and how to apply. Country matching does not verify visa or work rights.`,kb);
 }
 async function backJobs(ctx:Context,u:User){const back=state(u).returnTo;return back?.kind==='digest'&&back.id?digestPage(ctx,u,back.id,back.page):results(ctx,u,back?.page??0);}
 async function dataStatus(ctx:Context,u:User){
  u=await put(db,u,{...state(u),step:'about',pendingSubscribe:false});
  const latest=await db.syncRun.findFirst({where:{status:'complete'},orderBy:{finishedAt:'desc'}}),count=await db.job.count({where:{status:'active'}});
  const kb=new InlineKeyboard();button(kb,u,'Refresh status','status').row();button(kb,u,'Privacy','privacy');homeButton(kb,u);
  await view(ctx,`About Remote Job Radar\n\nFree remote job search and daily alerts.\n\nSource · Jobicy\nActive jobs · ${count.toLocaleString('en')}\n${updatedAt(latest?.finishedAt)}\n\nWe link to original listings. The source feed covers recent jobs with a delay; older stored jobs are checked separately. A country with few results stays available.\n\nMatching a country is not a visa or work-rights check. Always read the employer’s requirements.`,kb);
 }
 bot.on('message:text',async ctx=>{
  if(/^\/stats(?:@\w+)?(?:\s|$)/.test(ctx.message.text.trim())){
   if(ctx.chat.type!=='private')return;
   if(!config.ADMIN_TELEGRAM_ID||String(ctx.from.id)!==config.ADMIN_TELEGRAM_ID)return ctx.reply('This command is only available to the administrator.');
   return ctx.reply(await adminStats(db,BigInt(config.ADMIN_TELEGRAM_ID)),{link_preview_options:{is_disabled:true}});
  }
  if(/^\/activity(?:@\w+)?(?:\s|$)/.test(ctx.message.text.trim())){
   if(ctx.chat.type!=='private')return;
   if(!config.ADMIN_TELEGRAM_ID||String(ctx.from.id)!==config.ADMIN_TELEGRAM_ID)return ctx.reply('This command is only available to the administrator.');
   return ctx.reply(await adminActivity(db,BigInt(config.ADMIN_TELEGRAM_ID)),{link_preview_options:{is_disabled:true}});
  }
  const foundUser=await user(ctx);if(!foundUser)return;let u:User=foundUser;const text=ctx.message.text.trim(),s=state(u);
  if(/^\/start(?:@\w+)?(?:\s|$)/.test(text)||['/menu','/cancel'].includes(text)){u=await put(db,u,{...s,step:'home',pendingSubscribe:false});await event(ctx,u,'start');return menu(ctx,u);}
  if(text==='/privacy')return privacy(ctx,u);
  if(text==='/help'){u=await put(db,u,{...s,step:'help',pendingSubscribe:false});return view(ctx,'How to use Remote Job Radar\n\n1. Find jobs: set your location, occupation or keyword.\n2. Browse matches and open the original listing to apply.\n3. Save an alert to get a daily digest of new matches.\n\nUse /menu to go Home. Your search filters are kept. Use /cancel to leave an input step.',homeButton(new InlineKeyboard(),u));}
  if(s.step==='lookup')return s.zone==='timezone'?zones(ctx,u,0,text.slice(0,80)):selection(ctx,u,s.zone==='category'?'category':'country',0,text.slice(0,80));
  if(s.step==='country'||s.step==='category')return selection(ctx,u,s.step,0,text.slice(0,80));
  if(s.step==='timezone')return zones(ctx,u,0,text.slice(0,80));
  if(s.step==='keyword'){
   if(text.length>200)return keyword(ctx,u,'Please keep your keyword to 200 characters or fewer.');
   u=await put(db,u,{...s,filters:{...(s.filters??empty()),keyword:text}});return filters(ctx,u);
  }
  if(s.step==='time'){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(text))return times(ctx,u,s.zone??u.timezone,'Please use a valid 24-hour time, for example 07:30.');return finishTime(ctx,u,text);}
  await view(ctx,'Ready when you are\n\nUse Find jobs to start a search, or continue with your saved filters. To search by a phrase, choose Keyword in the search panel.',button(button(new InlineKeyboard(),u,'Find jobs','find').primary().row(),u,'Continue search','filters').row().text('⌂ Home',cb(u,'menu')));
 });
 bot.on('callback_query:data',async ctx=>{
  const foundUser=await user(ctx);if(!foundUser)return;let u:User=foundUser;
  const [version,action,arg='']=ctx.callbackQuery.data.split('|');
  const stale=version!=='D'&&Number(version)!==u.interactionVersion;
  try{await ctx.answerCallbackQuery(stale?{text:'This is an older menu. Use the latest message, or send /menu.',show_alert:true}:{});}catch(e){if(!(e instanceof GrammyError&&e.error_code===400))throw e;}
  if(stale)return;
  if(version==='D')return digestPage(ctx,u,action!,Number(arg)||0);
  const s=state(u),f=s.filters??empty();
  switch(action){
   case 'menu':u=await put(db,u,{...s,step:'home',pendingSubscribe:false});return menu(ctx,u);
   case 'find':u=await put(db,u,{filters:empty()});return filters(ctx,u);
   case 'filters':return filters(ctx,u);
   case 'resetfilters':u=await put(db,u,{...s,filters:empty()});return filters(ctx,u);
   case 'results':u=await put(db,u,{...s,pendingSubscribe:false});return results(ctx,u);
   case 'country':return selection(ctx,u,'country');
   case 'category':return selection(ctx,u,'category');
   case 'keyword':return keyword(ctx,u);
   case 'skip':case 'clearkeyword':u=await put(db,u,{...s,filters:{...f,keyword:''}});return filters(ctx,u);
   case 'broadenkeyword':u=await put(db,u,{...s,filters:{...f,keyword:''}});return results(ctx,u);
   case 'lookup':{
    u=await put(db,u,{...s,step:'lookup',zone:arg});const kb=new InlineKeyboard();button(kb,u,'‹ Cancel search',arg==='timezone'?'backzones':arg==='category'?'category':'country');
    return view(ctx,`⌕ Search ${arg==='timezone'?'timezones':arg==='category'?'occupations':'countries'}\n\n${arg==='timezone'?'Send a major city or timezone, such as London or Asia/Tokyo.':'Send a name or part of a name.'}\n\nYour selections will be kept.`,kb);
   }
   case 'clearlookup':return arg==='timezone'?zones(ctx,u):selection(ctx,u,arg==='category'?'category':'country');
   case 'selectpage':return selection(ctx,u,s.step==='category'?'category':'country',Number(arg)||0,s.query);
   case 'pick':{
    const choice=s.choices?.[Number(arg)];if(!choice)return;const key=s.step==='category'?'categories':'countries';
    const selected=f[key].includes(choice)?f[key].filter(v=>v!==choice):[...f[key],choice];u=await put(db,u,{...s,filters:{...f,[key]:selected}});return selection(ctx,u,s.step==='category'?'category':'country',s.page,s.query);
   }
   case 'any':u=await put(db,u,{...s,filters:{...f,[arg==='country'?'countries':'categories']:[]}});return selection(ctx,u,arg==='country'?'country':'category',s.page,s.query);
   case 'resultpage':return results(ctx,u,Number(arg)||0);
   case 'subscribe':if(!u.timezoneConfirmed){u=await put(db,u,{...s,pendingSubscribe:true});return zones(ctx,u);}return saveAlert(ctx,u);
   case 'subs':return subscriptions(ctx,u);
   case 'subpage':return subscriptions(ctx,u,Number(arg)||0);
   case 'sub':return subscription(ctx,u,arg);
   case 'editsub':case 'viewsubjobs':{
    const sub=await db.subscription.findFirst({where:{id:arg,userId:u.id}});if(!sub)return subscriptions(ctx,u);
    u=await put(db,u,{filters:{countries:sub.countries,categories:sub.categories,keyword:sub.keyword},editId:action==='editsub'?sub.id:undefined});return action==='editsub'?filters(ctx,u):results(ctx,u);
   }
   case 'pause':case 'resume':await setPaused(db,u.id,arg,action==='pause');await event(ctx,u,action==='pause'?'subscription_paused':'subscription_resumed');return subscription(ctx,u,arg,action==='pause'?'⏸ Alert paused':'✓ Alert resumed');
   case 'deletesub':{
    const sub=await db.subscription.findFirst({where:{id:arg,userId:u.id}});if(!sub)return subscriptions(ctx,u);const kb=new InlineKeyboard();button(kb,u,'Keep this alert','sub',arg).row();button(kb,u,'Delete alert','confirmdel',arg).danger();return view(ctx,`Delete this alert?\n\n${filterSummary(sub)}\n\nYou’ll stop receiving new matches for this search. Your other alerts will stay active.`,kb);
   }
   case 'confirmdel':await db.$transaction(async tx=>{const sub=await tx.subscription.findFirst({where:{id:arg,userId:u.id}});if(sub){await tx.deferredMatch.deleteMany({where:{subscriptionId:arg}});await tx.subscription.delete({where:{id:arg}});}});await event(ctx,u,'subscription_deleted');return subscriptions(ctx,u);
   case 'settings':u=await put(db,u,{...s,step:'settings',pendingSubscribe:false});return settings(ctx,u);
   case 'privacy':return privacy(ctx,u);
   case 'timezone':u=await put(db,u,{...s,pendingSubscribe:false});return zones(ctx,u);
   case 'backzones':return zones(ctx,u);
   case 'zonepage':return zones(ctx,u,Number(arg)||0,s.query);
   case 'zone':{const zone=s.choices?.[Number(arg)];if(!zone)return;return times(ctx,u,zone);}
   case 'time':return finishTime(ctx,u,arg);
   case 'pauseall':case 'resumeall':await pauseAll(db,u.id,action==='pauseall');u=await db.user.findUniqueOrThrow({where:{id:u.id}});return settings(ctx,u,action==='pauseall'?'⏸ All alerts paused':'✓ All alerts enabled. Individually paused alerts stay paused.');
   case 'deleteuser':{
    const kb=new InlineKeyboard();button(kb,u,'Keep my data','privacy').row();button(kb,u,'Delete all my data & alerts','confirmuser').danger();return view(ctx,'Delete your data?\n\nThis removes all your alerts, preferences and identifiable activity. All reminders will stop.\n\nYou can start again later, but your current alerts cannot be recovered. Backups normally expire after 14 days; cleanup may take longer during a backup failure.',kb);
   }
   case 'confirmuser':await deleteUser(db,u.id,config.DELETION_JOURNAL_PATH);return view(ctx,'Your data has been deleted\n\nAll your alerts have stopped. Send /start whenever you want to begin again.',new InlineKeyboard());
   case 'status':return dataStatus(ctx,u);
   case 'job':return jobDetail(ctx,u,arg);
   case 'backjobs':return backJobs(ctx,u);
  }
 });
 return bot;
}
