import type {Json} from './harness/types.js';
import {ValidationError} from './harness/types.js';

/** Backend identity is bound by the launcher, never by tool arguments. */
export interface ExecutionEnvironment {
  kind:'local'|'ssh';
  call(operation:string,args:Record<string,Json>,signal:AbortSignal):Promise<Json>;
}
export type PermissionMode='ask'|'review'|'full';
/** Both FastAPI's flat detail and the workbench's nested error contract. */
export function workspaceFailure(data:Record<string,Json>):string {
  const value=data.error??data.detail;
  if(typeof value==='string'&&value.trim())return value.slice(0,3000);
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    for(const key of ['message','detail','code']){
      const message=value[key];
      if(typeof message==='string'&&message.trim())return message.slice(0,3000);
    }
  }
  return 'Workspace operation failed';
}
export function permissionMode(value:Json|undefined):PermissionMode {
  if(value===undefined)return 'ask';
  if(value!=='ask'&&value!=='review'&&value!=='full')throw new ValidationError('Invalid task permission mode');
  return value;
}
