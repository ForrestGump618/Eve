import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import type { FormatsPlugin } from 'ajv-formats';
const addFormats:FormatsPlugin=createRequire(import.meta.url)('ajv-formats');
import type { Json } from './types.js';
import { ValidationError } from './types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, Json>;
  kind: 'tool' | 'mcp' | 'skill';
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
  if(!validate(value)){const e=validate.errors?.[0];throw new ValidationError(`${path}${e?.instancePath??''}: ${e?.keyword??'schema'} validation failed`);}
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
  async execute(name: string, args: Record<string, Json>, signal: AbortSignal): Promise<Json> {
    signal.throwIfAborted();
    const tool = this.tools.get(name);
    if (!tool) throw new ValidationError(`Unknown tool: ${name}`);
    validateArguments(args,tool.parameters);
    const deadline = AbortSignal.any([signal,AbortSignal.timeout(tool.timeoutMs ?? 20000)]);
    let listener: (() => void) | undefined;
    try {
      return await Promise.race([tool.execute(args,deadline), new Promise<never>((_,reject) => {
        listener = () => reject(new Error(signal.aborted ? 'Tool cancelled' : 'Tool timed out'));
        deadline.addEventListener('abort',listener,{once:true}); if (deadline.aborted) listener();
      })]);
    } finally { if (listener) deadline.removeEventListener('abort',listener); }
  }
}
