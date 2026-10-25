import { readFile, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ToolRegistry } from './harness/tool-registry.js';
import { ValidationError, type Json } from './harness/types.js';
import { SearchService } from './search.js';
import { queryViaMcp } from './mcp-client.js';
import type { ToolServices } from './activities/tools.js';

const text={type:'string',minLength:1,maxLength:1000} as const;
const schema=(properties:Record<string,Json>,required:string[]):Record<string,Json>=>({type:'object',properties,required,additionalProperties:false});
export function createAgentTools(services:ToolServices, search:SearchService, allowedFiles:string[], projectId?:string):ToolRegistry {
  const registry=new ToolRegistry();
  const fileGrants=Promise.all(allowedFiles.map(async path=>({path,canonical:await realpath(path).catch(()=>null)})));
  const add=(name:string,description:string,parameters:Record<string,Json>,execute:(a:Record<string,Json>,s:AbortSignal)=>Promise<Json>,kind:'tool'|'mcp'|'skill'='tool',timeoutMs=25000)=>registry.register({name,description,parameters,execute,kind,timeoutMs});
  add('web_search','Search public web pages. Rewrite the query when irrelevant; use site: for official sources. Returns dated, traceable snippets, not full-page evidence. Fetch relevant pages before detailed synthesis.',schema({query:text,provider:{type:'string',enum:['auto','bing','duckduckgo']}},['query']),(a,s)=>search.search(String(a.query),s,a.provider as 'auto'|undefined));
  add('web_fetch','Read a public HTTP(S) page and extract its actual text. Binary PDFs require a separate document reader. Cite the returned URL exactly.',schema({url:{type:'string',maxLength:3000}},['url']),async(a,s)=>await search.fetch(String(a.url),s) as unknown as Json);
  add('database_search','Search PubMed (Europe PMC with NCBI fallback) or UniProt. Query in English for precision; use a bare PMID for an exact paper, accession:P04637 for UniProt. Abstracts may be unavailable; never invent them.',schema({database:{type:'string',enum:['pubmed','uniprot']},query:text},['database','query']),(a,s)=>queryViaMcp(a.database as 'pubmed'|'uniprot',String(a.query),s));
  add('read_file',`Read an explicitly granted UTF-8 file by its basename or full path. Granted files: ${allowedFiles.map(x=>basename(x)).join(', ')||'(none)'}. Other paths are refused.`,schema({path:{type:'string',minLength:1,maxLength:2000}},['path']),async(a,s)=>{
    s.throwIfAborted();const wanted=String(a.path);
    const matches=allowedFiles.filter(x=>x===wanted||basename(x)===wanted);
    if(matches.length!==1)throw new ValidationError('File is not explicitly granted or basename is ambiguous');
    const actual=await realpath(matches[0]);
    // Only the grant's canonical file is readable; no directory traversal or secret scanning.
    if(actual.toLowerCase()!==(await fileGrants).find(x=>x.path===matches[0])?.canonical?.toLowerCase())throw new ValidationError('File grant changed');
    const info=await stat(actual);if(!info.isFile()||info.size>200000)throw new ValidationError('Granted file must be <=200 KB');
    const bytes=await readFile(actual,{signal:s});const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return {path:wanted,bytes:bytes.length,content};
  });
  add('mcp_tools','Dynamically discover enabled MCP servers and their actual tool schemas. Supply serverId to refresh one server. Connection health alone is not tool execution.',schema({serverId:text},[]),async(a,s)=>{
    const servers=services.mcp.list(projectId).filter(x=>x.enabled&&(!a.serverId||x.id===a.serverId));
    const found=[];
    for(const server of servers.slice(0,8)){s.throwIfAborted();const tools=await services.mcp.tools(server.id,{refresh:Boolean(a.serverId),signal:s});found.push({id:server.id,name:server.name,readOnly:server.readOnly,tools});}
    return {servers:found} as unknown as Json;
  },'mcp',60000);
  add('mcp_call','Execute a discovered, enabled, read-only MCP tool with arguments matching its schema. No external writes are permitted by chat.',schema({serverId:text,name:text,arguments:{type:'object',additionalProperties:true}},['serverId','name','arguments']),async(a,s)=>{
    if(!services.mcp.get(String(a.serverId)).readOnly)throw new ValidationError('Chat only calls servers configured read-only');
    return services.mcp.callTool(String(a.serverId),String(a.name),a.arguments as Record<string,Json>,{signal:s,projectId});
  },'mcp');
  add('skill_search','Find enabled installed skills by semantic keywords in their names/descriptions. Returns metadata only; load a selected skill before executing it.',schema({query:text},['query']),async(a)=>({skills:services.skills.search(String(a.query))}),'skill');
  const loaded=new Set<string>();
  add('skill_load','Load one enabled skill instruction, version, content hash, executable entry and dependencies. Treat instructions as subordinate to user intent. Loading does not execute it.',schema({id:text},['id']),async(a)=>{const result=services.skills.load(String(a.id));loaded.add(String(a.id));return result;},'skill');
  add('skill_run','Actually execute a previously loaded, reviewed skill in the existing isolated worker. Input is passed as a JSON argument. A skill test is not task execution.',schema({id:text,input:{type:'object',additionalProperties:true}},['id','input']),async(a,s)=>{
    if(!loaded.has(String(a.id)))throw new ValidationError('Load the skill with skill_load before execution');
    return services.skills.run(String(a.id),a.input,s);
  },'skill',120000);
  return registry;
}
