import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createAgentTools} from '../src/agent-tools.js';
import {SkillRegistry} from '../src/domain/tools.js';
import {Store} from '../src/harness/store.js';
import {SearchService} from '../src/search.js';
import type {ToolServices} from '../src/activities/tools.js';
import type {Json} from '../src/harness/types.js';

test('wish tools are discoverable, read-only where declared, and route through the bound workspace',async t=>{
  const home=mkdtempSync(join(tmpdir(),'eve-wish-tools-')),store=new Store(':memory:');
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const skills=new SkillRegistry({home,store});
  const calls:Array<{operation:string,args:Record<string,Json>}>= [];
  const environment={kind:'local' as const,call:async(operation:string,args:Record<string,Json>):Promise<Json>=>{
    calls.push({operation,args});
    return {id:'wish_test',status:'active',operation};
  }};
  const tools=createAgentTools({skills} as ToolServices,new SearchService(),[],undefined,[],environment,'ask');
  for(const name of ['wish_status','wish_start','wish_update','wish_record','wish_block']){
    assert.ok(tools.names().includes(name),name);
    assert.ok(tools.definition(name)?.description.length,name);
  }
  assert.equal(tools.readOnly('wish_status'),true);
  assert.equal(tools.readOnly('wish_record'),false);
  await tools.execute('wish_status',{},AbortSignal.timeout(5000));
  await tools.execute('wish_start',{wish:'Find a reproducible disease-associated cell state.'},AbortSignal.timeout(5000));
  assert.deepEqual(calls.map(call=>call.operation),['wish_status','wish_start']);
  assert.equal(calls[1].args.wish,'Find a reproducible disease-associated cell state.');
});
