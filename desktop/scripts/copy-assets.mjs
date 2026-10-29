import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
cpSync('bundled-skills','dist/bundled-skills',{recursive:true});
// The workbench's built-in Markdown workflows must be loadable by the same
// registry as scientific packages, rather than appearing only in a second UI.
// Generate ordinary, versioned instruction bundles; no second execution loop.
const EVE_RUNTIME_ADAPTATION = 'Eve 运行适配：这是按需加载的流程指引，加载不代表完成计算。只使用当前已注册工具。文中历史工具名不能直接调用；先 discover_tools 查询对应能力。文献/蛋白查询使用 database_search，数据检查使用 science_inspect；复杂计算先 write_file 保存脚本，再 run_shell 在当前工作区执行，SSH 不得回退本地。依赖缺失应明确报告。研究记录使用 research_list/research_create/research_record，但模型不能代替用户复核结题。';
for(const entry of readdirSync('../omicslab/skills',{withFileTypes:true}).filter(e=>e.isDirectory())){
  const source=join('../omicslab/skills',entry.name,'SKILL.md');
  const target=join('dist/bundled-skills',entry.name);
  if(!existsSync(source)||existsSync(join('bundled-skills',entry.name)))continue;
  const instructions=readFileSync(source,'utf8');
  const description=instructions.match(/^description:\s*(.+)$/m)?.[1]??entry.name;
  mkdirSync(target,{recursive:true});
  writeFileSync(join(target,'skill.json'),JSON.stringify({name:entry.name,description,version:'1.0.0',
    license:'Apache-2.0',entry:'SKILL.md',permissions:['network','filesystem','exec']},null,2));
  writeFileSync(join(target,'SKILL.md'),
    EVE_RUNTIME_ADAPTATION+'\n\n'+instructions);
}
// Locally bundled research skills (including wet-lab workflows) follow the
// same runtime contract even when they are copied instead of generated.
for(const entry of readdirSync('dist/bundled-skills',{withFileTypes:true}).filter(e=>e.isDirectory())){
  const target=join('dist/bundled-skills',entry.name,'SKILL.md');
  if(!existsSync(target))continue;
  const instructions=readFileSync(target,'utf8');
  if(!instructions.startsWith(EVE_RUNTIME_ADAPTATION))writeFileSync(target,EVE_RUNTIME_ADAPTATION+'\n\n'+instructions);
}
cpSync('skill-library','dist/skill-library',{recursive:true});
// main lives under src/ because tests and application share one typecheck.
cpSync('src-entry.cjs','dist/main.js');

// Terminal renderer stays local/offline and is loaded only when opened.
mkdirSync('../omicslab/web/vendor/xterm', {recursive:true});
for (const [source,name] of [
 ['@xterm/xterm/lib/xterm.js','xterm.js'],
 ['@xterm/xterm/css/xterm.css','xterm.css'],
 ['@xterm/addon-fit/lib/addon-fit.js','addon-fit.js'],
]) cpSync(join('node_modules',source),join('../omicslab/web/vendor/xterm',name));

// Include the hosted workbench and worker, not only the TypeScript shell.
// No user profiles, generated caches or credentials enter the build identity.
const digest = createHash('sha256');
function hashTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hashTree(path);
    else if (/\.(?:ts|js|cjs|mjs|py|json|html|css|pack|md|yaml|yml)$/.test(entry.name)) {
      digest.update(path.replaceAll('\\','/') + '\0').update(readFileSync(path)).update('\0');
    }
  }
}
for (const dir of ['src','worker','bundled-skills','skill-library','../omicslab']) hashTree(dir);
digest.update(readFileSync('package.json'));
digest.update(readFileSync('scripts/copy-assets.mjs'));
writeFileSync('dist/build-info.json', JSON.stringify({ buildId: digest.digest('hex') }) + '\n');
