const DAY=86400000;
export function shanghaiDate(time=Date.now()){return new Date(time+8*3600000).toISOString().slice(0,10);}
function dayStart(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('请选择有效日期');const t=Date.parse(value+'T00:00:00+08:00');if(!Number.isFinite(t)||shanghaiDate(t)!==value)throw new Error('请选择有效日期');return t;}
export function maxCustomEnd(start){
  dayStart(start);
  const [y,m,d]=start.split('-').map(Number),target=new Date(Date.UTC(y,m-1+6,1));
  const lastDay=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  return shanghaiDate(Date.UTC(target.getUTCFullYear(),target.getUTCMonth(),Math.min(d,lastDay))-8*3600000);
}
export function dateRange({preset=30,start,end}={},now=Date.now()) {
  if(preset!=='custom'){
    if(preset!==7&&preset!==30)throw new Error('仅支持7天或30天预设');
    const last=dayStart(shanghaiDate(now));return {start:last-(preset-1)*DAY,end:last+DAY,startDate:shanghaiDate(last-(preset-1)*DAY),endDate:shanghaiDate(last)};
  }
  const first=dayStart(start),last=dayStart(end);
  if(first>last)throw new Error('结束日期不能早于开始日期');
  const maximum=dayStart(maxCustomEnd(start));
  if(last>maximum)throw new Error('自定义时间跨度不能超过6个月');
  return {start:first,end:last+DAY,startDate:start,endDate:end};
}
export function summarize(records,range) {
  const models=new Map();let unknownCost=0,unknownTokens=0,requests=0;
  for(const row of records){if(row.time<range.start||row.time>=range.end)continue;requests++;
    const key=JSON.stringify([row.provider,row.model]);let m=models.get(key);
    if(!m){m={key,provider:row.provider,model:row.model,requests:0,tokens:0,unknownTokens:0,points:0n,cny:0n,unknownCost:0,isChatbox:row.quote.unit==='points'};models.set(key,m);}
    m.requests++;if(row.quote.usage.total===null||!row.quote.usage.known){m.unknownTokens++;unknownTokens++;}else m.tokens+=row.quote.usage.total;
    if(row.quote.cnyNano===null){m.unknownCost++;unknownCost++;}else{m.cny+=BigInt(row.quote.cnyNano);if(m.isChatbox)m.points+=BigInt(row.quote.amount);}
  }
  const rows=[...models.values()].map(m=>({...m,points:m.points.toString(),cnyNano:m.cny.toString(),cny:undefined}));
  const totalTokens=rows.reduce((s,m)=>s+m.tokens,0),totalCny=rows.reduce((s,m)=>s+BigInt(m.cnyNano),0n);
  return {range,requests,unknownCost,unknownTokens,totalTokens,totalCnyNano:totalCny.toString(),models:rows.sort((a,b)=>BigInt(a.cnyNano)===BigInt(b.cnyNano)?b.tokens-a.tokens:BigInt(a.cnyNano)>BigInt(b.cnyNano)?-1:1)};
}
