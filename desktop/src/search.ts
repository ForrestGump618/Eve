import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { Json } from './harness/types.js';
import { ValidationError } from './harness/types.js';

export interface Source { url:string; title:string; text:string; retrievedAt:string; provider:string; sha256:string; fetched:boolean }
type Fetcher = typeof fetch;
function privateAddress(ip:string):boolean {
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127);}
  return /^(?:\:\:|fc|fd|fe8|fe9|fea|feb|ff)/i.test(ip) || /^::ffff:/i.test(ip);
}
export function publicUrl(value:string):URL {
  const u=new URL(value);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hostname==='localhost'||/\.(?:localhost|local|internal)$/i.test(u.hostname)||u.port&& !['80','443'].includes(u.port))throw new ValidationError('Only public HTTP(S) source URLs are allowed');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(isIP(host)&&privateAddress(host))throw new ValidationError('Private source address refused');
  u.hash='';return u;
}
export function decodeEntities(s:string):string {return s.replace(/&#x([\da-f]+);/gi,(_,x)=>{const n=parseInt(x,16);return n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/&#(\d+);/g,(_,x)=>Number(x)<=0x10ffff?String.fromCodePoint(Number(x)):'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[x]??x));}
export function extractText(html:string):string {return decodeEntities(html.replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<!--[^]*?-->/g,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();}
const source=(url:string,title:string,text:string,provider:string,fetched=false):Source=>({url:publicUrl(url).href,title:extractText(title).slice(0,300),text:text.slice(0,14000),retrievedAt:new Date().toISOString(),provider,sha256:createHash('sha256').update(text).digest('hex'),fetched});

/** Two public providers; no paid search key is assumed. Responses are bounded and
 * cached only after nonempty, parsed results. Every fallback is observable. */
export class SearchService {
  private cache=new Map<string,{until:number;data:Source[]}>();
  constructor(private readonly fetcher:Fetcher=fetch){}
  private async request(value:string,signal:AbortSignal):Promise<{url:string;text:string}> {
    let u=publicUrl(value);
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
    for(let hops=0;hops<5;hops++){
      deadline.throwIfAborted();
      const addresses=await lookup(u.hostname.replace(/^\[|\]$/g,''),{all:true});
      if(!addresses.length||addresses.some(a=>privateAddress(a.address)))throw new ValidationError('Private DNS address refused');
      const response=await this.fetcher(u,{signal:deadline,redirect:'manual',headers:{'user-agent':'SuWen/3.3 research retrieval','accept':'text/html,application/xhtml+xml,application/rss+xml,application/json,text/plain'}});
      if(response.status>=300&&response.status<400){const target=response.headers.get('location');await response.body?.cancel();if(!target)throw new Error('Source redirect missing location');u=publicUrl(new URL(target,u).href);continue;}
      if(!response.ok){await response.body?.cancel();throw new Error(`Source HTTP ${response.status}`);}
      const type=response.headers.get('content-type')??'';
      if(!/text|json|xml/i.test(type)){await response.body?.cancel();throw new Error('Source type unsupported; use a document reader for binary sources');}
      let bytes=0,text='';const decoder=new TextDecoder();
      if(!response.body)throw new Error('Source returned no body');
      try {for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>2000000)throw new Error('Source exceeds 2 MB limit');text+=decoder.decode(chunk,{stream:true});}text+=decoder.decode();}
      catch(e){throw e;}
      return {url:u.href,text};
    }
    throw new Error('Source redirect limit exceeded');
  }
  async fetch(url:string,signal:AbortSignal):Promise<Source> {
    const page=await this.request(url,signal);
    const text=extractText(page.text);
    if(text.length<80||/^(?:.{0,100})(?:Just a moment|Access Denied|Checking your browser)/i.test(text))throw new Error('Source body is empty or blocked');
    const title=page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??page.url;
    return source(page.url,title,text,'http',true);
  }
  async search(query:string,signal:AbortSignal,provider:'auto'|'bing'|'duckduckgo'='auto'):Promise<Json> {
    const q=query.trim().replace(/\s+/g,' ');
    if(!q||q.length>1000)throw new ValidationError('Search query must contain 1..1000 characters');
    const key=`${provider}:${q.toLowerCase()}`,cached=this.cache.get(key);
    if(cached&&cached.until>Date.now())return {query:q,cached:true,results:cached.data as unknown as Json};
    const failures:Array<{provider:string;reason:string}>=[];
    for(const candidate of provider==='auto'?['bing','duckduckgo']: [provider]){
      signal.throwIfAborted();
      try{
        const url=candidate==='bing'?`https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}`:`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        const page=await this.request(url,signal);let results:Source[]=[];
        if(candidate==='bing'){
          for(const match of page.text.matchAll(/<item>([\s\S]*?)<\/item>/g)){
            const tag=(name:string)=>decodeEntities(match[1].match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1]??'');
            try{results.push(source(tag('link'),tag('title'),extractText(tag('description')),candidate));}catch{}
          }
        }else{
          const blocks=page.text.split(/(?=<div[^>]*class="[^"]*result\s)/);
          for(const block of blocks){const link=block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);if(!link)continue;let url=decodeEntities(link[1]);if(url.startsWith('//'))url=`https:${url}`;const u=new URL(url);url=u.searchParams.get('uddg')??url;try{results.push(source(url,link[2],extractText(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/)?.[1]??link[2]),candidate));}catch{}}
        }
        const seen=new Set<string>();results=results.filter(x=>!seen.has(x.url)&&!!seen.add(x.url)).slice(0,8);
        if(!results.length)throw new Error('Search provider returned no parsable results or a challenge');
        this.cache.set(key,{until:Date.now()+300000,data:results});while(this.cache.size>100)this.cache.delete(this.cache.keys().next().value!);
        return {query:q,provider:candidate,cached:false,failures,results:results as unknown as Json};
      }catch(error){if(signal.aborted)throw error;failures.push({provider:candidate,reason:error instanceof ValidationError?error.message:'Provider unavailable or response invalid'});}
    }
    throw new Error(`All search providers failed (${failures.map(x=>x.provider).join(', ')}); no evidence retrieved`);
  }
}
