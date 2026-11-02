const React=require('react');
const {Tooltip}=require('@deepseek-ai/dsh-client-ui-primitives');
const {createElement:h,useState,useEffect,useRef,useId}=React;

function ReceiptIcon({size=16}){return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:'M6 3h12v18l-3-2-3 2-3-2-3 2V3Z'}),h('path',{d:'M9 7h6M9 11h6M9 15h3'}));}
function statTip(label,child){return h(Tooltip,{label,side:'top'},child);}

// This adapter is confined to one native turn footer. DSH has no fee seat inside
// TurnUsagePanel. Its existing button and dialog retain all behavior and styles.
function attachFee(root,record){
  let button,label,originalTitle,rendered,nativeText,popupRow,bodyObserver,scheduled=false,disposed=false;
  const explanation=feeExplanation(record),value=feeText(record?.quote);
  const patchDialog=()=>{
    if(!button?.getAttribute('aria-expanded')||button.getAttribute('aria-expanded')!=='true')return;
    const dialog=[...document.querySelectorAll('[role="dialog"]')].find(d=>/^(本轮用量|Turn usage)$/i.test(d.getAttribute('aria-label')??''));
    if(!dialog)return;
    if(popupRow?.parentNode===dialog)return;
    const header=dialog.firstElementChild;if(!header||header.children.length<2)return;
    popupRow=header.cloneNode(false);popupRow.dataset.billingFeeRow='true';popupRow.title=explanation;
    const left=header.children[0].cloneNode(false),right=header.children[1].cloneNode(false);
    const icon=header.children[0].querySelector('svg')?.cloneNode(true);if(icon)left.append(icon);left.append(document.createTextNode('计费'));right.textContent=value;
    popupRow.append(left,right);header.after(popupRow);
  };
  const refresh=()=>{
    scheduled=false;if(disposed)return;
    const candidate=[...root.querySelectorAll('button[aria-haspopup="dialog"]')].find(b=>/^(用量|Usage|Consumed)/.test(b.textContent.trim()));
    if(!candidate)return;
    if(candidate!==button){button=candidate;label=button.querySelector('span');originalTitle=button.getAttribute('title');rendered=undefined;}
    if(!label)return;
    if(label.textContent!==rendered)nativeText=label.textContent;
    const match=nativeText?.match(/^(用量|Usage|Consumed)\s*(.+)$/i);
    if(match){rendered=`${match[1]}\u2002计费 ${value}\u2002${match[2]}`;if(label.textContent!==rendered)label.textContent=rendered;button.title=explanation;}
    const open=button.getAttribute('aria-expanded')==='true';
    if(open){if(!bodyObserver){bodyObserver=new MutationObserver(patchDialog);bodyObserver.observe(document.body,{childList:true});}patchDialog();}
    else{bodyObserver?.disconnect();bodyObserver=undefined;popupRow?.remove();popupRow=undefined;}
  };
  const schedule=()=>{if(!scheduled&&!disposed){scheduled=true;queueMicrotask(refresh);}};
  const observer=new MutationObserver(schedule);observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-expanded']});refresh();
  return ()=>{disposed=true;observer.disconnect();bodyObserver?.disconnect();popupRow?.remove();if(label?.isConnected&&label.textContent===rendered)label.textContent=nativeText;if(button){if(originalTitle===null)button.removeAttribute('title');else if(originalTitle!==undefined)button.setAttribute('title',originalTitle);}};
}

