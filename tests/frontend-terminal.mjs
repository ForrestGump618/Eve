// Run with: node --test tests/frontend-terminal.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const source=await readFile(new URL('../omicslab/web/js/terminal-policy.js',import.meta.url),'utf8');
const {TerminalOutputBuffer,terminalPolicy,terminalAppearance}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const flow={protocol:'ack-v1',unit:'utf16',window:131072,frame:16384};

function fixture(t,policy=terminalPolicy){
 t.mock.timers.enable({apis:['setTimeout']});
 const writes=[],acks=[],errors=[],callbacks=[];
 let active=0,peak=0,clock=0;
 t.mock.method(performance,'now',()=>clock);
 const buffer=new TerminalOutputBuffer({policy,
  write:(data,done)=>{writes.push(data);active++;peak=Math.max(peak,active);callbacks.push(()=>{active--;done();});},
  acknowledge:seq=>acks.push(seq),onError:message=>errors.push(message),
 });
 t.after(()=>buffer.dispose());
 return {buffer,writes,acks,errors,callbacks,get peak(){return peak;},
  elapse:ms=>{clock+=ms;},
  tick:()=>t.mock.timers.tick(policy.coalesceMs),complete:()=>{const cb=callbacks.shift();assert.ok(cb);cb();}};
}

test('burst output is coalesced, bounded by credit and acknowledged only after parsing',t=>{
 const f=fixture(t);f.buffer.negotiate(flow);
 const expected=('\x1b[32m\u7814\u7a76 \u{1f9ec} result\x1b[0m\r\n').repeat(100000);
 let offset=0,lastAck=0,packets=0,peakBuffered=0;
 while(offset<expected.length||f.buffer.bufferedUnits){
  lastAck=f.acks.at(-1)||0;
  while(offset<expected.length&&offset-lastAck<flow.window){
   const size=Math.min(37+packets%83,flow.window-(offset-lastAck),expected.length-offset);
   const data=expected.slice(offset,offset+size);offset+=size;packets++;
   assert.equal(f.buffer.enqueue(data,offset),true);
   peakBuffered=Math.max(peakBuffered,f.buffer.bufferedUnits);
  }
  const ackBefore=f.acks.at(-1);
  f.tick();assert.equal(f.acks.at(-1),ackBefore);
  assert.equal(f.callbacks.length,1);
  f.complete();
 }
 assert.deepEqual(f.errors,[]);
 assert.equal(f.writes.join(''),expected);
 assert.equal(f.acks.at(-1),expected.length);
 assert.equal(f.peak,1);
 assert.ok(peakBuffered<=flow.window);
 assert.ok(f.writes.every(data=>data.length<=terminalPolicy.batchUnits));
 assert.ok(f.writes.length<packets/50);
});

test('legacy oversized packet is sliced losslessly with no ACK and one write at a time',t=>{
 const f=fixture(t);
 const text=('x\u{1f9ec}').repeat(50000);
 f.buffer.enqueue(text);
 while(f.buffer.bufferedUnits){f.tick();f.complete();}
 assert.equal(f.writes.join(''),text);
 assert.equal(f.peak,1);assert.deepEqual(f.acks,[]);
 assert.ok(f.writes.every(data=>!/[\uD800-\uDBFF]$/.test(data)));
});

test('local notices preserve ordering and do not count toward server ACKs',t=>{
 const f=fixture(t);f.buffer.negotiate(flow);
 f.buffer.enqueue('first',5);f.buffer.notice('\r\nnotice\r\n');f.buffer.enqueue('last',9);
 f.tick();assert.deepEqual(f.acks,[]);f.complete();
 assert.equal(f.writes.join(''),'first\r\nnotice\r\nlast');assert.deepEqual(f.acks,[9]);
});

test('legacy overflow closes explicitly instead of retaining an unbounded queue',t=>{
 const f=fixture(t);
 assert.equal(f.buffer.enqueue('x'.repeat(terminalPolicy.maxBufferedUnits+1)),false);
 assert.equal(f.errors.length,1);assert.equal(f.buffer.bufferedUnits,0);
 f.tick();assert.equal(f.writes.length,0);
});

test('many tiny legacy packets have a bounded packet count',t=>{
 const f=fixture(t);
 for(let i=0;i<terminalPolicy.maxPendingPackets;i++)assert.equal(f.buffer.enqueue('x'),true);
 assert.equal(f.buffer.enqueue('x'),false);assert.equal(f.errors.length,1);
});

test('dispose cancels scheduled output and suppresses late parser callbacks and ACKs',t=>{
 const f=fixture(t);f.buffer.negotiate(flow);
 f.buffer.enqueue('first',5);f.tick();
 f.buffer.enqueue('pending',12);f.buffer.dispose();f.complete();
 t.mock.timers.tick(terminalPolicy.rendererTimeoutMs*2);
 assert.deepEqual(f.writes,['first']);assert.deepEqual(f.acks,[]);assert.deepEqual(f.errors,[]);
 assert.equal(f.buffer.bufferedUnits,0);assert.equal(f.buffer.queue.length,0);
});

