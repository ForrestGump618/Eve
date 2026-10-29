import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import type { FormatsPlugin } from 'ajv-formats';
const addFormats:FormatsPlugin=createRequire(import.meta.url)('ajv-formats');
import type { Json } from './types.js';
import { ValidationError } from './types.js';
import {
  ToolArgumentError,
  UnknownToolError,
  normalizeToolArguments,
  suggestFieldName,
  suggestToolNames,
} from './tool-diagnostics.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, Json>;
  kind: 'tool' | 'mcp' | 'skill';
  readOnly?: boolean;
  timeoutMs?: number;
  execute(args: Record<string, Json>, signal: AbortSignal): Promise<Json>;
}

/** Reuse Ajv rather than maintaining a partial JSON Schema implementation. No
 * coercion, default insertion, network reference loading or schema mutation. */
const validators = new Map<string, ValidateFunction>();
const draft7 = new Ajv({strict:true, strictTypes:false, allErrors:false, allowUnionTypes:true});
const draft2020 = new Ajv2020({strict:true, strictTypes:false, allErrors:false, allowUnionTypes:true});
addFormats(draft7);addFormats(draft2020);
export function validateArguments(value: unknown, schema: unknown, path = '$'): asserts value is Record<string, Json> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new ValidationError(`${path}: schema missing`);
  const key=JSON.stringify(schema);
  if(key.length>50000)throw new ValidationError(`${path}: schema too large`);
  let validate=validators.get(key);
  if(!validate){
    try{validate=(String((schema as Record<string,unknown>).$schema??'').includes('2020-12')?draft2020:draft7).compile(schema);}
    catch{throw new ValidationError(`${path}: unsupported or invalid JSON Schema`);}
    validators.set(key,validate);while(validators.size>128)validators.delete(validators.keys().next().value!);
  }
  if(!validate(value)){
    const error=validate.errors?.[0];
    const schemaRecord=schema as Record<string, Json>;
    const properties=schemaRecord.properties&&typeof schemaRecord.properties==='object'&&!Array.isArray(schemaRecord.properties)
      ?schemaRecord.properties as Record<string,Json>:{};
    const required=Array.isArray(schemaRecord.required)?schemaRecord.required.filter(item=>typeof item==='string'):[];
    const keyword=String(error?.keyword??'schema');
    const field=keyword==='required'
      ?String((error?.params as {missingProperty?:unknown}|undefined)?.missingProperty??'')
      :keyword==='additionalProperties'
        ?String((error?.params as {additionalProperty?:unknown}|undefined)?.additionalProperty??'')
        :String(error?.instancePath??'').split('/').filter(Boolean).at(-1)??'';
    const allowed=Object.keys(properties);
    const suggestions=field&&allowed.length?suggestFieldName(field,allowed):required.slice(0,5);
    const detail=keyword==='required'
      ?`required field ${JSON.stringify(field)} is missing`
      :keyword==='additionalProperties'
        ?`field ${JSON.stringify(field)} is not allowed`
        :keyword==='type'
          ?`field ${field?JSON.stringify(field):'value'} has the wrong type`
          :`${keyword} validation failed${field?` at ${field}`:''}`;
    throw new ToolArgumentError(`${path}${error?.instancePath??''}: ${detail}${suggestions.length?`. Did you mean ${suggestions.join(', ')}?`:''}`,{
      ...(field?{field}:{}),
      keyword,
      ...(keyword==='type'&&properties[field]&&typeof properties[field]==='object'&&!Array.isArray(properties[field])&&typeof (properties[field] as Record<string,Json>).type==='string'
        ?{expected:String((properties[field] as Record<string,Json>).type)}:{}),
      received:value===null?'null':Array.isArray(value)?'array':typeof value,
      suggestions,
    });
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): this {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || this.tools.has(tool.name)) throw new ValidationError(`Duplicate or invalid tool: ${tool.name}`);
    this.tools.set(tool.name,tool); return this;
  }
  definitions(): Array<{name:string; description:string; parameters:Record<string,Json>}> {
    return [...this.tools.values()].map(({name,description,parameters}) => ({name,description,parameters}));
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  readOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly === true;
  }
  definition(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
  async execute(name: string, args: Record<string, Json>, signal: AbortSignal): Promise<Json> {
    signal.throwIfAborted();
    const tool = this.tools.get(name);
    if (!tool) throw new UnknownToolError(name, suggestToolNames(name, this.names()));
    const normalized=normalizeToolArguments(args,tool.parameters);
    validateArguments(normalized.args,tool.parameters);
    const deadline = AbortSignal.any([signal,AbortSignal.timeout(tool.timeoutMs ?? 20000)]);
    let listener: (() => void) | undefined;
    try {
      return await Promise.race([tool.execute(normalized.args,deadline), new Promise<never>((_,reject) => {
        listener = () => reject(new Error(signal.aborted ? 'Tool cancelled' : 'Tool timed out'));
        deadline.addEventListener('abort',listener,{once:true}); if (deadline.aborted) listener();
      })]);
    } finally { if (listener) deadline.removeEventListener('abort',listener); }
  }
}
