import { createHash } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { convert } from 'html-to-text';
import countriesLib from 'i18n-iso-countries';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
countriesLib.registerLocale(require('i18n-iso-countries/langs/en.json'));
export type Filters={countries:string[];categories:string[];keyword:string};
export const countryOptions=Object.keys(countriesLib.getAlpha2Codes()).map(code=>({code,name:countriesLib.getName(code,'en') ?? code})).sort((a,b)=>a.name.localeCompare(b.name));
const aliases:Record<string,string>={'usa':'US','united states':'US','uk':'GB','united kingdom':'GB','uae':'AE','south korea':'KR','czech republic':'CZ','taiwan':'TW'};
// Europe is a geographic coverage rule; ambiguous commercial regions remain unknown.
const europe='AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH TR UA GB VA'.split(' ');
export function cleanHtml(s:string) {return convert(s,{wordwrap:false,selectors:[{selector:'a',options:{ignoreHref:true}},{selector:'img',format:'skip'}]}).replace(/\s+/g,' ').trim();}
export function normalizeFilters(f:Filters):Filters {return {countries:[...new Set(f.countries)].sort(),categories:[...new Set(f.categories)].sort(),keyword:f.keyword.trim()};}
export function filterHash(f:Filters){const n=normalizeFilters(f);return createHash('sha256').update(JSON.stringify({...n,keyword:n.keyword.toLowerCase()})).digest('hex');}
export function escapeLike(s:string){return s.replace(/[\\%_]/g,'\\$&');}
export function geography(geo:string,description:string):{countries:string[];restrictions:{unknown:string[];excluded:string[];evidence:string[]}} {
 const found=new Set<string>(),unknown:string[]=[],excluded:string[]=[],evidence:string[]=[];
 for(const raw of geo.split(/[,;|]/).map(v=>v.trim()).filter(Boolean)) {
  const label=raw.toLowerCase();
  if(['anywhere','worldwide','global'].includes(label)) {countryOptions.forEach(c=>found.add(c.code));continue;}
  if(label==='europe'){europe.forEach(c=>found.add(c));continue;}
  const code=aliases[label] ?? countriesLib.getAlpha2Code(raw,'en');
  if(code){found.add(code);continue;} unknown.push(raw);
 }
 // Narrow positive residency requirements override broader source labels.
 for(const m of description.matchAll(/\b(?:must (?:be based|reside|live) in|(?:applicants|candidates) must be located in)\s+(?:the )?(United States|USA|United Kingdom|UK|Canada|Germany|France|Australia|India)\b(?=\s*(?:[.!;]|$))/gi)) {
  const code=aliases[m[1]!.toLowerCase()] ?? countriesLib.getAlpha2Code(m[1]!,'en');
  if(code){for(const c of found)if(c!==code)found.delete(c);evidence.push(m[0]);}
 }
 // Only literal, explicit country exclusion wording; do not infer visa eligibility from prose.
 for(const m of description.matchAll(/\b(?:excluding|except|not available in|not open to applicants (?:in|from))\s+(United States|USA|United Kingdom|UK|Canada|Germany|France|Australia|India)\b/gi)) {
  const code=aliases[m[1]!.toLowerCase()] ?? countriesLib.getAlpha2Code(m[1]!,'en');
  if(code){found.delete(code);excluded.push(code);evidence.push(m[0]);}
 }
 return {countries:[...found].sort(),restrictions:{unknown,excluded,evidence}};
}
export function nextDue(zone:string,time:string,now:Date=new Date()):Date {
 if(!IANAZone.isValidZone(zone)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid timezone or local time');
 const local=DateTime.fromJSDate(now,{zone});const [hour,minute]=time.split(':').map(Number);
 for(let day=0;day<4;day++) {
  const date=local.plus({days:day}).toISODate()!;
  const target=hour!*60+minute!;
  // Iterate real minutes of a local day: DST gaps choose first valid minute after the requested wall time.
  const start=DateTime.fromISO(date,{zone}).startOf('day');
  const end=start.plus({days:1});
  for(let t=start;t<end;t=t.plus({minutes:1})) {
   if(t.hour*60+t.minute<target) continue;
   // First occurrence only, even if now is between repeated wall-clock times.
   if(t.toMillis()>now.getTime()) return t.toUTC().toJSDate();
   break;
  }
 }
 throw new Error('Cannot compute next local send time');
}
export function localDate(zone:string,at:Date=new Date()){return DateTime.fromJSDate(at,{zone}).toISODate()!;}
export function snippet(text:string,keyword:string,max=180){const i=keyword?text.toLowerCase().indexOf(keyword.toLowerCase()):0;return `${i>40?'…':''}${text.slice(Math.max(0,i-40),Math.max(0,i-40)+max)}${text.length>max?'…':''}`;}
