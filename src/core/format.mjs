export function numberText(value){return Number(value).toLocaleString('zh-CN');}
export function cnyText(value){
  const amount=BigInt(value??0),whole=amount/1000000000n,fraction=(amount%1000000000n).toString().padStart(9,'0');
  if(amount===0n)return '0.00';
  const first=fraction.search(/[1-9]/),places=whole===0n?Math.min(9,Math.max(3,first+3)):3;
  // Formatting only: records and sums always retain nano-CNY precision.
  const digits=fraction.slice(0,places).replace(/0+$/,'').padEnd(2,'0');
  return `${whole.toLocaleString('zh-CN')}.${digits}`;
}
export function feeText(quote){if(!quote||quote.amount===null)return '待计价';return quote.unit==='points'?`${BigInt(quote.amount).toLocaleString('zh-CN')} 点`:`${cnyText(quote.amount)} CNY`;}
export function feeExplanation(record){if(!record)return '当前输出费用尚未记录';const q=record.quote;return [`当前输出费用 · ${record.provider}/${record.model}`,q.status==='unknown'?'用量或费率不足':q.status==='actual'?'提供方返回的扣费':'按用量估算',record.historical?'历史回算':null,q.note].filter(Boolean).join('；');}
export function colorFor(key){
  let route;try{const [provider,model]=JSON.parse(key);route=`${provider.toLowerCase()}/${model.toLowerCase().replace(/[_.]/g,'-')}`;}catch{}
  const chosen={'chatbox/claude-fable-5-1':'#e29d8f','chatbox/claude-sonnet-5-5':'#b39ae3','chatbox/claude-opus-5-5':'#d9b278','chatbox/claude-haiku-5-5':'#76c6b0','chatbox/gemini-4-argon':'#7aa9dc','chatbox/grok-4-7':'#d592be','chatbox/gpt-6-1-sol':'#91a2df'};
  if(chosen[route])return chosen[route];
  let hash=2166136261;for(const c of key)hash=Math.imul(hash^c.charCodeAt(0),16777619);
  hash=Math.imul(hash^(hash>>>16),0x85ebca6b);hash=Math.imul(hash^(hash>>>13),0xc2b2ae35);hash^=hash>>>16;
  return `hsl(${(hash>>>0)%360} 56% 65%)`;
}
export function pieSlices(models,metric){
  const rows=models.map(m=>({...m,value:metric==='tokens'?Number(m.tokens):Number(BigInt(m.cnyNano))})).filter(m=>m.value>0);
  const total=rows.reduce((sum,m)=>sum+m.value,0);let angle=-Math.PI/2;
  return rows.map(m=>{const share=m.value/total,start=angle,end=angle+share*Math.PI*2;angle=end;const x=a=>100+86*Math.cos(a),y=a=>100+86*Math.sin(a);return {...m,share,color:colorFor(m.key),path:share>0.999999?null:`M 100 100 L ${x(start)} ${y(start)} A 86 86 0 ${share>0.5?1:0} 1 ${x(end)} ${y(end)} Z`};});
}