test('dispose before scheduled flush prevents any renderer write',t=>{
 const f=fixture(t);f.buffer.enqueue('pending');f.buffer.dispose();f.tick();
 assert.deepEqual(f.writes,[]);
});

test('renderer watchdog fails a stuck parser without a false ACK',t=>{
 const f=fixture(t);f.buffer.negotiate(flow);f.buffer.enqueue('stuck',5);f.tick();
 t.mock.timers.tick(terminalPolicy.rendererTimeoutMs);
 assert.equal(f.errors.length,1);assert.deepEqual(f.acks,[]);assert.equal(f.buffer.bufferedUnits,0);
 f.complete();assert.deepEqual(f.acks,[]);
});

test('sequence and negotiation validation reject future/invalid output',t=>{
 const f=fixture(t);f.buffer.negotiate(flow);
 assert.equal(f.buffer.enqueue('out',999),false);assert.equal(f.errors.length,1);
});

test('unsupported negotiation cannot expand the browser budget',t=>{
 const f=fixture(t);f.buffer.negotiate({...flow,window:terminalPolicy.maxBufferedUnits+1});
 assert.equal(f.errors.length,1);assert.equal(f.buffer.disposed,true);
});

test('appearance reads existing CSS tokens for light and dark themes',()=>{
 for(const prefix of ['light','dark']){
  const appearance=terminalAppearance({getPropertyValue:name=>`${prefix}:${name}`});
  assert.equal(appearance.theme.background,`${prefix}:--panel`);
  assert.equal(appearance.theme.selectionBackground,`${prefix}:--selection-bg`);
  assert.equal(appearance.theme.red,`${prefix}:--red`);
  assert.equal(appearance.fontFamily,`${prefix}:--font-mono`);
 }
});

test('ACK refills drain immediately without another coalescing timer',t=>{
 const f=fixture(t,{...terminalPolicy,batchUnits:4});f.buffer.negotiate(flow);
 f.buffer.acknowledge=seq=>{
  f.acks.push(seq);
  if(seq<12)f.buffer.enqueue('next',seq+4);
 };
 f.buffer.enqueue('init',4);f.tick();
 f.complete();assert.deepEqual(f.writes,['init','next']);assert.equal(f.buffer.timer,0);
 f.complete();assert.deepEqual(f.writes,['init','next','next']);assert.equal(f.buffer.timer,0);
 f.complete();assert.deepEqual(f.acks,[4,8,12]);assert.equal(f.peak,1);
 assert.equal(f.buffer.writing,false);assert.equal(f.buffer.bufferedUnits,0);
 // A later idle-to-active transition gets its own coalescing interval.
 f.buffer.enqueue('idle',16);assert.equal(f.writes.length,3);f.tick();
 assert.equal(f.writes.at(-1),'idle');
});

test('a continuous drain yields to browser tasks after its work budget',async t=>{
 const f=fixture(t,{...terminalPolicy,batchUnits:4});
 f.buffer.enqueue('first-second');f.tick();
 f.elapse(terminalPolicy.drainBudgetMs);
 let browserTask=false;setTimeout(()=>{browserTask=true;},0);
 f.complete();
 await Promise.resolve();
 assert.equal(f.writes.length,1);assert.equal(browserTask,false);assert.equal(f.buffer.writing,true);
 t.mock.timers.tick(0);
 assert.equal(browserTask,true);assert.equal(f.writes.length,2);
 f.complete();assert.equal(f.writes.length,3);f.complete();
 assert.equal(f.writes.join(''),'first-second');assert.equal(f.peak,1);
});

test('dispose cancels the pending task yield before the next write',t=>{
 const f=fixture(t,{...terminalPolicy,batchUnits:4});
 f.buffer.enqueue('abcdefgh');f.tick();f.elapse(terminalPolicy.drainBudgetMs);f.complete();
 f.buffer.dispose();t.mock.timers.tick(0);
 assert.deepEqual(f.writes,['abcd']);assert.deepEqual(f.errors,[]);assert.equal(f.buffer.bufferedUnits,0);
});

test('synchronous parser completion drains without recursive writes',async t=>{
 const f=fixture(t,{...terminalPolicy,batchUnits:4});
 let depth=0,peakDepth=0;
 f.buffer.write=(data,done)=>{
  depth++;peakDepth=Math.max(peakDepth,depth);f.writes.push(data);done();depth--;
 };
 f.buffer.enqueue('abcdefghijkl');f.tick();
 assert.deepEqual(f.writes,['abcd']);
 await Promise.resolve();assert.deepEqual(f.writes,['abcd','efgh']);
 await Promise.resolve();assert.deepEqual(f.writes,['abcd','efgh','ijkl']);
 assert.equal(peakDepth,1);assert.equal(f.buffer.bufferedUnits,0);
});

test('dispose makes a queued synchronous-parser microtask inert',async t=>{
 const f=fixture(t,{...terminalPolicy,batchUnits:4});
 f.buffer.write=(data,done)=>{f.writes.push(data);done();};
 f.buffer.enqueue('abcdefgh');f.tick();f.buffer.dispose();
 await Promise.resolve();
 assert.deepEqual(f.writes,['abcd']);assert.deepEqual(f.errors,[]);
});
