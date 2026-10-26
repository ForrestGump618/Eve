import type {Json} from './harness/types.js';
import {ValidationError} from './harness/types.js';

/** Backend identity is bound by the launcher, never by tool arguments. */
export interface ExecutionEnvironment {
  kind:'local'|'ssh';
  call(operation:string,args:Record<string,Json>,signal:AbortSignal):Promise<Json>;
}
export type PermissionMode='ask'|'review'|'full';
export function permissionMode(value:Json|undefined):PermissionMode {
  if(value===undefined)return 'ask';
  if(value!=='ask'&&value!=='review'&&value!=='full')throw new ValidationError('Invalid task permission mode');
  return value;
}
