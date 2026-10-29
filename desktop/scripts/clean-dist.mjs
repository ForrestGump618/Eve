import {rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const target=fileURLToPath(new URL('../dist',import.meta.url));
if(!target.endsWith(`${process.platform==='win32'?'\\':'/'}dist`))throw new Error(`Refusing to clean unexpected path: ${target}`);
rmSync(target,{recursive:true,force:true});
