import { DateTime } from 'luxon';
import type { Db } from './db.js';

const labels:Record<string,string>={
 start:'Start / open menu',search_completed:'Search completed',result_page_viewed:'Results viewed',
 zero_results:'Search with no results',job_open_clicked:'Job opened',subscription_created:'Alert created',
 subscription_edited:'Alert edited',subscription_paused:'Alert paused',subscription_resumed:'Alert resumed',
 subscription_deleted:'Alert deleted',
};

export async function adminActivity(db:Db,adminId:bigint,now=new Date()) {
 const today=DateTime.fromJSDate(now,{zone:'Asia/Shanghai'}).startOf('day');
 const start=today.minus({days:7}).toJSDate(),end=today.plus({days:1}).toJSDate();
 const rows=await db.$queryRaw<{day:string;type:string;total:bigint;admin:bigint;others:bigint}[]>`
  SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
   type,count(*) AS total,
   count(*) FILTER (WHERE "userId"=${adminId}) AS admin,
   count(*) FILTER (WHERE "userId"<>${adminId}) AS others
  FROM "Event" WHERE "userId" IS NOT NULL AND "createdAt">=${start} AND "createdAt"<${end}
  GROUP BY 1,type`;
 const render=(from:DateTime,to:DateTime,title:string)=>{
  const range=rows.filter(r=>r.day>=from.toISODate()!&&r.day<to.toISODate()!);
  const totals=new Map<string,{all:number;others:number;admin:number}>();
  for(const row of range){const value=totals.get(row.type)??{all:0,others:0,admin:0};value.all+=Number(row.total);value.others+=Number(row.others);value.admin+=Number(row.admin);totals.set(row.type,value);}
  const entries=[...totals].sort((a,b)=>b[1].all-a[1].all||a[0].localeCompare(b[0]));
  return [`${title} · ${from.toISODate()}${to.diff(from,'days').days>1?` – ${to.minus({days:1}).toISODate()}`:''}`,
   'Interaction · All / Others / Admin',...(entries.length?entries.map(([type,v])=>`${labels[type]??type}: ${v.all} / ${v.others} / ${v.admin}`):['No recorded interactions'])];
 };
 return [
  'Remote Job Radar · Admin activity',
  'Tracked product events only · Asia/Shanghai · deleted-account events are removed',
  '',...render(today.minus({days:7}),today,'Last 7 complete days'),
  '',...render(today,today.plus({days:1}),'Today so far'),
  '', 'Others = everyone except the configured administrator. All = others + admin.',
 ].join('\n');
}
