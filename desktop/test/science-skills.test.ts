import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {SkillLibrary} from '../src/skill-library.js';
import {SkillRegistry} from '../src/domain/tools.js';
import {Store} from '../src/harness/store.js';
import {createAgentTools} from '../src/agent-tools.js';
import {SearchService} from '../src/search.js';
import type {ToolServices} from '../src/activities/tools.js';
import type {Json} from '../src/harness/types.js';

test('all science skills retain runnable scripts, legal notices and pinned metadata',()=>{
  const library=new SkillLibrary(resolve('skill-library'));
  const science=library.skills.filter(s=>s.bundle==='science');
  assert.equal(science.length,40);
  assert.equal(science.reduce((n,s)=>n+s.runtime!.scripts.length,0),65);
  assert.equal(library.stats().physicalReads,0);
  for(const skill of science){
    assert.match(skill.source,/4de6786171f1479026da5d3a00f110703c8ba35e/);
    assert.equal(skill.license,'Apache-2.0 AND CC-BY-4.0');
    for(const entry of ['SKILL.md','EVE-UPSTREAM-LICENSE.txt','EVE-MATERIALS-LICENSE.txt','EVE-DATA-SOURCE-TERMS.md',...skill.runtime!.scripts]){
      assert.ok(library.read(skill.id,entry).length>0);
    }
  }
  for(const query of ['遗传变异','组织表达','药物靶点','结构可视化']){
    assert.ok(library.search(query).some(s=>library.get(s.id).bundle==='science'),query);
  }
});

test('scientific execution requires loading and stays on the bound SSH environment',async t=>{
  const home=mkdtempSync(join(tmpdir(),'eve-science-registry-')),store=new Store(':memory:');
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const skills=new SkillRegistry({home,store});skills.mountLibrary(resolve('skill-library'));
  const skill=skills.list().find(s=>s.name==='science-pubmed-database')!;
  assert.ok(skill?.executable);
  const calls:Array<{operation:string,args:Record<string,Json>}>=[];
  const environment={kind:'ssh' as const,call:async(operation:string,args:Record<string,Json>)=>{
    calls.push({operation,args});return {status:operation==='prepare_science_skill'?'prepared':'executed',execution_target:{kind:'ssh'}};
  }};
  const tools=createAgentTools({skills} as ToolServices,new SearchService(),[],undefined,[],environment,'ask');
  await assert.rejects(tools.execute('skill_run',{id:skill.id,input:{script:'scripts/pubmed_api.py'}},AbortSignal.timeout(5000)),/Load/);
  await tools.execute('skill_load',{id:skill.id},AbortSignal.timeout(5000));
  const loaded=skills.load(skill.id) as any;
  assert.equal(loaded.run.language,'uv');
  assert.deepEqual(loaded.preparation.requiredCredentials,[]);
  await tools.execute('skill_prepare',{id:skill.id},AbortSignal.timeout(5000));
  await tools.execute('skill_run',{id:skill.id,input:{script:'scripts/pubmed_api.py',args:['--help']}},AbortSignal.timeout(5000));
  assert.deepEqual(calls.map(c=>c.operation),['prepare_science_skill','run_science_skill']);
  const bundle=calls[1].args.bundle as any;
  assert.ok(bundle.files.some((f:any)=>f.path==='scripts/pubmed_api.py'));
  await skills.enable(skill.id,false);
  await assert.rejects(tools.execute('skill_run',{id:skill.id,input:{}},AbortSignal.timeout(5000)),/disabled/);
});

test('scientific execution cannot fall back to a local worker without a workspace',async t=>{
  const home=mkdtempSync(join(tmpdir(),'eve-science-no-backend-')),store=new Store(':memory:');
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const skills=new SkillRegistry({home,store});skills.mountLibrary(resolve('skill-library'));
  const skill=skills.list().find(s=>s.name==='science-clinvar-database')!;
  const tools=createAgentTools({skills} as ToolServices,new SearchService(),[],undefined,[],undefined,'full');
  await tools.execute('skill_load',{id:skill.id},AbortSignal.timeout(5000));
  await assert.rejects(tools.execute('skill_run',{id:skill.id,input:{}},AbortSignal.timeout(5000)),/bound workspace/);
});
