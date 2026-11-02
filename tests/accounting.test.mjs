import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,readFile as read,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {quoteUsage,normalizeUsage,canonicalModel,validatePriceBook} from '../src/core/pricing.mjs';
import {Ledger} from '../src/core/ledger.mjs';
import {dateRange,summarize,shanghaiDate} from '../src/core/statistics.mjs';
import {callsFromEvents,eventCall} from '../src/core/records.mjs';
import {cnyText,feeText,pieSlices} from '../src/core/format.mjs';
const book=JSON.parse(await readFile(new URL('../config/pricing.json',import.meta.url)));
const usage=(inputTokens,outputTokens,cacheReadTokens=0,cacheWriteTokens=0)=>({inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens:inputTokens+outputTokens+cacheReadTokens+cacheWriteTokens});
const quote=(model,u,provider='chatbox',time=Date.parse('2026-10-30T10:00:00+08:00'))=>quoteUsage(book,{provider,model,usage:u,time});

test('reject invalid configured prices and zero rounding quanta before recording charges',()=>{
  assert.doesNotThrow(()=>validatePriceBook(book));
  const negative=structuredClone(book);negative.chatbox['claude-haiku-5-5'].input=-1;assert.throws(()=>validatePriceBook(negative));
  const zero=structuredClone(book);zero.chatbox['claude-haiku-5-5'].quantum=0;assert.throws(()=>validatePriceBook(zero));
  const bad=structuredClone(book);bad.cny[0].input='NaN';assert.throws(()=>validatePriceBook(bad));
});

test('synthetic reference examples cover all six Chatbox models without private billing records',()=>{
  // Invented inputs; expected values are calculated from docs/rates.md.
  const examples=[
    ['claude-fable-5-1',usage(1000,100,2000,400),'20504'],
    ['claude-sonnet-5-5',usage(1000,100,2000,400),'4400'],
    ['claude-opus-5-5',usage(1000,100,2000,400),'8400'],
    ['claude-haiku-5-5',usage(1000,100,2000,400),'220'],
    ['gemini-4-argon',usage(1000,100,2000),'3200'],
    ['grok-4.7',usage(1000,100,2000),'2160']
  ];
  for(const [model,input,expected] of examples)assert.equal(quote(model,input).amount,expected,model);
  assert.equal(quote('gemini-4-argon',usage(1000,100,0,1)).status,'unknown');
  assert.equal(quote('grok-4.7',usage(1000,100,0,1)).status,'unknown');
});

