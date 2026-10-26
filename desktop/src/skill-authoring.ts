import {mkdtemp,mkdir,writeFile,rm,readFile,access} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {SkillRegistry} from './domain/tools.js';
import type {WorkspaceFiles} from './workspace-files.js';
import {ValidationError,type Json} from './harness/types.js';
async function staging<T>(run:(root:string)=>Promise<T>):Promise<T>{
 const root=await mkdtemp(join(tmpdir(),'suwen-skill-'));
 try{return await run(root);}finally{if(resolve(root).startsWith(resolve(tmpdir())+sep))await rm(root,{recursive:true,force:true});}
}
const manifest=(name:string,description:string,script=false)=>({name,version:'1.0.0',description,entry:'SKILL.md',license:'MIT',permissions:[],...(script?{run:{language:'python',script:'run.py',timeoutMs:30000}}:{})});
export async function createSkill(registry:SkillRegistry,args:Record<string,Json>,signal:AbortSignal):Promise<Json>{
 signal.throwIfAborted();
 return staging(async root=>{
  const instructions=String(args.instructions),name=String(args.name);
  await writeFile(join(root,'SKILL.md'),`---\nname: ${name}\ndescription: ${JSON.stringify(String(args.description))}\n---\n\n${instructions}\n`);
  await writeFile(join(root,'skill.json'),JSON.stringify(manifest(name,String(args.description),Boolean(args.script))));
  if(args.script)await writeFile(join(root,'run.py'),String(args.script));
  const installed=await registry.install({path:root,confirm:true});
  return {installed:true,executed:false,skill:installed as unknown as Json};
 });
}
async function githubJson(path:string,signal:AbortSignal):Promise<any>{
 const response=await fetch(`https://api.github.com/${path}`,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),redirect:'error',headers:{accept:'application/vnd.github+json','user-agent':'SuWen-Skills'}});
 if(!response.ok){await response.body?.cancel();throw new Error(`GitHub skill download HTTP ${response.status}`);}
 let text='';if(!response.body)throw Error('Empty GitHub response');
 for await(const chunk of response.body){text+=Buffer.from(chunk).toString('utf8');if(text.length>2_000_000)throw Error('GitHub skill metadata exceeds limit');}
 return JSON.parse(text);
}
export async function installSkill(registry:SkillRegistry,workspace:WorkspaceFiles,args:Record<string,Json>,signal:AbortSignal):Promise<Json>{
 signal.throwIfAborted();
 if(args.path&&!args.url)return {installed:true,executed:false,skill:await registry.install({path:await workspace.path(String(args.path)),confirm:true}) as unknown as Json};
 if(!args.url||args.path)throw new ValidationError('Supply exactly one local path or GitHub tree URL');
 const url=new URL(String(args.url));
 const match=url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/tree\/([\w.-]+)\/(.+?)\/?$/);
 if(url.origin!=='https://github.com'||url.search||url.hash||!match)throw new ValidationError('Use https://github.com/owner/repo/tree/ref/path-to-skill');
 const [,owner,repo,ref,subpath]=match;
 const parts=subpath.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||!/^[\w.-]+$/.test(p)))throw new ValidationError('Invalid repository skill path');
 const revision=await githubJson(`repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,signal);
 if(!/^[a-f0-9]{40}$/.test(revision.sha))throw new Error('GitHub did not resolve an immutable revision');
 return staging(async root=>{
  let bytes=0,count=0;const files:Array<{path:string;sha256:string}>=[];
  const load=async(path:string,local:string,depth=0):Promise<void>=>{
   if(depth>6)throw Error('Skill directory nesting exceeds limit');
   const entries=await githubJson(`repos/${owner}/${repo}/contents/${path}?ref=${revision.sha}`,signal);
   if(!Array.isArray(entries))throw Error('Skill URL must point to a directory');
   for(const entry of entries){
    signal.throwIfAborted();if(!/^[\w.-]+$/.test(entry.name)||['.','..'].includes(entry.name))throw Error('Invalid skill file name');
    if(++count>100)throw Error('Skill exceeds 100 entries');
    const destination=join(root,local,entry.name);
    if(entry.type==='dir'){await mkdir(destination,{recursive:true});await load(`${path}/${entry.name}`,`${local}/${entry.name}`,depth+1);}
    else if(entry.type==='file'){
     const file=await githubJson(`repos/${owner}/${repo}/contents/${path}/${entry.name}?ref=${revision.sha}`,signal);
     if(file.encoding!=='base64'||typeof file.content!=='string')throw Error('Unsupported GitHub file response');
     const data=Buffer.from(file.content,'base64');bytes+=data.length;if(data.length>200000||bytes>2_000_000)throw Error('Skill exceeds size limit');
     await writeFile(destination,data);files.push({path:`${local}/${entry.name}`,sha256:createHash('sha256').update(data).digest('hex')});
    }else throw Error('Symlinks and submodules are not installable skills');
   }
  };
  await load(subpath,'');
  if(!await access(join(root,'skill.json')).then(()=>true).catch(()=>false)){
   const instructions=await readFile(join(root,'SKILL.md'),'utf8');
   const repository=await githubJson(`repos/${owner}/${repo}`,signal);
   const license=repository.license?.spdx_id;
   if(typeof license!=='string'||['NOASSERTION','NONE'].includes(license))throw new ValidationError('An explicit skill.json license or recognized repository license is required');
   const name=instructions.match(/^name:\s*["']?([a-z0-9-]+)/m)?.[1]??parts.at(-1)!;
   const description=instructions.match(/^description:\s*(.+)/m)?.[1]?.slice(0,1000)??name;
   await writeFile(join(root,'skill.json'),JSON.stringify({...manifest(name,description),version:`git-${revision.sha.slice(0,12)}`,license}));
  }
  const installed=await registry.install({url:`https://github.com/${owner}/${repo}/tree/${revision.sha}/${subpath}`,checkoutPath:root,confirm:true});
  return {installed:true,executed:false,revision:revision.sha,files:files as unknown as Json,skill:installed as unknown as Json};
 });
}
