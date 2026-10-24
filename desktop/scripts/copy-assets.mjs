import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/ui', {recursive:true});
cpSync('ui','dist/ui',{recursive:true});
// main lives under src/ because tests and application share one typecheck.
cpSync('src-entry.cjs','dist/main.js');

