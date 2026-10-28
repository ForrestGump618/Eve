import {createHash} from 'node:crypto';
import {closeSync, openSync, readFileSync, readSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {ValidationError} from './harness/types.js';

export interface LibrarySkill {
  id:string; name:string; description:string; version:string; source:string;
  license:string; sha256:string; files:Record<string,string>; omittedResources:string[];
  bundle?:string; keywords?:string;
  runtime?:{manager:'uv'|'node';scripts:string[];project:boolean;requiredCredentials:string[];optionalCredentials:string[];scriptDependencies?:Record<string,string[]>;externalRequirements?:string[]};
}
interface LibraryIndex {
  version:number; skills:LibrarySkill[];
  objects:Record<string,{offset:number;length:number;bytes:number}>;
}

const expand:Record<string,string> = {
  '文献':'literature pubmed review', '论文':'paper writing research', '单细胞':'single cell scanpy',
  '空间':'spatial transcriptomics', '蛋白':'protein', '基因':'genomic gene', '统计':'statistics statistical',
  '绘图':'plot visualization figure', '技能':'skill', '实验':'experiment', '基线':'baseline',
  '分析':'analysis', '假设':'hypothesis idea', '写作':'writing paper', '临床':'clinical medical',
  '药物':'drug discovery', '分子':'molecular', '审核':'review', '调试':'debugging',
  '文档':'document pdf parsing', '解析':'parsing extract', '转换':'convert conversion',
  '表格':'table spreadsheet', '扫描':'ocr scanned', '识别':'ocr recognition',
  '架构图':'archify architecture diagram', '流程图':'archify workflow diagram',
  '时序图':'archify sequence diagram', '一页说明':'archify explainer', '单页说明':'archify explainer',
  '测序':'ngs sequencing fastq', '仪器':'instrument allotrope', '批次':'batch integration scvi',
  '变异':'variant clinvar gnomad', '引物':'primer pcr', '系统发育':'phylogeny evolutionary',
};
/** Product-level synonyms steer the shared library without requiring a
 * second semantic index. These are ranked as exact capability intents. */
const preferredByName:Record<string,string[]> = {
  pdf:['mineru','liteparse','markitdown'],
  ocr:['mineru','liteparse'],
  document:['mineru','liteparse','markitdown'],
  architecture:['archify'],workflow:['archify'],explainer:['archify'],
};
function tokens(text:string):string[] {
  const translated=Object.entries(expand).filter(([key])=>text.includes(key)).map(([,value])=>value).join(' ');
  return [...new Set((text+' '+translated).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

/** A shared compressed pack: no startup extraction or per-user copies. */
export class SkillLibrary {
  readonly skills:ReadonlyArray<LibrarySkill>;
  private readonly byId:Map<string,LibrarySkill>;
  private readonly postings=new Map<string,Set<string>>();
  private readonly sortedTerms:string[];
  private readonly cache=new Map<string,string>();
  private cachedBytes=0;
  private readonly index:LibraryIndex;
  private reads=0;
  private readonly overlays:SkillLibrary[];
  private readonly owners=new Map<string,SkillLibrary>();

  constructor(private readonly root:string,additionalRoots:string[] = []) {
    if(additionalRoots.length>4)throw new ValidationError('Too many additional skill libraries');
    this.overlays=additionalRoots.map(path=>new SkillLibrary(path));
    this.index=JSON.parse(readFileSync(join(root,'index.json'),'utf8')) as LibraryIndex;
    if(this.index.version!==1||!Array.isArray(this.index.skills))throw new ValidationError('Unsupported skill library');
    const ids=new Set(this.index.skills.map(skill=>skill.id));
    const names=new Set(this.index.skills.map(skill=>skill.name.toLowerCase()));
    for(const library of this.overlays)for(const skill of library.skills){
      if(ids.has(skill.id)||names.has(skill.name.toLowerCase()))throw new ValidationError('Duplicate additional library skill');
      ids.add(skill.id);names.add(skill.name.toLowerCase());this.owners.set(skill.id,library);
    }
    this.skills=[...this.index.skills,...this.overlays.flatMap(library=>library.skills)];
    this.byId=new Map(this.skills.map(skill=>[skill.id,skill]));
    for(const skill of this.skills)for(const word of tokens(skill.name+' '+skill.description+' '+(skill.keywords??''))){
      if(!this.postings.has(word))this.postings.set(word,new Set());
      this.postings.get(word)!.add(skill.id);
    }
    this.sortedTerms=[...this.postings.keys()].sort();
  }
  has(id:string):boolean{return this.byId.has(id);}
  get(id:string):LibrarySkill {
    const skill=this.byId.get(id);
    if(!skill)throw new ValidationError('Unknown bundled skill');
    return skill;
  }
  search(query:string,limit=8):Array<{id:string;score:number}> {
    const words=tokens(query),scores=new Map<string,number>(),nameHits=new Set<string>();
    const normalized=query.trim().toLowerCase();
    // Prefer skills whose canonical name is directly relevant to the query.
    // A large scientific library can otherwise fill the first page with
    // generic PDF mentions before the specifically requested tool.
    for(const skill of this.skills){
      const name=skill.name.toLowerCase();
      if(name===normalized||name.startsWith(normalized)){
        nameHits.add(skill.id);
        scores.set(skill.id,Math.max(scores.get(skill.id)??0,0.5));
      }
    }
    for(const preferred of preferredByName[normalized]??[]){
      for(const skill of this.skills){
        if(skill.name.toLowerCase()!==preferred)continue;
        nameHits.add(skill.id);
        scores.set(skill.id,Math.max(scores.get(skill.id)??0,3));
      }
    }
    for(const word of words){
      for(const id of this.postings.get(word)??[]){
        scores.set(id,(scores.get(id)??0)+1);
        const name=this.get(id).name.toLowerCase();
        if(name===normalized||name.startsWith(normalized))nameHits.add(id);
      }
      // Morphological matching uses a sorted vocabulary and binary search, so
      // discovery remains bounded as the shared library grows.
      if(word.length>=4){
        let low=0,high=this.sortedTerms.length;
        while(low<high){
          const middle=(low+high)>>>1;
          if(this.sortedTerms[middle]!<word)low=middle+1;else high=middle;
        }
        for(let index=low;index<this.sortedTerms.length;index++){
          const term=this.sortedTerms[index]!;
          if(!term.startsWith(word))break;
          if(term===word)continue;
          for(const id of this.postings.get(term)??[]){
            scores.set(id,(scores.get(id)??0)+0.25);
            const name=this.get(id).name.toLowerCase();
            if(name===normalized||name.startsWith(normalized))nameHits.add(id);
          }
        }
      }
    }
    return [...scores].map(([id,score])=>({id,score:score+(this.get(id).name.toLowerCase()===query.toLowerCase()?20:0)}))
      .sort((a,b)=>(Number(nameHits.has(b.id))-Number(nameHits.has(a.id)))||b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
  }
  read(id:string,path:string):string {
    const owner=this.owners.get(id);
    if(owner)return owner.read(id,path);
    const files=this.get(id).files;
    const sha=Object.hasOwn(files,path)?files[path]:null;
    if(!sha||!/^[a-f0-9]{64}$/.test(sha))throw new ValidationError('Unknown skill resource');
    const cached=this.cache.get(sha);
    if(cached!==undefined){this.cache.delete(sha);this.cache.set(sha,cached);return cached;}
    const ref=this.index.objects[sha];
    if(!ref||!Number.isSafeInteger(ref.offset)||ref.offset<0||!Number.isSafeInteger(ref.length)||ref.length<1||ref.length>2_100_000||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||ref.bytes>2_000_000)
      throw new ValidationError('Invalid compressed skill object');
    const fd=openSync(join(this.root,'library.pack'),'r');
    let content:Buffer;
    try {
      const compressed=Buffer.alloc(ref.length);
      let offset=0;
      while(offset<ref.length){const read=readSync(fd,compressed,offset,ref.length-offset,ref.offset+offset);if(!read)throw new ValidationError('Truncated skill pack');offset+=read;}
      content=gunzipSync(compressed,{maxOutputLength:2_000_000});this.reads++;
    } finally {closeSync(fd);}
    if(content.length!==ref.bytes||createHash('sha256').update(content).digest('hex')!==sha)
      throw new ValidationError('Skill resource digest mismatch');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(content);
    while(this.cachedBytes+content.length>4_000_000&&this.cache.size){
      const oldest=this.cache.keys().next().value!;
      this.cachedBytes-=Buffer.byteLength(this.cache.get(oldest)!);this.cache.delete(oldest);
    }
    this.cache.set(sha,text);this.cachedBytes+=content.length;
    return text;
  }
  stats():{skills:number;physicalReads:number;cachedBytes:number;cachedObjects:number}{
    const extra=this.overlays.map(library=>library.stats());
    return {skills:this.skills.length,physicalReads:this.reads+extra.reduce((n,s)=>n+s.physicalReads,0),
      cachedBytes:this.cachedBytes+extra.reduce((n,s)=>n+s.cachedBytes,0),
      cachedObjects:this.cache.size+extra.reduce((n,s)=>n+s.cachedObjects,0)};
  }
}
