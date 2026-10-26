import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {SkillRegistry} from './domain/tools.js';
import type {Json} from './harness/types.js';
/** Bundled code is versioned application content, installed idempotently. User
 * installed skills and enable/disable choices are never overwritten. */
export async function installBundledSkills(registry:SkillRegistry,root:string):Promise<Json>{
 const installed=[];
 for(const entry of readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory())){
  const path=join(root,entry.name),manifest=JSON.parse(readFileSync(join(path,'skill.json'),'utf8'));
  const existing=registry.list().find(x=>x.name===manifest.name&&x.version===manifest.version);
  installed.push(existing??await registry.install({path,confirm:true,confirmDanger:['skill-creator','skill-installer'].includes(manifest.name)}));
 }
 return {count:installed.length,skills:installed as unknown as Json};
}
