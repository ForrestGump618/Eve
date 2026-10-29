import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {installBundledSkills} from '../src/bundled-skills.js';
import {SkillRegistry} from '../src/domain/tools.js';
import {Store} from '../src/harness/store.js';
import {createResearchWorker} from '../src/research-worker.js';

test('wet-lab skills are discoverable and deterministic interpretation executes',async t=>{
  const home=mkdtempSync(join(tmpdir(),'eve-wet-lab-'));
  const store=new Store(join(home,'wet-lab.sqlite'));
  const worker=createResearchWorker({python:'python',scriptPath:resolve('worker/research_worker.py')});
  t.after(async()=>{
    await worker.close();
    store.close();
    rmSync(home,{recursive:true,force:true});
  });
  const registry=new SkillRegistry({home,store,worker});
  registry.mountLibrary(resolve('skill-library'));
  const installed=await installBundledSkills(registry,resolve('bundled-skills')) as any;
  assert.ok(installed.count>=11);

  const expected={
    '湿实验':'wet-lab-experiment-design',
    '细胞活力':'classic-cell-and-molecular-assays',
    'qPCR':'classic-cell-and-molecular-assays',
    'Western blot':'classic-cell-and-molecular-assays',
    '结果解读':'wet-lab-result-interpretation',
    'ELISA':'wet-lab-result-interpretation',
    '样本量':'statistical-power',
    '实验记录':'protocolsio-integration',
    '实验室自动化':'pylabrobot',
    '方法验证':'analytical-method-validation',
  };
  for(const [query,name] of Object.entries(expected)){
    const found=registry.search(query) as any[];
    assert.ok(found.some(skill=>skill.name===name),`${query} -> ${name}: ${found.map(x=>x.name).join(',')}`);
  }

  const skill=registry.list().find(item=>item.name==='wet-lab-result-interpretation');
  assert.ok(skill?.executable);
  const loaded=registry.load(skill.id) as any;
  assert.match(loaded.instructions,/生物学重复/);
  assert.equal(loaded.run.language,'python');
  const result=await registry.run(skill.id,{
    assay:'cell_viability',control:'vehicle',cv_limit_percent:15,
    groups:{
      vehicle:[
        {sample_id:'V1',values:[1.01,0.98,1.02]},
        {sample_id:'V2',values:[0.97,1.00,1.01]},
      ],
      drug:[
        {sample_id:'D1',values:[0.61,0.58,0.60]},
        {sample_id:'D2',values:[0.66,0.63,0.65]},
      ],
    },
  },AbortSignal.timeout(20000)) as any;
  const parsed=JSON.parse(result.result.stdout);
  assert.equal(parsed.ok,true);
  assert.equal(parsed.result.groups.drug.summary.biological_n,2);
  assert.ok(parsed.result.groups.drug.summary.mean<70);
});

test('wet-lab design skills carry no host or network permissions',async t=>{
  const home=mkdtempSync(join(tmpdir(),'eve-wet-lab-permissions-'));
  const store=new Store(':memory:');
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const registry=new SkillRegistry({home,store});
  await installBundledSkills(registry,resolve('bundled-skills'));
  for(const name of ['wet-lab-experiment-design','classic-cell-and-molecular-assays','wet-lab-result-interpretation']){
    const skill=registry.list().find(item=>item.name===name);
    assert.ok(skill);
    assert.deepEqual(skill.permissions,[]);
    assert.match((registry.load(skill.id) as any).sha256,/^[a-f0-9]{64}$/);
  }
});
