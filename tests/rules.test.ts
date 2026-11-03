import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHtml,geography,filterHash,nextDue,escapeLike,countryOptions } from '../src/rules.js';
test('all country options remain accessible, including sparse countries',()=>{assert.ok(countryOptions.some(c=>c.code==='CN'));assert.ok(countryOptions.length>240);});
test('literal matching normalization does not expand wildcards or reorder meaning',()=>{assert.equal(escapeLike('100%_\\'), '100\\%\\_\\\\');assert.equal(filterHash({countries:['US','GB'],categories:[],keyword:' SaaS '}),filterHash({countries:['GB','US'],categories:[],keyword:'saas'}));});
test('HTML is decoded and removed; ambiguous regions are not guessed',()=>{assert.equal(cleanHtml('<p>Hello &amp; <b>world</b></p>'),'Hello & world');assert.deepEqual(geography('APAC','').countries,[]);assert.ok(geography('Europe','').countries.includes('GB'));assert.ok(!geography('Anywhere','Except UK').countries.includes('GB'));assert.deepEqual(geography('USA, Canada','').countries,['CA','US']);});
test('DST gap shifts to first valid local minute; repeated wall time fires once',()=>{
 assert.equal(nextDue('America/New_York','02:30',new Date('2026-03-08T05:00:00Z')).toISOString(),'2026-03-08T07:00:00.000Z');
 assert.equal(nextDue('America/New_York','01:30',new Date('2026-11-01T04:00:00Z')).toISOString(),'2026-11-01T05:30:00.000Z');
 assert.equal(nextDue('America/New_York','01:30',new Date('2026-11-01T05:40:00Z')).toISOString(),'2026-11-02T06:30:00.000Z');
 assert.throws(()=>nextDue('invalid','09:00'));
});

test('explicit single-country residency narrows worldwide eligibility',()=>{assert.deepEqual(geography('Anywhere','Candidates must reside in the United States.').countries,['US']);});
