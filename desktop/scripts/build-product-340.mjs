/** Package only the reviewed legacy baseline + this change's explicit overlays.
 * Unrelated work in the shared checkout stays untouched and out of the release. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {build,Platform} from 'electron-builder';
const repo=resolve('..'),stage=mkdtempSync(join(tmpdir(),'suwen-release-legacy-'));
const baseline=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const archive=join(stage,'baseline.tar');writeFileSync(archive,execFileSync('git',['archive','--format=tar','HEAD','omicslab','LICENSE'],{cwd:repo,maxBuffer:128*1024*1024}));
execFileSync('tar',['-xf',archive,'-C',stage],{windowsHide:true});
const overlays=['omicslab/runtime/desktop_harness.py','omicslab/server/routes.py','omicslab/server/routes_platform.py','omicslab/web/css/platform.css','omicslab/web/js/views/chat.js','omicslab/web/js/views/platform.js'];
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const file of overlays)cpSync(join(repo,file),join(stage,file));
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const config={...pkg.build,directories:{...pkg.build.directories,output:'release/product-340'},electronDist:resolve('node_modules/electron/dist'),extraResources:pkg.build.extraResources.map(item=>({...item,from:item.to==='legacy'?stage:resolve(item.from)}))};
// A separate config file prevents the package.json resource array from merging
// the shared working tree back into our reviewed snapshot.
const configPath=join(stage,'electron-builder.json');writeFileSync(configPath,JSON.stringify(config));
const paths=await build({targets:Platform.WINDOWS.createTarget(['nsis']),config:configPath});
writeFileSync(resolve('../docs/verification/product-340-20261026/release-provenance.json'),JSON.stringify({version:pkg.version,baseline,legacyStaging:stage,overlays:overlays.map(path=>({path,sha256:digest(join(repo,path))})),excludedUnrelatedChanges:['omicslab/cli.py','omicslab/integrations/'],artifacts:paths.filter(x=>x.endsWith('.exe')).map(path=>({path,sha256:digest(path)}))},null,2));
console.log(JSON.stringify(paths));
