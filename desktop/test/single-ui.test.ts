import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = (path: string): string => readFileSync(join(desktop, path), 'utf8');

test('desktop build contains exactly one hosted renderer', () => {
  assert.equal(existsSync(join(desktop, 'ui')), false, 'desktop/ui must stay deleted');
  assert.equal(existsSync(join(desktop, 'src/preload.cts')), false, 'legacy preload must stay deleted');
  assert.equal(existsSync(join(desktop, 'dist/ui')), false, 'legacy renderer must not enter dist');
  assert.equal(existsSync(join(desktop, 'dist/src/desktop-preload.cjs')), true);
  for (const retired of [
    'scripts/archify-e2e.mjs',
    'scripts/conversation-ui-e2e.mjs',
    'scripts/daemon-upgrade-e2e.mjs',
    'scripts/desktop-performance.mjs',
    'scripts/formal-ui-e2e.mjs',
    'scripts/product-100-e2e.mjs',
    'scripts/product-340-e2e.mjs',
    'scripts/reliability-ui-e2e.mjs',
    'scripts/research-workbench-e2e.mjs',
    'scripts/science-skills-e2e.mjs',
    'scripts/startup-build-e2e.mjs',
    'scripts/streaming-ui-e2e.mjs',
    'scripts/team-captain-e2e.mjs',
    'scripts/tray-e2e.mjs',
    'scripts/ui-dom-qa.mjs',
    'scripts/visual-audit.mjs',
    'scripts/workbench-ui-e2e.mjs',
    'scripts/workspace-tools-e2e.mjs',
    'test/desktop-ui.test.mjs',
    'test/markdown.test.ts',
    'test/stream-core.test.ts',
    'test/ui-comparison.mjs',
  ]) {
    assert.equal(existsSync(join(desktop, retired)), false, `${retired} must stay deleted`);
  }

  const packageJson = JSON.parse(source('package.json')) as {build?: {files?: string[]}};
  assert.equal(packageJson.build?.files?.some(value => /dist\/ui/.test(value)) ?? false, false);

  const main = source('src/main.ts');
  assert.doesNotMatch(main, /dist\/ui|(?<!desktop-)preload\.cjs|--native|suwen:events|suwen:connection/);
  assert.match(main, /The formal workbench is the only product home and the only renderer/);

  const copy = source('scripts/copy-assets.mjs');
  assert.doesNotMatch(copy, /cpSync\(['"]ui['"]|dist\/ui/);
});
