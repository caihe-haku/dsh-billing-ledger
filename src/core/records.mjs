// Consume only routing and accounting metadata, never prompts or replay state.
export function lastUsage(stream){
  if(!Array.isArray(stream))return undefined;
  return stream.findLast(r=>r?.type==='chunk'&&r.chunk?.type==='usage')?.chunk.usage;
}
export function safeUsage(raw){
  if(!raw||typeof raw!=='object')return undefined;
  const out={};
  for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','cacheWrite1hTokens','reasoningTokens','totalTokens'])if(raw[k]!==undefined)out[k]=raw[k];
  return out;
}
export function eventCall(sessionId,event,route){
  const d=event.data??{};
  if(event.type==='assistant/message'||event.type==='assistant/attempt'){
    const source=d.message?.source??route??{};
    return {id:d.message?.id?`message:${d.message.id}`:`attempt:${sessionId}:${event.seq}`,sessionId,seq:event.seq,messageId:d.message?.id??null,turn:d.turn??null,step:d.step??null,time:event.time,provider:source.provider??'',model:source.model??'',purpose:'conversation',outcome:d.interrupted?'interrupted':event.type==='assistant/attempt'?'attempt':'completed',usage:safeUsage(d.usage??lastUsage(d.stream))};
  }
  if(event.type==='compaction/summary')return {id:`compaction:${sessionId}:${d.compactionId}`,sessionId,seq:event.seq,messageId:null,turn:null,step:null,time:event.time,provider:d.provider??'',model:d.model??'',purpose:'compaction',outcome:'completed',usage:safeUsage(d.usage)};
  if(event.type==='session/title-llm-request')return {id:`title:${sessionId}:${event.seq}`,sessionId,seq:event.seq,messageId:null,turn:null,step:null,time:event.time,provider:d.route?.provider??'',model:d.route?.model??'',purpose:'session-title',outcome:'unreported',usage:undefined};
  return null;
}
export function routeBefore(events,seq){
  for(let i=Math.min(seq-1,events.length-1);i>=0;i--)if(events[i].type==='request/header')return events[i].data?.header?.config;
}
export function callsFromEvents(sessionId,events,inheritedEventCount=0){
  let route;const calls=[],views=[];
  for(const event of events){
    if(event.type==='request/header')route=event.data?.header?.config;
    const call=eventCall(sessionId,event,route);if(!call)continue;
    if(event.type==='assistant/message')views.push({sessionId,seq:event.seq,id:call.id});
    if(event.seq>=inheritedEventCount)calls.push(call);
  }
  return {calls,views};
}
