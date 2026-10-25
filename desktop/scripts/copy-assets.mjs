import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync('dist/ui', {recursive:true});
cpSync('ui','dist/ui',{recursive:true});
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
