import { DateTime } from 'luxon';
import { countryOptions, snippet, type Filters } from './rules.js';
import type { Job } from '@prisma/client';
const names=new Map(countryOptions.map(c=>[c.code,c.name]));
export const clip=(text:string,max=120)=>text.length>max?`${text.slice(0,max-1)}…`:text;
export const countryName=(code:string)=>names.get(code)??code;
export function filterSummary(f:Filters){return `Location · ${clip(f.countries.map(countryName).join(', ')||'Any country',220)}\nOccupation · ${clip(f.categories.join(', ')||'Any occupation',220)}\nKeyword · ${clip(f.keyword||'None',160)}`;}
export function localTime(date:Date|null,zone:string){return date?DateTime.fromJSDate(date,{zone}).setLocale('en').toFormat('ccc d LLL, HH:mm'):'Not scheduled';}
export function updatedAt(date:Date|null|undefined){
 if(!date)return 'Waiting for the first update';
 const minutes=Math.max(0,Math.floor((Date.now()-date.getTime())/60000));
 return minutes<1?'Updated just now':minutes<60?`Updated ${minutes} min ago`:minutes<1440?`Updated ${Math.floor(minutes/60)}h ago`:`Updated ${Math.floor(minutes/1440)}d ago`;
}
export function jobCard(j:Job,n:number,keyword=''){
 return `${n}. ${clip(j.title,100)}\n${clip(j.company,65)} · ${clip(j.geo||'Location unspecified',100)}\n${clip(j.salary??'Salary not listed',100)}\n${j.publishedAt?'Posted':'Found'} ${(j.publishedAt??j.firstSeenAt).toISOString().slice(0,10)}\n${snippet(j.description,keyword,100)}`;
}
// Escape source and user text before adding Telegram's supported HTML formatting.
export function screenHtml(text:string){
 const safe=text.slice(0,3950).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 return safe.split('\n').map((line,i)=>i===0||/^\d+\. /.test(line)?`<b>${line}</b>`:line).join('\n');
}
export const zoneLabel=(zone:string)=>zone.replaceAll('_',' ');
export function suggestedZones(countries:string[],current:string){
 const byCountry:Record<string,string[]>={US:['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'],CA:['America/Toronto','America/Vancouver'],GB:['Europe/London'],DE:['Europe/Berlin'],FR:['Europe/Paris'],ES:['Europe/Madrid'],CN:['Asia/Shanghai'],IN:['Asia/Kolkata'],JP:['Asia/Tokyo'],AU:['Australia/Sydney','Australia/Perth'],BR:['America/Sao_Paulo'],SG:['Asia/Singapore']};
 return [...new Set([...countries.flatMap(c=>byCountry[c]??[]),current,'UTC','America/New_York','Europe/London','Europe/Berlin','Asia/Shanghai','Asia/Kolkata','Asia/Tokyo','Australia/Sydney'])];
}