function makeClient(ctx){
  const cache=new Map(),listeners=new Map(),batches=new Map();let active=true;
  const call=async(endpoint,payload,signal)=>{const r=await ctx.connection.rpc.call('/api',`billing-ledger.${endpoint}`,payload,signal);if(!r.ok)throw new Error(r.error?.message??'记账服务暂不可用');return r.value;};
  const ensureFee=(sessionId,seq)=>{
    const key=`${sessionId}:${seq}`;
    if(cache.has(key))return;
    let batch=batches.get(sessionId);if(batch){batch.add(seq);return;}
    batch=new Set([seq]);batches.set(sessionId,batch);
    queueMicrotask(async()=>{
      batches.delete(sessionId);try{const seqs=[...batch];for(let i=0;i<seqs.length;i+=200){const rows=await call('fees',{sessionId,seqs:seqs.slice(i,i+200)});if(!active)return;for(const row of rows){const k=`${sessionId}:${row.seq}`;cache.set(k,row.record);for(const notify of listeners.get(k)??[])notify(row.record);}}}
      catch(e){if(active)console.warn('[billing-ledger]',e.message);}
    });
  };
  function FooterFee({sessionId,seq}){
    const ref=useRef(null),[record,setRecord]=useState(()=>cache.get(`${sessionId}:${seq}`));
    useEffect(()=>{
      const key=`${sessionId}:${seq}`;let group=listeners.get(key);if(!group){group=new Set();listeners.set(key,group);}group.add(setRecord);setRecord(cache.get(key));ensureFee(sessionId,seq);
      // A just-settled output may render before its durable write has completed.
      const timer=setTimeout(()=>{if(!cache.get(key)){cache.delete(key);ensureFee(sessionId,seq);}},700);
      return ()=>{clearTimeout(timer);group.delete(setRecord);if(!group.size)listeners.delete(key);};
    },[sessionId,seq]);
    useEffect(()=>{const root=ref.current?.closest('[data-turn-tail]');if(root&&record!==undefined)return attachFee(root,record);},[record,seq]);
    return h('span',{ref,hidden:true,'data-billing-anchor':true});
  }
  function PieChart({title,subtitle,models,metric,unknown}){
    const ref=useRef(null),[visible,setVisible]=useState(false),[progress,setProgress]=useState(0),clipId=useId().replace(/:/g,'');
    const slices=pieSlices(models,metric),reduce=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
    useEffect(()=>{if(visible||!ref.current)return;const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting&&e.intersectionRatio>=.35)){setVisible(true);observer.disconnect();}},{threshold:.35,rootMargin:'0px 0px -24px 0px'});observer.observe(ref.current);return ()=>observer.disconnect();},[visible,slices.length>0]);
    useEffect(()=>{if(!visible)return;if(reduce){setProgress(1);return;}let frame,start;const tick=time=>{start??=time;const t=Math.min(1,(time-start)/900);setProgress(1-(1-t)**4);if(t<1)frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return ()=>cancelAnimationFrame(frame);},[visible,reduce]);
    const end=-Math.PI/2+Math.max(.000001,progress)*Math.PI*2;
    const reveal=progress>=.99999?null:`M100 100 L100 -8 A108 108 0 ${progress>.5?1:0} 1 ${100+108*Math.cos(end)} ${100+108*Math.sin(end)} Z`;
    return h('section',{className:`bl-chart bl-surface ${visible?'bl-visible':''}`,'data-billing-chart':metric},
      h('div',{className:'bl-section-heading'},h('h2',null,title),h('p',null,subtitle)),
      slices.length?h('div',{className:'bl-chart-content'},
        h('svg',{ref,className:'bl-pie',viewBox:'0 0 200 200',role:'img','aria-label':title},h('defs',null,h('clipPath',{id:clipId},reveal?h('path',{d:reveal}):h('circle',{cx:100,cy:100,r:108}))),
          h('g',{clipPath:`url(#${clipId})`},slices.map(s=>{const props={key:s.key,fill:s.color,className:'bl-slice',tabIndex:0,'aria-label':`${s.model} ${(s.share*100).toFixed(1)}%`};const tip=`${s.model} · ${s.provider}\n${(s.share*100).toFixed(1)}% · ${metric==='tokens'?numberText(s.tokens)+' tok':cnyText(s.cnyNano)+' CNY'}`;return s.path?h('path',{...props,d:s.path},h('title',null,tip)):h('circle',{...props,cx:100,cy:100,r:86},h('title',null,tip));}))),
        h('ul',{className:'bl-legend'},slices.map(s=>h('li',{key:s.key},statTip(`${s.provider}/${s.model} · ${metric==='tokens'?numberText(s.tokens)+' tok':cnyText(s.cnyNano)+' CNY'}`,h('span',{className:'bl-legend-model',tabIndex:0},h('i',{style:{background:s.color}}),h('span',null,s.model,h('small',null,s.provider)))),h('strong',null,`${(s.share*100).toFixed(1)}%`)))))
        :h('div',{className:'bl-empty-chart'},h('span',{className:'bl-empty-circle'}),h('p',null,metric==='tokens'?'此时段暂无已确认的 tokens 用量':'此时段暂无可计价的消耗')),
      unknown>0&&h('p',{className:'bl-chart-note'},`${unknown} 次${metric==='tokens'?'用量未返回':'调用待计价'}，未计入本图分母。`));
  }
  function LedgerPage(){
    const [preset,setPreset]=useState(30),[start,setStart]=useState(''),[end,setEnd]=useState(''),[data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0),page=useRef(null);
    useEffect(()=>{if(preset==='custom'&&(!start||!end)){setData(null);setError('');setLoading(false);return;}try{dateRange({preset,start,end});}catch(e){setData(null);setError(e.message);setLoading(false);return;}const controller=new AbortController();let alive=true;setLoading(true);setError('');
      call('summary',{preset,...preset==='custom'?{start,end}:{}},controller.signal).then(result=>{if(alive)setData(result);}).catch(e=>{if(alive&&!controller.signal.aborted){setData(null);setError(/transport|network|fetch/i.test(e.message)?'暂时无法读取账本，请稍后刷新。':e.message);}}).finally(()=>{if(alive)setLoading(false);});
      return ()=>{alive=false;controller.abort();};
    },[preset,start,end,refresh]);
    useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible')setRefresh(n=>n+1);},15000);return ()=>clearInterval(timer);},[]);
    const models=data?.models??[];
    return h('div',{className:'bl-page',ref:page},h('div',{className:'bl-page-inner'},
      h('header',{className:'bl-page-header'},h('div',null,h('div',{className:'bl-eyebrow'},h(ReceiptIcon,{size:15}),'本地记账'),h('h1',null,'用量账本'),h('p',null,'按实际调用的模型，记录每一次消耗。')),h('button',{className:'bl-refresh',onClick:()=>setRefresh(n=>n+1),disabled:loading,'aria-label':'刷新账本'},loading?'同步中…':'刷新')),
      h('div',{className:'bl-controls'},h('div',{className:'bl-presets',role:'group','aria-label':'统计时间跨度'},[[30,'最近 30 天'],[7,'最近 7 天'],['custom','自定义']].map(([value,label])=>h('button',{key:value,'aria-pressed':preset===value,onClick:()=>setPreset(value)},label))),
        preset==='custom'?h('div',{className:'bl-dates'},h('input',{type:'date','aria-label':'开始日期',value:start,max:end||undefined,onChange:e=>setStart(e.target.value)}),h('span',null,'至'),h('input',{type:'date','aria-label':'结束日期',value:end,min:start||undefined,max:start?maxCustomEnd(start):undefined,onChange:e=>setEnd(e.target.value)}),h('small',null,'最多 6 个月')):data&&h('span',{className:'bl-range'},`${data.range.startDate} — ${data.range.endDate}`)),
      error&&h('p',{className:'bl-error',role:'alert'},error),
      h('div',{'aria-busy':loading},data&&h(React.Fragment,null,
        h('div',{className:'bl-metrics'},h('div',null,h('span',null,'已知成本 · CNY'),h('strong',null,cnyText(data.totalCnyNano)),h('small',null,'Chatbox 按套餐额度折算')),h('div',null,h('span',null,'总用量 · tokens'),h('strong',null,numberText(data.totalTokens)),h('small',null,`${data.requests} 次模型调用`)),h('div',null,h('span',null,'已使用模型'),h('strong',null,models.length),h('small',null,'按模型与提供方区分'))),
        h('section',{className:'bl-models bl-surface'},h('div',{className:'bl-section-heading'},h('h2',null,'模型累计'),h('p',null,'Chatbox 显示点数，悬停查看折算成本；其它提供方显示 CNY。')),
          models.length?h('div',{className:'bl-model-list'},models.map(m=>h('div',{className:'bl-model-row',key:m.key},h('i',{className:'bl-model-dot',style:{background:colorFor(m.key)}}),h('div',{className:'bl-model-identity'},h('strong',null,m.model||'未知模型'),h('small',null,`${m.provider||'未知提供方'} · ${m.requests} 次调用 · ${numberText(m.tokens)} tok`)),
            statTip(m.isChatbox?`折算 ${cnyText(m.cnyNano)} CNY · 每百万点 ${data.conversionCnyPerMillion} CNY；各条账目按保存的换算率累计`:'按用量与已记录费率估算',h('div',{className:'bl-cost',tabIndex:0},h('strong',null,m.unknownCost===m.requests?'待计价':m.isChatbox?`${BigInt(m.points).toLocaleString('zh-CN')} 点`:`${cnyText(m.cnyNano)} CNY`),m.unknownCost>0&&m.unknownCost<m.requests&&h('small',null,`另 ${m.unknownCost} 次待计价`))))))
          :h('p',{className:'bl-empty'},'这个时段还没有模型调用。')),
        (data.unknownCost>0||data.unknownTokens>0)&&h('p',{className:'bl-note'},`${data.unknownCost} 次调用待计价，${data.unknownTokens} 次未返回完整用量。汇总与占比仅包含已确认数据。`),
        h(PieChart,{title:'Tokens 消耗占比',subtitle:'当前时间范围内，各模型的输入、缓存与输出总量。',models,metric:'tokens',unknown:data.unknownTokens}),
        h(PieChart,{title:'成本消耗占比',subtitle:'将 Chatbox 点数折算为 CNY，与其它模型的人民币费用统一比较。',models,metric:'cny',unknown:data.unknownCost}),
        h('footer',{className:'bl-page-footer'},h('p',null,`Chatbox 当前套餐均摊基准：每百万点 ${data.conversionCnyPerMillion} CNY。`),h('p',null,'费用为用量估算，套餐点数折算表示额度均摊成本。已记录费用保留结算时的费率。'),data.diagnostics?.map((d,i)=>h('p',{key:i,className:'bl-error'},d))))),
      !data&&!loading&&!error&&h('p',{className:'bl-empty'},preset==='custom'?'请选择开始和结束日期。':'正在读取账本…')));
  }
  ctx.effect(()=>()=>{active=false;cache.clear();listeners.clear();},'billing-ledger: client cleanup');
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'billing-ledger',order:10000,label:'记账'},ReceiptIcon));
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'billing-ledger'},LedgerPage));
  ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:'billing-ledger-fee',order:100},FooterFee));
}
exports.inject=['slots','connection','layout'];
exports.apply=makeClient;
