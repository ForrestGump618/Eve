import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
mkdirSync('dist/ui', {recursive:true});
cpSync('ui','dist/ui',{recursive:true});
cpSync('bundled-skills','dist/bundled-skills',{recursive:true});
cpSync('skill-library','dist/skill-library',{recursive:true});
// main lives under src/ because tests and application share one typecheck.
cpSync('src-entry.cjs','dist/main.js');
// Offline renderers for Markdown math/diagrams (generated into the build, not committed).
const katex = 'node_modules/katex/dist';
const mermaid = 'node_modules/mermaid/dist';
mkdirSync('dist/ui/vendor/katex/fonts', {recursive:true});
cpSync(join(katex,'katex.min.css'), 'dist/ui/vendor/katex/katex.min.css');
cpSync(join(katex,'katex.min.js'), 'dist/ui/vendor/katex/katex.min.js');
cpSync(join(katex,'fonts'), 'dist/ui/vendor/katex/fonts', {recursive:true});
mkdirSync('dist/ui/vendor/mermaid', {recursive:true});
cpSync(join(mermaid,'mermaid.min.js'), 'dist/ui/vendor/mermaid/mermaid.min.js');

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
for (const dir of ['src','ui','worker','bundled-skills','skill-library','../omicslab']) hashTree(dir);
digest.update(readFileSync('package.json'));
writeFileSync('dist/build-info.json', JSON.stringify({ buildId: digest.digest('hex') }) + '\n');
