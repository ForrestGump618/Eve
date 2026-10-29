// Real Edge fixture for the first-run model connection prompt.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../desktop/node_modules/playwright-core/index.mjs';

const web = fileURLToPath(new URL('../omicslab/web/', import.meta.url));
const output = fileURLToPath(new URL('../docs/verification/onboarding-refresh/', import.meta.url));
const appearance = {
  theme: 'light',
  font: 'system',
  font_size: 14,
  accent: '#3157D5',
  density: 'comfortable',
  radius: 12,
  mode: 'research',
  home: 'workbench',
  onboarded: false,
  agent_name: 'Eve',
  avatar: '',
  shortcuts: {palette: 'k'},
};

const fixture = `<!doctype html><html lang="zh-CN" data-theme="light"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['base', 'components', 'views', 'studio', 'platform'].map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:var(--bg)}#fixture{color:var(--text-2);font:13px var(--font-sans)}</style>
</head><body><main id="fixture">Eve workbench</main><script type="module">
window.openOnboarding = async () => {
  const {initPlatform} = await import('/js/suwen.js');
  await initPlatform();
};
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__onboarding-test') {
      res.writeHead(200, {'content-type': 'text/html;charset=utf-8'});
      res.end(fixture);
      return;
    }
    if (url.pathname === '/api/platform/bootstrap') {
      res.writeHead(200, {'content-type': 'application/json;charset=utf-8'});
      res.end(JSON.stringify({settings: {appearance: {value: appearance}}, workspaces: []}));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404, {'content-type': 'application/json;charset=utf-8'});
      res.end(JSON.stringify({error: {message: `Unexpected fixture endpoint: ${url.pathname}`}}));
      return;
    }
    const target = path.resolve(web, '.' + decodeURIComponent(url.pathname));
    const relative = path.relative(web, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': target.endsWith('.js') ? 'text/javascript;charset=utf-8'
        : target.endsWith('.css') ? 'text/css;charset=utf-8' : 'application/octet-stream',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(500);
    res.end(error.message);
  }
});

await mkdir(output, {recursive: true});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({channel: process.env.EVE_BROWSER_CHANNEL || 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/__onboarding-test`);
  await page.evaluate(() => {
    localStorage.clear();
    return window.openOnboarding();
  });

  const dialog = page.getByRole('dialog', {name: '连接模型'});
  await dialog.waitFor();
  await page.waitForTimeout(250);
  assert.equal(await dialog.locator('.modal-title').textContent(), '连接模型');
  assert.equal(await dialog.locator('.modal-foot .btn').count(), 1);
  assert.equal(await dialog.locator('.modal-foot .btn').textContent(), '连接模型');
  assert.equal(await dialog.locator('.modal-foot .btn-primary').count(), 1);
  assert.equal(await dialog.locator('.sw-onboarding-purpose').count(), 1);
  assert.equal(await dialog.locator('[data-onboarding-optout]').isChecked(), true);

  const desktop = await dialog.evaluate(node => {
    const modal = node.getBoundingClientRect();
    const title = node.querySelector('.modal-title');
    const purpose = node.querySelector('.sw-onboarding-purpose');
    const button = node.querySelector('.modal-foot .btn-primary');
    const titleStyle = getComputedStyle(title);
    const purposeStyle = getComputedStyle(purpose);
    const buttonRect = button.getBoundingClientRect();
    return {
      modalWidth: modal.width,
      modalLeft: modal.left,
      modalRight: modal.right,
      titleWhiteSpace: titleStyle.whiteSpace,
      titleOverflow: titleStyle.overflow,
      titleFits: title.scrollWidth <= title.clientWidth + 1 && title.scrollHeight <= title.clientHeight + 1,
      purposeFontSize: parseFloat(purposeStyle.fontSize),
      purposeLineHeight: parseFloat(purposeStyle.lineHeight),
      purposeLines: Math.round(purpose.getBoundingClientRect().height / parseFloat(purposeStyle.lineHeight)),
      purposeFits: purpose.scrollWidth <= purpose.clientWidth + 1 && purpose.scrollHeight <= purpose.clientHeight + 1,
      buttonHeight: buttonRect.height,
      optoutFocused: document.activeElement === node.querySelector('[data-onboarding-optout]'),
      viewportWidth: innerWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(desktop.titleWhiteSpace, 'normal');
  assert.equal(desktop.titleOverflow, 'visible');
  assert.equal(desktop.titleFits, true);
  assert.equal(desktop.purposeFits, true);
  assert.equal(desktop.purposeLines, 1);
  assert.ok(desktop.purposeFontSize >= 15);
  assert.ok(desktop.purposeLineHeight / desktop.purposeFontSize >= 1.55);
  assert.ok(desktop.buttonHeight >= 40, JSON.stringify(desktop));
  assert.equal(desktop.optoutFocused, true);
  assert.ok(desktop.modalWidth <= 464.5);
  assert.ok(desktop.modalLeft >= 0 && desktop.modalRight <= desktop.viewportWidth);
  assert.equal(desktop.pageOverflow, false);
  await page.screenshot({path: path.join(output, 'onboarding-desktop.png'), animations: 'disabled'});

  await page.setViewportSize({width: 390, height: 844});
  await page.waitForTimeout(220);
  const mobile = await dialog.evaluate(node => {
    const modal = node.getBoundingClientRect();
    const title = node.querySelector('.modal-title');
    const purpose = node.querySelector('.sw-onboarding-purpose');
    const optout = node.querySelector('.sw-onboarding-optout');
    const button = node.querySelector('.modal-foot .btn-primary').getBoundingClientRect();
    return {
      modalLeft: modal.left,
      modalRight: modal.right,
      modalWidth: modal.width,
      titleFits: title.scrollWidth <= title.clientWidth + 1 && title.scrollHeight <= title.clientHeight + 1,
      purposeFits: purpose.scrollWidth <= purpose.clientWidth + 1 && purpose.scrollHeight <= purpose.clientHeight + 1,
      optoutFits: optout.scrollWidth <= optout.clientWidth + 1,
      buttonHeight: button.height,
      viewportWidth: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(mobile.titleFits, true);
  assert.equal(mobile.purposeFits, true);
  assert.equal(mobile.optoutFits, true);
  assert.ok(mobile.buttonHeight >= 40);
  assert.ok(mobile.modalLeft >= 0 && mobile.modalRight <= mobile.viewportWidth);
  assert.equal(mobile.overflow, false);
  await page.screenshot({path: path.join(output, 'onboarding-mobile.png'), animations: 'disabled'});

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(220);
  const dark = await dialog.evaluate(node => {
    const parseRgb = value => (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
    const luminance = value => {
      const channels = parseRgb(value).map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (foreground, background) => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const modalStyle = getComputedStyle(node);
    const buttonStyle = getComputedStyle(node.querySelector('.modal-foot .btn-primary'));
    const purposeStyle = getComputedStyle(node.querySelector('.sw-onboarding-purpose'));
    return {
      surface: modalStyle.backgroundColor,
      buttonBackground: buttonStyle.backgroundColor,
      buttonImage: buttonStyle.backgroundImage,
      buttonColor: buttonStyle.color,
      purposeColor: purposeStyle.color,
      buttonContrast: contrast(buttonStyle.color, buttonStyle.backgroundColor),
      purposeContrast: contrast(purposeStyle.color, modalStyle.backgroundColor),
    };
  });
  assert.equal(dark.buttonBackground, 'rgb(142, 168, 255)');
  assert.equal(dark.buttonImage, 'none');
  assert.equal(dark.buttonColor, 'rgb(23, 27, 33)');
  assert.ok(dark.buttonContrast >= 4.5);
  assert.ok(dark.purposeContrast >= 4.5);
  await page.screenshot({path: path.join(output, 'onboarding-dark-mobile.png'), animations: 'disabled'});

  // Choosing not to remember keeps the prompt eligible for the next launch.
  await dialog.locator('[data-onboarding-optout]').uncheck();
  await dialog.locator('.modal-close').click();
  await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('omicslab.onboardingDismissed'))), false);
  await page.evaluate(() => window.openOnboarding());
  await dialog.waitFor();

  // The default checked state suppresses the prompt after the user acts.
  assert.equal(await dialog.locator('[data-onboarding-optout]').isChecked(), true);
  await dialog.locator('.modal-foot .btn-primary').click();
  await page.waitForFunction(() => location.hash === '#/settings' && !document.querySelector('.modal-backdrop'));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('omicslab.onboardingDismissed'))), true);
  await page.evaluate(() => window.openOnboarding());
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.modal-backdrop').count(), 0);
  assert.deepEqual(errors, []);

  await writeFile(path.join(output, 'onboarding-browser-results.json'), JSON.stringify({
    browser: await browser.version(),
    checks: [
      'single primary action',
      'wrapped title and purpose typography',
      'desktop and mobile containment',
      'focus placement',
      'dark mode contrast and solid accent',
      'opt-out unchecked keeps next prompt',
      'opt-out checked suppresses next prompt',
    ],
    viewports: ['1440x900', '390x844'],
    desktop,
    mobile,
    dark,
    errors,
  }, null, 2));
  console.log(`Onboarding UI checks passed; screenshots: ${output}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
