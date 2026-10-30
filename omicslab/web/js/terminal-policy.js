// Transport units are UTF-16 code units, matching JavaScript string.length.
export const terminalPolicy=Object.freeze({
 maxSessions:8,
 cols:100,rows:30,scrollback:3000,fontSize:13,
 flowProtocol:'ack-v1',
 maxBufferedUnits:524288,batchUnits:32768,maxPendingPackets:8192,coalesceMs:4,drainBudgetMs:8,
 rendererTimeoutMs:30000,scriptTimeoutMs:15000,connectTimeoutMs:20000,
 retry:Object.freeze({attempts:3,baseMs:1500,maxMs:15000,stableMs:60000}),
});

export function terminalAppearance(styles){
 const token=name=>styles.getPropertyValue(name).trim();
 const colors={
  background:'--panel',foreground:'--text',cursor:'--text',cursorAccent:'--panel',
 selectionBackground:'--selection-bg',selectionInactiveBackground:'--accent-soft',
  black:'--bg-deep',brightBlack:'--text-3',red:'--red',brightRed:'--red',
  green:'--green',brightGreen:'--green',yellow:'--amber',brightYellow:'--amber',
  blue:'--blue',brightBlue:'--blue',magenta:'--accent',brightMagenta:'--accent',
  cyan:'--accent-2',brightCyan:'--accent-2',white:'--text-2',brightWhite:'--text',
 };
 return {theme:Object.fromEntries(Object.entries(colors).map(([key,name])=>[key,token(name)]).filter(([,value])=>value)),
  fontFamily:token('--font-mono')||'monospace'};
}

/** One xterm write at a time; ACK only after its parser's completion callback. */
export class TerminalOutputBuffer{
 constructor({write,acknowledge,onError,policy=terminalPolicy}){
  this.write=write;this.acknowledge=acknowledge;this.onError=onError;this.policy=policy;
  this.queue=[];this.head=0;this.bufferedUnits=0;this.received=0;
  this.flow=false;this.disposed=false;this.writing=false;this.timer=0;this.watchdog=0;
  this.flushing=false;this.drainStarted=null;
 }
 negotiate(flow){
  if(!flow)return;
  if(flow.protocol!==this.policy.flowProtocol||flow.unit!=='utf16'||
     !Number.isSafeInteger(flow.window)||flow.window<=0||flow.window>this.policy.maxBufferedUnits||
     !Number.isSafeInteger(flow.frame)||flow.frame<=0||flow.frame>flow.window){
   this.fail('Unsupported terminal flow control');return;
  }
  this.flow=true;
 }
 enqueue(data,seq){
  if(this.disposed)return false;
  if(typeof data!=='string'){this.fail('Invalid terminal output');return false;}
  if(this.flow&&(!Number.isSafeInteger(seq)||seq!==this.received+data.length)){
   this.fail('Invalid terminal output sequence');return false;
  }
  if(!data.length)return true;
  if(this.bufferedUnits+data.length>this.policy.maxBufferedUnits||
     this.queue.length-this.head>=this.policy.maxPendingPackets){
   this.fail('Terminal output buffer exceeded; reconnect to start a new session');return false;
  }
  if(this.flow)this.received=seq;
  this.bufferedUnits+=data.length;this.queue.push({data,seq:this.flow?seq:undefined});
  this.schedule();return true;
 }
 notice(text){
  // Local notices share the same bounded writer but do not consume server credit.
  const flow=this.flow;this.flow=false;
  const result=this.enqueue(text);this.flow=flow;return result;
 }
 schedule(){
  if(!this.disposed&&!this.writing&&!this.timer&&this.head<this.queue.length){
   this.timer=setTimeout(()=>{this.timer=0;this.flush();},this.policy.coalesceMs);
  }
 }
 flush(){
  if(this.disposed||this.writing)return;
  if(this.drainStarted===null)this.drainStarted=performance.now();
  const parts=[];let units=0,seq;
  while(this.head<this.queue.length&&units<this.policy.batchUnits){
   const item=this.queue[this.head];
   let take=Math.min(item.data.length,this.policy.batchUnits-units);
   // Keep astral characters intact when a legacy server sends a large frame.
   if(take<item.data.length&&take>0&&/[\uD800-\uDBFF]/.test(item.data[take-1]))take--;
   if(!take)break;
   parts.push(item.data.slice(0,take));units+=take;
   if(take===item.data.length){if(item.seq!==undefined)seq=item.seq;this.head++;}
   else item.data=item.data.slice(take);
  }
  if(this.head){this.queue=this.queue.slice(this.head);this.head=0;}
  if(!units)return;
  this.writing=true;
  this.watchdog=setTimeout(()=>this.fail('Terminal renderer stalled; reconnect to start a new session'),this.policy.rendererTimeoutMs);
  this.flushing=true;
  try{
   this.write(parts.join(''),()=>{
    if(this.disposed)return;
    clearTimeout(this.watchdog);this.watchdog=0;this.bufferedUnits-=units;
    // ACK can synchronously refill the queue; keep it in the current drain.
    if(seq!==undefined)this.acknowledge(seq);
    if(this.disposed)return;
    if(!this.queue.length){this.writing=false;this.drainStarted=null;return;}
    if(performance.now()-this.drainStarted>=this.policy.drainBudgetMs){
     // A task boundary lets input and painting run even for synchronous writers.
     this.timer=setTimeout(()=>{this.timer=0;this.writing=false;this.drainStarted=null;this.flush();},0);
    }else if(this.flushing){
     queueMicrotask(()=>{if(!this.disposed){this.writing=false;this.flush();}});
    }else{
     // xterm can consume the next batch inside its existing parser time slice.
     this.writing=false;this.flush();
    }
   });
  }catch{this.fail('Terminal renderer failed');}
  finally{this.flushing=false;}
 }
 fail(message){if(this.disposed)return;this.dispose();this.onError(message);}
 dispose(){
  this.disposed=true;clearTimeout(this.timer);clearTimeout(this.watchdog);
  this.timer=0;this.watchdog=0;this.queue=[];this.head=0;this.bufferedUnits=0;this.writing=false;
  this.drainStarted=null;
 }
}