test('disjoint cache buckets and reasoning are counted exactly once',()=>{
  const u={...usage(1000,200,3000,400),reasoningTokens:50};
  assert.equal(normalizeUsage(u).total,4600);
  assert.equal(quote('claude-opus-5-5',u).amount,'10600');
  assert.equal(normalizeUsage({...u,totalTokens:4500}).known,false);
  assert.equal(quote('claude-opus-5-5',{...u,totalTokens:4601}).status,'unknown');
});
test('Chatbox exact allocation conversion, rounding and model aliases',()=>{
  assert.equal(canonicalModel('grok-4.7'),'grok-4-7');
  const q=quote('claude-sonnet-5-5',usage(1000000,0));
  assert.equal(q.amount,'2000000');assert.equal(q.cnyNano,'18750000000');
  assert.equal(quote('gemini-4-argon',usage(1,1)).amount,'16');
  assert.equal(quote('grok-4.7',usage(1,1)).amount,'8');
  assert.equal(quote('grok-4.7',usage(200000,0)).status,'unknown');
  assert.equal(feeText(q),'2,000,000 点');assert.equal(cnyText('9375'),'0.00000937');
  assert(!feeText(q).includes('CNY'));
});
test('Haiku threshold reprices the entire request, including cached input',()=>{
  assert.equal(quote('claude-haiku-5-5',usage(100000,0)).amount,'10000');
  assert.equal(quote('claude-haiku-5-5',usage(100001,0)).amount,'50001');
  assert.equal(quote('claude-haiku-5-5',usage(1,0,100000)).amount,'5001');
});
test('missing usage and unknown prices remain unknown; exact totals can establish zero omitted buckets',()=>{
  assert.equal(quote('claude-haiku-5-5',undefined).amount,null);
  assert.equal(quote('unknown',usage(100,10)).amount,null);
  assert.equal(quote('claude-haiku-5-5',{inputTokens:100,outputTokens:10}).amount,null);
  assert.equal(quote('claude-haiku-5-5',{inputTokens:100,outputTokens:10,totalTokens:110}).amount,'15');
  assert.equal(quote('claude-haiku-5-5',{inputTokens:100,outputTokens:10,totalTokens:120}).amount,null);
  assert.equal(quote('claude-haiku-5-5',{inputTokens:1,outputTokens:-1}).status,'unknown');
});
test('DeepSeek CNY schedule uses Shanghai peak hours, weekends and holidays',()=>{
  const calculate=time=>quote('deepseek-v4-pro',usage(1000000,0,1000000),'deepseek',Date.parse(time));
  assert.equal(calculate('2026-10-30T10:00:00+08:00').amount,'9300000000');
  assert.equal(calculate('2026-10-30T12:00:00+08:00').amount,'4650000000');
  assert.equal(calculate('2026-10-31T10:00:00+08:00').amount,'4650000000');
  assert.equal(calculate('2026-10-01T10:00:00+08:00').amount,'4650000000');
  assert.equal(feeText(calculate('2026-10-30T10:00:00+08:00')),'9.30 CNY');
});
test('date ranges include Shanghai days and reject over six calendar months',()=>{
  const range=dateRange({preset:7},Date.parse('2026-10-30T23:59:00+08:00'));
  assert.equal(range.startDate,'2026-10-24');assert.equal(shanghaiDate(range.end),'2026-10-31');
  assert.doesNotThrow(()=>dateRange({preset:'custom',start:'2026-08-31',end:'2027-02-28'}));
  assert.throws(()=>dateRange({preset:'custom',start:'2026-08-31',end:'2027-03-01'}));
  assert.throws(()=>dateRange({preset:'custom',start:'2026-02-30',end:'2026-03-01'}));
  assert.throws(()=>dateRange({preset:'custom',start:'2026-10-30',end:'2026-10-01'}));
});
test('provider routing comes from the settled message, retries from logged headers; forks do not duplicate calls',()=>{
  const events=[{type:'request/header',seq:0,data:{header:{config:{provider:'deepseek',model:'deepseek-v4-pro'}}}},
    {type:'assistant/attempt',seq:1,time:100,data:{turn:0,step:0,stream:[{type:'chunk',chunk:{type:'usage',usage:usage(100,2)}}]}},
    {type:'assistant/message',seq:2,time:101,data:{turn:0,step:0,message:{id:'same-id',source:{provider:'chatbox',model:'claude-haiku-5-5'}},usage:usage(200,3)}}];
  const parent=callsFromEvents('parent',events),child=callsFromEvents('child',events,3);
  assert.equal(parent.calls[0].provider,'deepseek');assert.equal(parent.calls[1].provider,'chatbox');assert.equal(child.calls.length,0);assert.equal(child.views[0].id,parent.calls[1].id);
  assert.equal(eventCall('s',{type:'compaction/summary',seq:5,time:3,data:{compactionId:'a',provider:'chatbox',model:'m',usage:usage(1,2)}}).purpose,'compaction');
});
test('ledger serializes concurrent duplicates and preserves original fees after rates change or restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-billing-test-')),file=join(dir,'ledger.jsonl'),ledger=new Ledger(file,book);await ledger.load();
  const call={id:'message:1',sessionId:'s',seq:1,time:Date.now(),provider:'chatbox',model:'claude-haiku-5-5',usage:usage(100,10)};
  await Promise.all([ledger.put(call),ledger.put(call),ledger.put(call)]);
  assert.equal((await read(file,'utf8')).trim().split('\n').length,1);
  const changed=structuredClone(book);changed.chatbox['claude-haiku-5-5'].input=999999999;
  const restored=new Ledger(file,changed);await restored.load();await restored.put(call);
  assert.equal(restored.records.get(call.id).quote.amount,'15');
  ledger.rememberViews([{sessionId:'child',seq:1,id:call.id}]);assert.equal((await ledger.fees('child',[1]))[0].record.quote.amount,'15');
  await appendFile(file,'{"broken":');const broken=new Ledger(file,book);await broken.load();assert(broken.diagnostics.length>0);await assert.rejects(broken.put({...call,id:'new'}));
});
test('statistics use only used routes, preserve unknowns, and charts have independent valid denominators',()=>{
  const time=Date.parse('2026-10-30T12:00:00+08:00'),records=[
    {time,provider:'chatbox',model:'claude-haiku-5-5',quote:quote('claude-haiku-5-5',usage(100,0))},
    {time,provider:'deepseek',model:'deepseek-v4-pro',quote:quote('deepseek-v4-pro',usage(100,0),'deepseek')},
    {time,provider:'chatbox',model:'unknown',quote:quote('unknown',usage(300,0))},
    {time,provider:'chatbox',model:'unknown',quote:quote('unknown',undefined)}];
  const s=summarize(records,dateRange({preset:7},time));assert.equal(s.models.length,3);assert.equal(s.totalTokens,500);assert.equal(s.unknownCost,2);assert.equal(s.unknownTokens,1);
  assert.equal(pieSlices(s.models,'tokens').length,3);assert.equal(pieSlices(s.models,'cny').length,2);
  assert(Math.abs(pieSlices(s.models,'tokens').reduce((n,r)=>n+r.share,0)-1)<1e-10);
});
