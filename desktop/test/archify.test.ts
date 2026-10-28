import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {SkillLibrary} from '../src/skill-library.js';
import {SkillRegistry} from '../src/domain/tools.js';
import {Store} from '../src/harness/store.js';
import {createAgentTools} from '../src/agent-tools.js';
import {SearchService} from '../src/search.js';
import type {ToolServices} from '../src/activities/tools.js';
import type {Json} from '../src/harness/types.js';
import {workspaceFailure} from '../src/execution-environment.js';

test('workspace errors preserve server diagnostics instead of object coercion',()=>{
  assert.equal(workspaceFailure({error:{message:'Browser unavailable',code:'error',detail:''}}),'Browser unavailable');
  assert.equal(workspaceFailure({detail:'SSH disconnected'}),'SSH disconnected');
  assert.equal(workspaceFailure({error:{}}),'Workspace operation failed');
});

test('Archify catalogue is pinned, discoverable and loads resources progressively',()=>{
  const library=new SkillLibrary(resolve('skill-library'));
  const skill=library.skills.find(s=>s.name==='archify')!;
  assert.ok(skill);
  assert.equal(skill.runtime?.manager,'node');
  assert.equal(skill.license,'MIT');
  assert.match(skill.source,/208acba8d412335185b2056fedf54b3405df43fb/);
  assert.equal(library.stats().physicalReads,0);
  for(const query of ['架构图','流程图','单页说明'])assert.ok(library.search(query).some(s=>s.id===skill.id),query);
  for(const path of ['SKILL.md','EVE-UPSTREAM-LICENSE.txt','bin/archify.mjs','explainer/reader.js','references/delivery-contract.md']){
    assert.ok(library.read(skill.id,path).length>0,path);
  }
});

test('Archify preparation and execution use the bound SSH environment and a cached verified archive',async t=>{
  const home=mkdtempSync(join(tmpdir(),'eve-archify-')),store=new Store(':memory:');
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const skills=new SkillRegistry({home,store});skills.mountLibrary(resolve('skill-library'));
  const skill=skills.list().find(s=>s.name==='archify')!;
  const calls:Array<{operation:string,args:Record<string,Json>}>=[];
  const environment={kind:'ssh' as const,call:async(operation:string,args:Record<string,Json>)=>{
    calls.push({operation,args});return {ok:true,execution_target:{kind:'ssh'}};
  }};
  const tools=createAgentTools({skills} as ToolServices,new SearchService(),[],undefined,[],environment,'ask');
  await assert.rejects(tools.execute('skill_run',{id:skill.id,input:{}},AbortSignal.timeout(5000)),/Load/);
  await tools.execute('skill_load',{id:skill.id},AbortSignal.timeout(5000));
  const loaded=skills.load(skill.id) as any;
  assert.equal(loaded.run.language,'node');
  await tools.execute('skill_prepare',{id:skill.id},AbortSignal.timeout(5000));
  await tools.execute('skill_run',{id:skill.id,input:{command:'finalize',type:'workflow',candidate:'candidate.json',output:'.archify/test/index.html'}},AbortSignal.timeout(5000));
  assert.deepEqual(calls.map(c=>c.operation),['prepare_archify','run_archify']);
  assert.equal(calls[0].args.bundle,calls[1].args.bundle,'compression reused between prepare and run');
  const bundle=calls[1].args.bundle as any;
  const archive=Buffer.from(bundle.archive,'base64');
  assert.equal(createHash('sha256').update(archive).digest('hex'),bundle.archiveSha256);
  const resources=JSON.parse(gunzipSync(archive).toString()) as Array<{path:string,content:string,sha256:string}>;
  assert.equal(resources.length,189);
  for(const file of resources)assert.equal(createHash('sha256').update(file.content).digest('hex'),file.sha256);
  await skills.enable(skill.id,false);
  await assert.rejects(tools.execute('skill_run',{id:skill.id,input:{}},AbortSignal.timeout(5000)),/disabled/);
});

test('Archify cannot execute without a bound workspace or silently use a local worker',async t=>{
  const home=mkdtempSync(join(tmpdir(),'eve-archify-no-backend-')),store=new Store(':memory:');
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const skills=new SkillRegistry({home,store});skills.mountLibrary(resolve('skill-library'));
  const skill=skills.list().find(s=>s.name==='archify')!;
  const tools=createAgentTools({skills} as ToolServices,new SearchService(),[],undefined,[],undefined,'full');
  await tools.execute('skill_load',{id:skill.id},AbortSignal.timeout(5000));
  await assert.rejects(tools.execute('skill_run',{id:skill.id,input:{}},AbortSignal.timeout(5000)),/bound workspace/);
});
