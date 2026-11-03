import { DateTime } from 'luxon';
import type { Db } from './db.js';

// Read-only aggregates. No public endpoint, raw messages or account IDs in the report.
export async function collectStats(db:Db,adminId:bigint,now=new Date()) {
 const today=DateTime.fromJSDate(now,{zone:'Asia/Shanghai'}).startOf('day');
 const start=today.minus({days:14}).toJSDate(),end=today.plus({days:1}).toJSDate();
 const snapshot=await db.$transaction(async tx=>{
  const users=await tx.user.count({where:{id:{not:adminId}}});
  const alerts=await tx.user.count({where:{id:{not:adminId},paused:false,unreachable:false,subscriptions:{some:{paused:false}}}});
  const newly=await tx.$queryRaw<{day:string;count:bigint}[]>`
   SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day, count(*) AS count
   FROM "User" WHERE id <> ${adminId} AND "createdAt" >= ${start} AND "createdAt" < ${end}
   GROUP BY 1`;
  // Inbox update IDs are unique; Telegram retries cannot inflate these totals.
  // Joining current users also excludes bots/unknown chats and honours data deletion.
  const activity=await tx.$queryRaw<{day:string;active:bigint;interactions:bigint}[]>`
   SELECT to_char(i."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
    count(DISTINCT u.id) AS active, count(*) AS interactions
   FROM "InboxUpdate" i JOIN "User" u ON u."chatId"=i."chatId"
   WHERE u.id <> ${adminId} AND i.status='done' AND i."createdAt">=${start} AND i."createdAt"<${end}
   GROUP BY 1`;
  const weekly=await tx.$queryRaw<{active:bigint}[]>`
   SELECT count(DISTINCT u.id) AS active FROM "InboxUpdate" i JOIN "User" u ON u."chatId"=i."chatId"
   WHERE u.id <> ${adminId} AND i.status='done' AND i."createdAt">=${today.minus({days:7}).toJSDate()} AND i."createdAt"<${today.toJSDate()}`;
  return {users,alerts,newly,activity,weekly:Number(weekly[0]!.active)};
 },{isolationLevel:'RepeatableRead'});
 const daily=Array.from({length:15},(_,i)=>{
  const day=today.minus({days:14-i}).toISODate()!;
  const activity=snapshot.activity.find(r=>r.day===day);
  return {day,newUsers:Number(snapshot.newly.find(r=>r.day===day)?.count??0),active:Number(activity?.active??0),interactions:Number(activity?.interactions??0)};
 });
 return {version:1,service:'remote-job-radar',timezone:'Asia/Shanghai',generatedAt:now.toISOString(),reportDate:daily[13]!.day,
  totals:{registeredUsers:snapshot.users,enabledAlertUsers:snapshot.alerts},weeklyActive:snapshot.weekly,daily};
}
export async function adminStats(db:Db,adminId:bigint,now=new Date()) {
 const report=await collectStats(db,adminId,now),daily=report.daily;
 const snapshot={users:report.totals.registeredUsers,alerts:report.totals.enabledAlertUsers,weekly:report.weeklyActive};
 const previous=daily.slice(0,7),week=daily.slice(7,14),before=daily[12]!,yesterday=daily[13]!,current=daily[14]!;
 const sum=(days:typeof daily,key:'newUsers'|'interactions')=>days.reduce((n,d)=>n+d[key],0);
 const change=(current:number,previous:number)=>previous?`${current>previous?'+':''}${Math.round((current-previous)*100/previous)}%`:(current?'up from 0':'no change');
 return [
  'Remote Job Radar · Admin stats',
  `Asia/Shanghai · ${DateTime.fromJSDate(now,{zone:'Asia/Shanghai'}).toFormat('yyyy-MM-dd HH:mm')}`,
  '',`Day before yesterday · ${before.day}`,
  `New / active / interactions: ${before.newUsers} / ${before.active} / ${before.interactions}`,
  '',`Yesterday · ${yesterday.day}`,
  `New users: ${yesterday.newUsers}`,
  `Active users: ${yesterday.active}`,
  `Interactions: ${yesterday.interactions}`,
  '', 'Yesterday vs day before yesterday',
  ...(['newUsers','active','interactions'] as const).map((key,i)=>`${['New users','Active users','Interactions'][i]}: ${yesterday[key]-before[key]>0?'+':''}${yesterday[key]-before[key]} (${change(yesterday[key],before[key])})`),
  '',`Today so far · ${current.day}`,
  `New / active / interactions: ${current.newUsers} / ${current.active} / ${current.interactions}`,
  '',`Last 7 complete days · ${week[0]!.day} – ${yesterday.day}`,
  `New users: ${sum(week,'newUsers')} (${change(sum(week,'newUsers'),sum(previous,'newUsers'))} vs previous 7 days)`,
  `Active users: ${snapshot.weekly} (deduplicated across 7 days)`,
  `Interactions: ${sum(week,'interactions')} (${change(sum(week,'interactions'),sum(previous,'interactions'))} vs previous 7 days)`,
  '', 'Daily trend · New / Active / Interactions',
  ...week.map(d=>`${d.day.slice(5)} · ${d.newUsers} / ${d.active} / ${d.interactions}`),
  '', 'Current totals',`Registered users: ${snapshot.users}`,`Users with enabled alerts: ${snapshot.alerts}`,
  '', 'Your admin account is excluded from all figures.',
  'Interactions = processed private-chat updates, including messages and buttons; retries count once. Active = users with at least one such update. Automatic digests do not count as activity.',
  'Enabled alerts exclude globally paused or unreachable users. Deleted accounts are excluded, so historical counts may decrease. Zero means no recorded activity; it does not prove the bot is healthy.',
 ].join('\n');
}
