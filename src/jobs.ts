import { z } from 'zod';
import { Prisma, type Job } from '@prisma/client';
import type { Db, Tx } from './db.js';
import { boundary } from './db.js';
import { cleanHtml, geography, escapeLike, type Filters } from './rules.js';
const listing=z.object({id:z.number().int().positive(),url:z.string().url(),jobTitle:z.string().max(2000),companyName:z.string().max(1000),jobGeo:z.string().default(''),jobIndustry:z.array(z.string()).default([]),jobDescription:z.string().max(500000),pubDate:z.string().optional(),salaryMin:z.union([z.number(),z.string()]).nullable().optional(),salaryMax:z.union([z.number(),z.string()]).nullable().optional(),salaryCurrency:z.string().nullable().optional(),salaryPeriod:z.string().nullable().optional()});
const page=z.object({success:z.literal(true),jobs:z.array(listing).max(100),nextCursor:z.string().nullable(),hasMore:z.boolean()});
export class SourceError extends Error {constructor(message:string,public retryAfter=60){super(message);}}
export async function sourceGet(path:string,fetcher:typeof fetch=fetch) {
 const response=await fetcher(`https://jobicy.com/api/${path}`,{headers:{Accept:'application/json','User-Agent':'TelegramJobAlerts/0.1 (+https://github.com/gelatoni-xh/telegram-job-alerts)'},signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw new SourceError(`Source HTTP ${response.status}`,Number(response.headers.get('retry-after'))||60);
 const contentLength=Number(response.headers.get('content-length')||0);
 if(contentLength>15_000_000)throw new SourceError('Source response too large');
 const reader=response.body?.getReader();if(!reader)throw new SourceError('Empty source body');
 let total=0;const chunks:Uint8Array[]=[];
 while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>15_000_000){await reader.cancel();throw new SourceError('Source response too large');}chunks.push(value);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function savePage(tx:Tx,input:z.infer<typeof listing>[]) {
 let seq=await boundary(tx);
 for(const row of input) {
  const id=`jobicy:${row.id}`, old=await tx.job.findUnique({where:{id},select:{id:true}});
  const description=cleanHtml(row.jobDescription);
  const geo=geography(row.jobGeo,description);
  const url=new URL(row.url);if(url.protocol!=='https:'||!['jobicy.com','www.jobicy.com'].includes(url.hostname)) throw new SourceError('Unexpected source URL');
  const publishedAt=row.pubDate&&Number.isFinite(Date.parse(row.pubDate))?new Date(row.pubDate):null;
  const salary=row.salaryMin!=null||row.salaryMax!=null?`${row.salaryMin??'?'} – ${row.salaryMax??'?'} ${row.salaryCurrency??''} / ${row.salaryPeriod??'period unspecified'}`:null;
  const data={title:cleanHtml(row.jobTitle),company:cleanHtml(row.companyName),description,geo:row.jobGeo,countries:geo.countries,categories:row.jobIndustry.map(cleanHtml),restrictions:geo.restrictions,url:row.url,salary,publishedAt,status:'active',checkedAt:new Date()};
  if(old)await tx.job.update({where:{id},data});
  else {seq++;await tx.job.create({data:{id,externalId:String(row.id),discovery:seq,...data}});}
 }
 await tx.discoveryCounter.update({where:{id:1},data:{value:seq}});
}
export async function syncSource(db:Db,fetcher:typeof fetch=fetch) {
 let run=await db.syncRun.findFirst({where:{status:'running'},orderBy:{startedAt:'desc'}});
 if(run&&Date.now()-run.startedAt.getTime()>23*3600_000){await db.syncRun.update({where:{id:run.id},data:{status:'expired',error:'Cursor lifetime elapsed'}});run=null;}
 if(!run){const last=await db.syncRun.findFirst({orderBy:{startedAt:'desc'}});if(last&&Date.now()-last.startedAt.getTime()<3600_000) return;run=await db.syncRun.create({data:{}});}
 try {
  let more=true;
  while(more) {
   const data=page.parse(await sourceGet(`jobs?count=100${run.cursor?`&cursor=${encodeURIComponent(run.cursor)}`:''}`,fetcher));
   if(data.hasMore&&!data.nextCursor)throw new SourceError('Missing continuation cursor');
   if(data.nextCursor&&data.nextCursor===run.cursor)throw new SourceError('Repeated continuation cursor');
   run=await db.$transaction(async tx=>{await savePage(tx,data.jobs);return tx.syncRun.update({where:{id:run!.id},data:{cursor:data.nextCursor,pages:{increment:1},jobs:{increment:data.jobs.length},status:data.nextCursor?'running':'complete',finishedAt:data.nextCursor?null:new Date(),error:null}});},{timeout:20000});
   more=Boolean(data.nextCursor);
  }
 }catch(e){await db.syncRun.update({where:{id:run.id},data:{error:e instanceof SourceError?e.message:'Source sync or schema validation failed',...(e instanceof SourceError&&e.message.includes('400')?{status:'expired'}:{})}});throw e;}
}
export async function checkStatuses(db:Db,ids?:string[],fetcher:typeof fetch=fetch) {
 const jobs=await db.job.findMany({where:ids?{id:{in:ids}}:{status:{not:'closed'},checkedAt:{lt:new Date(Date.now()-3600_000)}},orderBy:{checkedAt:'asc'},take:100,select:{id:true,externalId:true}});
 if(!jobs.length)return;
 const data=z.object({success:z.literal(true),jobs:z.array(z.object({id:z.number().int(),status:z.enum(['active','closed','unknown'])}))}).parse(await sourceGet(`jobs/status?ids=${jobs.map(j=>j.externalId).join(',')}`,fetcher));
 const statuses=new Map(data.jobs.map(j=>[String(j.id),j.status]));
 await db.$transaction(jobs.map(j=>db.job.update({where:{id:j.id},data:{status:statuses.get(j.externalId)??'unknown',checkedAt:new Date()}})));
}
export function matchSql(f:Filters) {
 const keyword=escapeLike(f.keyword);
 return Prisma.sql`${f.countries.length?Prisma.sql`AND j.countries && ARRAY[${Prisma.join(f.countries)}]::text[]`:Prisma.empty}
 ${f.categories.length?Prisma.sql`AND j.categories && ARRAY[${Prisma.join(f.categories)}]::text[]`:Prisma.empty}
 ${keyword?Prisma.sql`AND (j.title ILIKE ${`%${keyword}%`} ESCAPE '\\' OR j.description ILIKE ${`%${keyword}%`} ESCAPE '\\')`:Prisma.empty}`;
}
export async function searchJobs(db:Db|Tx,f:Filters,offset=0,limit=5){
 const where=Prisma.sql`j.status='active' ${matchSql(f)}`;
 const [count]=await db.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM "Job" j WHERE ${where}`;
 const jobs=await db.$queryRaw<Job[]>`SELECT j.* FROM "Job" j WHERE ${where} ORDER BY COALESCE(j."publishedAt",j."firstSeenAt") DESC,j.id DESC LIMIT ${limit} OFFSET ${offset}`;
 return {count:Number(count?.count??0),jobs};
}
export const categories=[ 'Content & Editorial','Creative & Design','Customer Success','Data Science & Analytics','DevOps & Infrastructure','Finance & Accounting','Healthcare & Medical','HR & Recruiting','Marketing & Sales','Product & Operations','Software Engineering' ];
