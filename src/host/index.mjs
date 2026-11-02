import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isAgentLoopRequest} from '@deepseek-ai/dsh-llm';
import {Ledger} from '../core/ledger.mjs';
import {validatePriceBook} from '../core/pricing.mjs';
import {callsFromEvents,eventCall,routeBefore,safeUsage} from '../core/records.mjs';

export const name='billing-ledger';
export const inject=['connection','sessions','llm','sessionPersistence'];
const defaultDataDir=()=>join(process.env.DSH_HOME||join(homedir(),'.dsh'),'storages','billing-ledger');
export async function apply(ctx,config={}){
  try{return await mount(ctx,config);}catch(error){
    const dir=resolve(config.dataDir??defaultDataDir());
    await mkdir(dir,{recursive:true});await writeFile(join(dir,'startup-error.log'),String(error.stack??error));throw error;
  }
}
async function mount(ctx,config){
  const dataDir=resolve(config.dataDir??defaultDataDir());
  const defaultBook=JSON.parse(await readFile(new URL('../../config/pricing.json',import.meta.url),'utf8'));
  let book=defaultBook;
  const pricingPath=config.pricingFile??join(dataDir,'pricing.json');
  try{const custom=JSON.parse(await readFile(pricingPath,'utf8'));book={...defaultBook,...custom,chatbox:{...defaultBook.chatbox,...custom.chatbox},cny:[...defaultBook.cny,...custom.cny??[]]};}catch(e){if(e.code!=='ENOENT')throw new Error('计费配置无法读取，请检查 pricing.json',{cause:e});}
  validatePriceBook(book);
  const ledger=new Ledger(join(dataDir,'ledger-v1.jsonl'),book);await ledger.load();
  const report=e=>{const message=`记账失败：${e.message}`;ctx.logger.warn(message);if(!ledger.diagnostics.includes(message))ledger.diagnostics.push(message);};
  const pending=new Set();let active=true,backfillComplete=false;
  const track=p=>{pending.add(p);void p.catch(report).finally(()=>pending.delete(p));return p;};
  const importSession=async(session,historical)=>{
    const events=session.log??session.events;
    const {calls,views}=callsFromEvents(session.id,events,session.inheritedEventCount??0);
    ledger.rememberViews(views);
    for(const call of calls)await ledger.put(call,{historical});
  };
  ctx.on('session/event',(session,event)=>{
    if(event.type!=='assistant/message'&&event.type!=='assistant/attempt'&&event.type!=='compaction/summary')return;
    // Auxiliary llm.stream calls are settled by the middleware below, including failures.
    if(event.type==='compaction/summary'&&event.data.llmStreamCall===true)return;
    const call=eventCall(session.id,event,routeBefore(session.log,event.seq));
    if(event.type==='assistant/message')ledger.rememberViews([{sessionId:session.id,seq:event.seq,id:call.id}]);
    track(ledger.put(call));
  });
  ctx.on('session/created',session=>{track(importSession(session,true));});
  ctx.on('llm/stream',(options,next)=>{
    const stream=next();if(isAgentLoopRequest(options))return stream;
    const session=options.sessionId&&ctx.sessions.get(options.sessionId),events=session?.log??[];
    const marker=options.purpose==='session-title'?events.findLast(e=>e.type==='session/title-llm-request'):options.purpose==='compaction'?events.findLast(e=>e.type==='compaction/start'):null;
    const id=marker?(options.purpose==='session-title'?`title:${options.sessionId}:${marker.seq}`:`compaction:${options.sessionId}:${marker.data.compactionId}`):`aux:${randomUUID()}`;
    const call={id,sessionId:options.sessionId??null,seq:marker?.seq??null,messageId:null,turn:null,step:null,time:Date.now(),provider:options.provider,model:options.model,purpose:options.purpose??'auxiliary'};
    return (async function*(){let usage,outcome='interrupted',seen=false;
      try{for await(const chunk of stream){seen=true;if(chunk.type==='usage')usage=safeUsage(chunk.usage);if(chunk.type==='finish')outcome=chunk.reason?.kind??'completed';yield chunk;}}
      finally{if(seen)track(ledger.put({...call,time:Date.now(),usage,outcome}));}
    })();
  });
  const ready=track((async()=>{
    try{
      const stored=await ctx.sessionPersistence.list();
      for(const row of stored){if(!active)break;let handle;
        try{handle=await ctx.sessionPersistence.open(row.header.id,'read');const slice=await handle.read();await importSession({id:handle.header.id,events:slice.events,inheritedEventCount:handle.inheritedEventCount},true);}
        catch(e){report(new Error(`历史会话 ${row.header.id} 未导入：${e.message}`));}finally{await handle?.close();}
      }
      for(const session of ctx.sessions.list())await importSession(session,true);
    }finally{backfillComplete=true;}
  })());
  const dispatch=async(endpoint,payload,signal)=>{
    try{
      signal.throwIfAborted();await ready;
      if(endpoint==='summary')return {ok:true,value:{...await ledger.snapshot(payload??{}),backfillComplete}};
      if(endpoint==='fees'){
        if(typeof payload?.sessionId!=='string'||!Array.isArray(payload.seqs)||payload.seqs.length>200||payload.seqs.some(x=>!Number.isSafeInteger(x)||x<0))throw new Error('无效的输出身份');
        return {ok:true,value:await ledger.fees(payload.sessionId,payload.seqs)};
      }
      return {ok:false,error:{code:'billing/not-found',message:'未知查询'}};
    }catch(e){return {ok:false,error:{code:'billing/query',message:e.message}};}
  };
  // Connection's owner-only exact Fetch seats share the native /api transport.
  // Its standalone rpc.handle route requires a private webServer injection in
  // this DSH release, so it cannot be used safely by an external plugin.
  for(const endpoint of ['summary','fees']){
    const method=`billing-ledger.${endpoint}`;
    ctx.connection.fetch.register({path:`/api/${method}`,methods:['POST'],requestBody:'buffered',async fetch(request){
      let message;try{message=await request.json();}catch{return new Response('invalid JSON',{status:400});}
      if(message?.type!=='client-request'||typeof message.rpcId!=='string'||message.rpcId.length>128||message.method!==method)return new Response('invalid request',{status:400});
      return Response.json({type:'server-response',rpcId:message.rpcId,result:await dispatch(endpoint,message.payload,request.signal)});
    }});
  }
  ctx.on('dispose',async()=>{active=false;await Promise.allSettled([...pending]);await ledger.queue;});
  ctx.logger.info(`计费账本已启用；费用快照 ${ledger.records.size} 条`);
}
