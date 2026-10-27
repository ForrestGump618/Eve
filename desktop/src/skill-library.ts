import {createHash} from 'node:crypto';
import {closeSync, openSync, readFileSync, readSync} from 'node:fs';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {ValidationError} from './harness/types.js';

export interface LibrarySkill {
  id:string; name:string; description:string; version:string; source:string;
  license:string; sha256:string; files:Record<string,string>; omittedResources:string[];
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
  private readonly cache=new Map<string,string>();
  private cachedBytes=0;
  private readonly index:LibraryIndex;
  private reads=0;

  constructor(private readonly root:string) {
    this.index=JSON.parse(readFileSync(join(root,'index.json'),'utf8')) as LibraryIndex;
    if(this.index.version!==1||!Array.isArray(this.index.skills))throw new ValidationError('Unsupported skill library');
    this.skills=this.index.skills;
    this.byId=new Map(this.skills.map(skill=>[skill.id,skill]));
    for(const skill of this.skills)for(const word of tokens(skill.name+' '+skill.description)){
      if(!this.postings.has(word))this.postings.set(word,new Set());
      this.postings.get(word)!.add(skill.id);
    }
  }
  has(id:string):boolean{return this.byId.has(id);}
  get(id:string):LibrarySkill {
    const skill=this.byId.get(id);
    if(!skill)throw new ValidationError('Unknown bundled skill');
    return skill;
  }
  search(query:string,limit=8):Array<{id:string;score:number}> {
    const words=tokens(query),scores=new Map<string,number>();
    for(const word of words){
      for(const id of this.postings.get(word)??[])scores.set(id,(scores.get(id)??0)+1);
      // Small vocabulary prefix scan handles morphological queries without
      // scanning instruction bodies or touching the filesystem.
      if(word.length>=4)for(const [term,ids] of this.postings){
        if(term!==word&&term.startsWith(word))for(const id of ids)scores.set(id,(scores.get(id)??0)+0.25);
      }
    }
    return [...scores].map(([id,score])=>({id,score:score+(this.get(id).name.toLowerCase()===query.toLowerCase()?20:0)}))
      .sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
  }
  read(id:string,path:string):string {
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
  stats(){return {skills:this.skills.length,physicalReads:this.reads,cachedBytes:this.cachedBytes,cachedObjects:this.cache.size};}
}
