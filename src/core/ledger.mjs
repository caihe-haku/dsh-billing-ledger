import {mkdir,readFile,open} from 'node:fs/promises';
import {dirname} from 'node:path';
import {quoteUsage} from './pricing.mjs';
import {dateRange,summarize} from './statistics.mjs';

export class Ledger {
  records=new Map();views=new Map();queue=Promise.resolve();revision=0;diagnostics=[];
  constructor(file,book){this.file=file;this.book=book;}
  async load(){
    await mkdir(dirname(this.file),{recursive:true});
    let raw;try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
    const lines=raw.split('\n');
    for(let i=0;i<lines.length;i++){
      if(!lines[i].trim())continue;
      try{const r=JSON.parse(lines[i]);if(r.schema!==1||typeof r.id!=='string'||!Number.isSafeInteger(r.time)||!r.quote||!['points','CNY'].includes(r.quote.unit))throw new Error('记录格式无效');this.records.set(r.id,r);}
      catch{this.diagnostics.push(`账本第${i+1}行无法读取，原文件已保留`);}
    }
    // Never append onto a partial record: preserve evidence and stop writes until repaired.
    this.tornTail=raw.length>0&&!raw.endsWith('\n');
    if(this.tornTail)this.diagnostics.push('账本末行不完整，已暂停写入；请保留原文件后修复');
    this.revision=this.records.size;
  }
  rememberViews(views){for(const v of views)this.views.set(`${v.sessionId}:${v.seq}`,v.id);}
  put(call,{historical=false}={}){
    const operation=this.queue.then(async()=>{
      const existing=this.records.get(call.id);if(existing)return existing;
      if(this.tornTail)throw new Error('账本末行不完整，拒绝覆盖原记录');
      const quote=quoteUsage(this.book,call);
      const record={schema:1,...call,usage:call.usage??null,quote,historical,recordedAt:Date.now()};
      const h=await open(this.file,'a');try{await h.writeFile(JSON.stringify(record)+'\n','utf8');await h.sync();}finally{await h.close();}
      this.records.set(record.id,record);this.revision++;
      return record;
    });
    this.queue=operation.catch(()=>{});return operation;
  }
  async snapshot(query){await this.queue;return {...summarize(this.records.values(),dateRange(query)),revision:this.revision,diagnostics:[...this.diagnostics],pricingVersion:this.book.version,conversionCnyPerMillion:this.book.chatboxCnyPerMillionPoints};}
  async fees(sessionId,seqs){
    await this.queue;
    return seqs.map(seq=>{const id=this.views.get(`${sessionId}:${seq}`),r=id&&this.records.get(id);return {seq,record:r?{id:r.id,provider:r.provider,model:r.model,time:r.time,quote:r.quote,historical:r.historical}:null};});
  }
}
