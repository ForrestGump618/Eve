import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTools} from '../src/agent-tools.js';
import {SearchService} from '../src/search.js';
import type {ToolServices} from '../src/activities/tools.js';

test('agent RSI inspection is read-only; evaluation requires bound task authorization',async()=>{
 let runs=0;
 const services={rsi:{list:()=>[{id:'recorded-run'}],run:async()=>{runs++;return {id:'evaluated-run',status:'review'};}}} as unknown as ToolServices;
 const signal=AbortSignal.timeout(5000);
 const unbound=createAgentTools(services,new SearchService(),[]);
 assert.equal((await unbound.execute('rsi_status',{},signal) as any).runs[0].id,'recorded-run');
 await assert.rejects(unbound.execute('rsi_evaluate',{kind:'prompt'},signal),/Approval channel unavailable/);
 assert.equal(runs,0);
 let denied=true;
 const bound=createAgentTools(services,new SearchService(),[],undefined,[],{kind:'local',call:async op=>{
  assert.equal(op,'authorize');if(denied)throw Error('User declined');return {approved:true};
 }});
 await assert.rejects(bound.execute('rsi_evaluate',{kind:'prompt'},signal),/declined/);
 assert.equal(runs,0);denied=false;
 assert.equal((await bound.execute('rsi_evaluate',{kind:'prompt'},signal) as any).run.status,'review');
 assert.equal(runs,1);
 assert.ok(!bound.definitions().some(tool=>tool.name==='rsi_promote'));
});
