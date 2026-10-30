import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktop, 'package.json'));
const args = process.argv.slice(2);
const outputArg = args.find(value => value.startsWith('--config.directories.output='));
const output = resolve(desktop, outputArg?.split('=').slice(1).join('=') ?? 'release');
const run = (command, parameters) => execFileSync(command, parameters, {cwd: desktop, stdio: 'inherit'});

const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Installer requires a three-part release version');
const name = `Eve-Setup-${pkg.version}-win-x64.exe`;
const target = join(output, name);
const staging = join(output, 'installer-build');
mkdirSync(staging, {recursive: true});
const source = join(desktop, 'installer', 'modern');
const frontend = join(staging, 'EveInstaller.exe');
const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(compiler)) throw new Error('The Windows .NET Framework compiler is required to build the installer frontend');
run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output',
  `/out:${frontend}`, `/win32manifest:${join(source, 'app.manifest')}`, `/win32icon:${join(desktop, 'assets', 'eve.ico')}`,
  '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
  `/resource:${join(source, 'theme.json')},theme.json`, join(source, 'Installer.cs')]);
const {copyFileSync} = await import('node:fs');
copyFileSync(frontend, join(source, 'EveInstaller.exe'));
if (!args.includes('--wrap-only')) {
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/generate-installer-assets.ps1']);
  run(process.execPath, ['scripts/clean-dist.mjs']);
  run(process.execPath, ['node_modules/typescript/bin/tsc']);
  run(process.execPath, ['scripts/copy-assets.mjs']);
  run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--x64', ...args]);
}

// Keep the tested backend intact; publication happens only after the wrapper
// has compiled successfully. No signed or previously released file is edited.
const engine = join(staging, 'EveEngine.exe');
if (!args.includes('--wrap-only') || !existsSync(engine)) copyFileSync(target, engine);
const caches = join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
const findCompiler = dir => {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'makensis.exe') return path;
    if (entry.isDirectory()) { const found = findCompiler(path); if (found) return found; }
  }
};
const nsis = readdirSync(caches).filter(name => name.startsWith('nsis')).sort().reverse()
  .map(name => findCompiler(join(caches, name))).find(Boolean);
if (!nsis) throw new Error('NSIS compiler not found in electron-builder cache');
const identity = JSON.parse(readFileSync(join(output, 'win-unpacked', 'resources', 'app', 'dist', 'build-info.json'), 'utf8'));
const wrapped = join(staging, name);
run(nsis, ['/V2', `/DOUTPUT=${wrapped}`, `/DFRONTEND=${frontend}`, `/DENGINE=${engine}`,
  `/DICON=${join(desktop, 'assets', 'eve.ico')}`, `/DVERSION=${pkg.version}`, `/DBUILD_ID=${identity.buildId}`,
  join(source, 'bootstrap.nsi')]);
renameSync(wrapped, target);

// The public executable changed, so regenerate differential-update metadata.
const {buildBlockMap} = require('app-builder-lib/out/targets/blockmap/blockmap.js');
await buildBlockMap(target, 'gzip', `${target}.blockmap`);
const bytes = readFileSync(target);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sha512 = createHash('sha512').update(bytes).digest('base64');
const latest = join(output, 'latest.yml');
if (existsSync(latest)) writeFileSync(latest, readFileSync(latest, 'utf8')
  .replace(/sha512: [^\r\n]+/g, `sha512: ${sha512}`).replace(/size: \d+/g, `size: ${bytes.length}`));
writeFileSync(join(output, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
writeFileSync(join(output, 'installer-build.json'), JSON.stringify({version: pkg.version, buildId: identity.buildId,
  frontend: 'Eve custom-painted Windows frontend', backend: 'silent electron-builder NSIS package',
  bytes: bytes.length, sha256, signed: false}, null, 2) + '\n');
console.log(`Eve installer: ${target}\n${bytes.length} bytes\nSHA-256 ${sha256}`);
