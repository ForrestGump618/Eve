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
test('new research scripts preserve licenses and use the existing bound scientific adapter',async t=>{
  const library=new SkillLibrary(resolve('skill-library'));
  const research=library.skills.filter(s=>s.bundle==='bio-research');
  assert.equal(research.length,6);
  for(const skill of research){
    assert.equal(skill.license,'Apache-2.0');
    assert.match(skill.source,/2574e29377c7173d0cecffef29a6ecbd7f8ccb5d/);
    assert.ok(library.read(skill.id,'EVE-UPSTREAM-LICENSE.txt').includes('Apache License'));
    for(const script of skill.runtime!.scripts)assert.ok(library.read(skill.id,script).includes('__main__'));
  }
  const home=mkdtempSync(join(tmpdir(),'eve-bio-registry-')),store=new Store(':memory:');
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const skills=new SkillRegistry({home,store});skills.mountLibrary(resolve('skill-library'));
  const skill=skills.list().find(s=>s.name==='science-bio-nextflow-development')!;
  assert.ok(skills.isScience(skill.id));
  const calls:string[]=[];
  const tools=createAgentTools({skills} as ToolServices,new SearchService(),[],undefined,[],{
    kind:'ssh',call:async operation=>{calls.push(operation);return {status:'inspected'};}
  },'ask');
  await tools.execute('skill_load',{id:skill.id},AbortSignal.timeout(5000));
  await tools.execute('skill_run',{id:skill.id,input:{script:'scripts/detect_data_type.py',args:['.','--json']}},AbortSignal.timeout(5000));
  await tools.execute('science_inspect',{kind:'environment'},AbortSignal.timeout(5000));
  assert.deepEqual(calls,['run_science_skill','science_inspect']);
});
test('specialist model skills expose credentials and keep model-checkout scripts out of direct execution',()=>{
  const library=new SkillLibrary(resolve('skill-library'));
  const models=library.skills.filter(s=>s.bundle==='bionemo');
  assert.equal(models.length,45);
  for(const skill of models){
    assert.match(skill.source,/f9bb5bb3aacc881c89eb15e93fd119e91915eea8/);
    for(const path of ['EVE-UPSTREAM-LICENSE.txt','EVE-UPSTREAM-LICENSE-APACHE-2.0.txt','EVE-UPSTREAM-LICENSE-CC-BY-4.0.txt']){
      assert.ok(library.read(skill.id,path).length>100);
    }
  }
  const evo=models.find(s=>s.name==='science-bionemo-evo2-nim')!;
  assert.ok(evo.runtime!.optionalCredentials.includes('NGC_API_KEY'));
  assert.deepEqual(evo.runtime!.scriptDependencies!['scripts/generate.py'],['requests']);
  const annotated=models.find(s=>s.name==='science-bionemo-rfd4-proteina-annotated-cif')!;
  assert.equal(annotated.runtime!.scripts.length,0);
  assert.ok(annotated.runtime!.externalRequirements?.length);
  assert.ok(library.read(annotated.id,'scripts/inspect_cif.py').includes('rfproteina'));
});
