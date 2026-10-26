import {realpath,stat,readdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname,basename,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ValidationError,type Json} from './harness/types.js';
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
/** A selected workspace grants its subtree; attachments and user supplied file
 * paths grant only that canonical file. Symlinks cannot expand either grant. */
export class WorkspaceFiles {
 constructor(readonly roots:string[],readonly files:string[]){}
 async path(wanted:string,write=false):Promise<string>{
  const roots=await Promise.all(this.roots.map(x=>realpath(x)));
  const files=await Promise.all(this.files.map(x=>realpath(x).catch(()=>'')));
  let candidates=isAbsolute(wanted)?[wanted]:roots.map(root=>resolve(root,wanted));
  if(!write)candidates.push(...this.files.filter(x=>x===wanted||basename(x)===wanted));
  const allowed=new Set<string>();
  for(const candidate of candidates){
   try{
    const canonical=await realpath(candidate);
    if(roots.some(root=>inside(root,canonical))||(!write&&files.includes(canonical)))allowed.add(canonical);
   }catch{
    if(write){const parent=await realpath(dirname(candidate)).catch(()=>null);if(parent&&roots.some(root=>inside(root,parent)))allowed.add(join(parent,basename(candidate)));}
   }
  }
  if(allowed.size!==1)throw new ValidationError('Path is outside the selected workspace, missing, or ambiguous. Select a workspace or provide an explicit file path.');
  return [...allowed][0];
 }
 async list(wanted='.',offset=0):Promise<Json>{
  const path=await this.path(wanted);const info=await stat(path);if(!info.isDirectory())throw new ValidationError('Not a directory');
  const entries=(await readdir(path,{withFileTypes:true})).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
  return {path,total:entries.length,offset,nextOffset:offset+200<entries.length?offset+200:null,entries:entries.slice(offset,offset+200).map(x=>({name:x.name,type:x.isSymbolicLink()?'symlink':x.isDirectory()?'directory':'file'}))};
 }
 async read(wanted:string,start=1,limit=400):Promise<Json>{
  const path=await this.path(wanted),info=await stat(path);if(!info.isFile()||info.size>20_000_000)throw new ValidationError('Read supports text files up to 20 MB');
  const bytes=await readFile(path);let content:string;
  try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(content.includes('\0'))throw Error();}catch{throw new ValidationError('Binary file: use a document-specific skill instead of reading as UTF-8');}
  const lines=content.split(/\r?\n/),selected:string[]=[];let chars=0;
  for(const line of lines.slice(start-1,start-1+limit)){if(selected.length&&chars+line.length>28000)break;selected.push(line);chars+=line.length+1;}
  // A single very long line remains inspectable, without silently claiming it is complete.
  const text=selected.join('\n'),clipped=text.length>28000;
  return {path,bytes:bytes.length,sha256:digest(bytes),startLine:start,endLine:start+selected.length-1,totalLines:lines.length,content:text.slice(0,28000),truncated:clipped||start-1+selected.length<lines.length,nextStartLine:!clipped&&start-1+selected.length<lines.length?start+selected.length:null};
 }
 async search(query:string,wanted='.',signal:AbortSignal):Promise<Json>{
  const root=await this.path(wanted),matches:Json[]=[],queue=[root];let visited=0,limited=false;
  while(queue.length&&visited<600&&matches.length<80){signal.throwIfAborted();const path=await this.path(queue.shift()!);visited++;const info=await stat(path);if(info.isDirectory()){
   for(const entry of await readdir(path,{withFileTypes:true})){if(entry.isSymbolicLink()||['.git','node_modules','.venv','__pycache__'].includes(entry.name))continue;if(queue.length+visited>=600){limited=true;break;}const full=join(path,entry.name);if(entry.isDirectory()||entry.isFile())queue.push(full);}
  }else{if(info.size>1_000_000)continue;const bytes=await readFile(path);if(bytes.includes(0))continue;const lines=bytes.toString('utf8').split(/\r?\n/);for(let i=0;i<lines.length&&matches.length<80;i++)if(lines[i].toLocaleLowerCase().includes(query.toLocaleLowerCase()))matches.push({path,line:i+1,text:lines[i].slice(0,400)});}}
  limited=limited||queue.length>0||matches.length>=80;return {query,visited,limited,matches};
 }
 async write(wanted:string,content:string,expectedSha256?:string):Promise<Json>{
  const path=await this.path(wanted,true);let previous:Buffer|null=null;try{previous=await readFile(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(previous&&digest(previous)!==expectedSha256)throw new ValidationError('Read the existing file first and supply its matching expectedSha256 before replacing it');
  if(!previous&&expectedSha256)throw new ValidationError('Expected existing file does not exist');
  const tmp=join(dirname(path),`.suwen-${randomUUID()}.tmp`);
  try{await writeFile(tmp,content,{encoding:'utf8',flag:'wx'});await rename(tmp,path);}finally{await unlink(tmp).catch(()=>{});}
  return {path,bytes:Buffer.byteLength(content),sha256:digest(content),created:!previous};
 }
}

export async function userFileGrants(prompt:string):Promise<string[]>{
 const candidates=[...prompt.matchAll(/[A-Za-z]:[\\/][^\n"'<>|]*?\.[a-zA-Z0-9]{1,10}(?=[\s"'，。；）)]|$)/g)].map(x=>x[0]);
 return (await Promise.all(candidates.map(async path=>await stat(path).then(s=>s.isFile()?path:null).catch(()=>null)))).filter((x):x is string=>!!x);
}
