export const MILLION = 1000000n;
export const NANO = 1000000000n;
export function decimalUnits(value,scale=9) {
  const text=String(value);
  if(!/^\d+(?:\.\d+)?$/.test(text))throw new TypeError('价格必须是非负十进制数');
  const [whole,fraction='']=text.split('.');
  if(fraction.length>scale)throw new TypeError('价格小数位超出支持精度');
  return BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0')||'0');
}
export const ceilDiv=(n,d)=>(n+d-1n)/d;
export function validatePriceBook(book){
  const strings=(value,label)=>{if(!Array.isArray(value)||!value.length||value.some(v=>typeof v!=='string'||!v.trim()))throw new Error(`${label}须为非空字符串数组`);};
  if(typeof book.version!=='string'||!book.version.trim())throw new Error('费率版本不能为空');
  strings(book.chatboxProviderIds,'Chatbox 提供方 ID');decimalUnits(book.chatboxCnyPerMillionPoints);
  const rate=(r,points)=>{
    if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('费率格式无效');
    for(const key of ['input','output','cacheRead','cacheWrite','cacheWrite1h'])if(r[key]!==undefined&&r[key]!==null){if(points){if(!Number.isSafeInteger(r[key])||r[key]<0)throw new Error('点数单价须为非负整数／百万 tokens');}else decimalUnits(r[key]);}
    for(const key of ['threshold','maxPrompt','quantum'])if(r[key]!==undefined&&(!Number.isSafeInteger(r[key])||r[key]<(key==='quantum'?1:0)))throw new Error('费率分档或取整步长无效');
    for(const key of ['from','until'])if(r[key]!==undefined&&!Number.isFinite(Date.parse(r[key])))throw new Error('费率生效日期无效');
    if(r.high)rate(r.high,points);
    if(r.schedule){rate(r.schedule.peak,points);rate(r.schedule.offPeak,points);}
  };
  if(!book.chatbox||typeof book.chatbox!=='object'||Array.isArray(book.chatbox)||!Array.isArray(book.cny))throw new Error('费率表格式无效');
  for(const row of Object.values(book.chatbox))rate(row,true);
  for(const row of book.cny){strings(row.providers,'提供方 ID');strings(row.models,'模型 ID');rate(row,false);}
  return book;
}
export function canonicalModel(value) {
  return String(value||'').toLowerCase().trim().replace(/[ _./]+/g,'-');
}
export function normalizeUsage(raw) {
  if(!raw||typeof raw!=='object')return {known:false,reason:'用量未返回'};
  const keys=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'];
  for(const key of keys)if(raw[key]!==undefined&&(!Number.isSafeInteger(raw[key])||raw[key]<0))return {known:false,reason:'用量字段无效'};
  if(raw.inputTokens===undefined||raw.outputTokens===undefined)return {known:false,reason:'输入或输出用量缺失'};
  if(raw.reasoningTokens>raw.outputTokens)return {known:false,reason:'推理用量与输出矛盾'};
  const input=raw.inputTokens,output=raw.outputTokens,read=raw.cacheReadTokens,write=raw.cacheWriteTokens;
  const knownTotal=input+output+(read??0)+(write??0);
  if(!Number.isSafeInteger(knownTotal)||raw.totalTokens!==undefined&&(raw.totalTokens<knownTotal||(read!==undefined&&write!==undefined&&raw.totalTokens!==knownTotal)))return {known:false,reason:'总用量矛盾'};
  let total=raw.totalTokens??(read!==undefined&&write!==undefined?knownTotal:null);
  if(total!==null&&!Number.isSafeInteger(total))total=null;
  let write1h=raw.cacheWrite1hTokens;
  if(write1h!==undefined&&(!Number.isSafeInteger(write1h)||write1h<0||write===undefined||write1h>write))return {known:false,reason:'缓存有效期用量无效'};
  return {known:true,input,output,read:read??null,write:write??null,write1h:write1h??null,total,reasoning:raw.reasoningTokens??null};
}
function modelRate(book,provider,model,time) {
  const isChatbox=book.chatboxProviderIds.some(id=>id.toLowerCase()===provider.toLowerCase());
  const normalized=canonicalModel(model);
  if(isChatbox)return {kind:'points',rate:book.chatbox[normalized]};
  const rows=(book.cny||[]).filter(row=>row.providers.some(id=>id.toLowerCase()===provider.toLowerCase())&&row.models.some(id=>canonicalModel(id)===normalized)&&(row.from===undefined||time>=Date.parse(row.from))&&(row.until===undefined||time<Date.parse(row.until)));
  return {kind:'CNY',rate:rows.at(-1)};
}
export function quoteUsage(book,{provider='',model='',time=Date.now(),usage}) {
  const normalized=normalizeUsage(usage);
  const selected=modelRate(book,provider,model,time);
  const base={unit:selected.kind,amount:null,cnyNano:null,status:'unknown',pricingVersion:book.version,usage:normalized,note:null};
  if(!normalized.known)return {...base,note:normalized.reason};
  if(!selected.rate)return {...base,note:'费率未配置'};
  const notes=[];
  let rate=selected.rate;
  if((rate.from&&time<Date.parse(rate.from))||(rate.until&&time>=Date.parse(rate.until)))return {...base,note:'该日期的费率尚未配置'};
  // The normalized DSH buckets are DISJOINT; no subtraction of cache hits here.
  const prompt=normalized.input+(normalized.read??0)+(normalized.write??0);
  if(rate.maxPrompt!==undefined&&prompt>rate.maxPrompt)return {...base,note:'该上下文长度的费率尚未验证'};
  if(rate.threshold!==undefined&&prompt>rate.threshold)rate={...rate,...rate.high};
  if(rate.schedule)rate=scheduledRate(rate,time);
  if(rate.schedule?.calendarUntil&&time>=Date.parse(rate.schedule.calendarUntil))notes.push('节假日日历需更新，暂按星期与时段估算');
  if(normalized.read===null||normalized.write===null)notes.push('缓存字段不完整');
  // An exact total can prove that omitted cache buckets are zero, but not their split if nonzero.
  const missingTokens=normalized.total===null?null:normalized.total-(normalized.input+normalized.output+(normalized.read??0)+(normalized.write??0));
  if(missingTokens!==null&&missingTokens>0)return {...base,note:'缺少缓存用量分项，无法确定费用'};
  if(normalized.total===null&&(normalized.read===null||normalized.write===null))return {...base,note:'缓存用量或准确总量未返回'};
  const read=normalized.read??0,write=normalized.write??0,write1h=normalized.write1h??0;
  if(write>0&&normalized.write1h===null&&rate.cacheWrite1h!==undefined)notes.push('缓存写入按5分钟费率估算');
  const buckets=[[normalized.input,rate.input],[normalized.output,rate.output],[read,rate.cacheRead],[write-write1h,rate.cacheWrite],[write1h,rate.cacheWrite1h]];
  if(buckets.some(([count,price])=>count>0&&(price===undefined||price===null)))return {...base,note:'该用量分项的费率未配置'};
  if(selected.kind==='points') {
    const numerator=buckets.reduce((sum,[count,price])=>sum+BigInt(count)*BigInt(price??0),0n);
    const quantum=BigInt(rate.quantum??1);
    const points=ceilDiv(numerator,MILLION*quantum)*quantum;
    const cnyNano=ceilDiv(points*decimalUnits(book.chatboxCnyPerMillionPoints),MILLION);
    return {...base,amount:points.toString(),cnyNano:cnyNano.toString(),status:'estimated',note:[selected.rate.note,...notes].filter(Boolean).join('；')||null,conversionCnyPerMillion:book.chatboxCnyPerMillionPoints};
  }
  const numerator=buckets.reduce((sum,[count,price])=>sum+BigInt(count)*decimalUnits(price??0),0n);
  const cnyNano=ceilDiv(numerator,MILLION);
  return {...base,amount:cnyNano.toString(),cnyNano:cnyNano.toString(),status:'estimated',note:[selected.rate.note,...notes].filter(Boolean).join('；')||null};
}
function scheduledRate(rate,time) {
  const local=new Date(time+8*3600000),date=local.toISOString().slice(0,10),day=local.getUTCDay(),minutes=local.getUTCHours()*60+local.getUTCMinutes();
  const holiday=(rate.schedule.holidays||[]).includes(date);
  const peak=day>=1&&day<=5&&!holiday&&((minutes>=540&&minutes<720)||(minutes>=840&&minutes<1080));
  return {...rate,...rate.schedule[peak?'peak':'offPeak']};
}
