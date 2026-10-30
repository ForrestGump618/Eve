import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path: string): string {
  return readFileSync(join(desktop, path), 'utf8');
}

function bmpSize(path: string): {width: number; height: number} {
  const data = readFileSync(join(desktop, path));
  assert.equal(data.toString('ascii', 0, 2), 'BM');
  assert.equal(data.readUInt16LE(28), 24);
  return {width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22))};
}

test('Windows installer uses branded pages instead of the default wizard flow', () => {
  const pkg = JSON.parse(read('package.json')) as {
    build: {
      directories: {buildResources?: string};
      nsis: Record<string, unknown>;
    };
    scripts: Record<string, string>;
  };
  assert.equal(pkg.build.directories.buildResources, 'installer');
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, true);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(pkg.build.nsis.include, 'installer.nsh');
  assert.equal(pkg.build.nsis.language, '2052');
  assert.match(pkg.scripts['dist:win'] ?? '', /generate:installer[\s\S]*--win nsis/);
  assert.match(pkg.scripts['generate:installer'] ?? '', /generate-installer-assets\.ps1/);

  const script = read('installer/installer.nsh');
  assert.match(script, /!include "UAC\.nsh"/);
  assert.match(script, /!macro customWelcomePage/);
  assert.match(script, /Page custom EveWelcomeShow EveWelcomeLeave/);
  assert.match(script, /EveWelcomeShow[\s\S]*EveElevatedResume == "1"[\s\S]*Abort/);
  assert.match(script, /!macro customHeader[\s\S]*EveDeferredWelcomeLeave/);
  assert.match(script, /!macro customFinishPage/);
  assert.match(script, /Page custom EveFinishShow EveFinishLeave/);
  assert.match(script, /!macro customUnWelcomePage/);
  assert.match(script, /UninstPage custom un\.EveUninstallShow un\.EveUninstallLeave/);
  assert.match(script, /!macro customUninstallPage/);
  assert.match(
    script,
    /UninstPage custom un\.EveUninstallFinishShow un\.EveUninstallFinishLeave/,
  );
  assert.match(script, /!macro customInit[\s\S]*UAC_IsInnerInstance[\s\S]*setInstallModePerUser/);
  assert.match(script, /!macro customInit[\s\S]*setInstallModePerAllUsers/);
  assert.match(script, /!macro customInstallMode[\s\S]*isForceMachineInstall[\s\S]*isForceCurrentInstall/);
  assert.match(script, /EveWelcomeLeave[\s\S]*UAC_RunElevated[\s\S]*安装尚未开始/);
  assert.match(script, /UAC_RunElevated[\s\S]*\$1 == 2[\s\S]*Return/);
  assert.match(
    script,
    /EveSelectCurrent[\s\S]*\$LOCALAPPDATA\\Programs\\Eve[\s\S]*EveSelectAllUsers[\s\S]*\$PROGRAMFILES64\\Eve/,
  );
  assert.match(script, /仅为我/);
  assert.match(script, /所有用户/);
  assert.doesNotMatch(script, /管理员|无需管理员权限/);
  assert.match(script, /!define EVE_ACCENT 0x3157D5/);
  assert.match(script, /DwmSetWindowAttribute/);
  assert.match(script, /StrCpy \$0 "0"[\s\S]*DwmSetWindowAttribute[\s\S]*i 20/);
  assert.doesNotMatch(script, /DwmSetWindowAttribute\(p \$HWNDPARENT, i 33/);
  assert.match(script, /SetWindowLongW/);
  assert.match(
    script,
    /!macro customPageAfterChangeDir\s+!define MUI_PAGE_CUSTOMFUNCTION_SHOW EveInstFilesShow\s+!macroend/,
  );
  assert.match(script, /MUI_PAGE_CUSTOMFUNCTION_SHOW un\.EveUninstFilesShow/);
  assert.match(script, /Function EveWelcomeInstall[\s\S]*EvePostNextBody/);
  assert.match(script, /EvePostNextBody[\s\S]*PostMessageW[\s\S]*BM_CLICK/);
  assert.match(script, /Function un\.EveUninstallStart[\s\S]*EvePostNextBody/);
  assert.match(
    script,
    /Function un\.EveUninstallFinish\s+Pop \$0\s+System::Call 'user32::PostMessageW\(p \$HWNDPARENT, i \$\{WM_CLOSE\}[\s\S]*?SetErrorLevel 0\s+Quit\s+FunctionEnd/,
  );
  assert.match(
    script,
    /Function un\.EveUninstallFinishLeave[\s\S]*?PostMessageW\(p \$HWNDPARENT, i \$\{WM_CLOSE\}[\s\S]*?SetErrorLevel 0\s+Quit\s+FunctionEnd/,
  );
  assert.match(script, /!macro customInstall[\s\S]*EvePostNextBody/);
  assert.match(script, /!macro customUnInstall[\s\S]*EvePostNextBody/);
  assert.doesNotMatch(script, /DetailPrint\s+"EVE_/);
  assert.match(
    script,
    /!macro EveInteractiveStatic[\s\S]*\$\{NSD_CreateLabel\}[\s\S]*!macroend/,
  );
  assert.doesNotMatch(
    script.match(/!macro EveProgressBody[\s\S]*?!macroend/)?.at(0) ?? '',
    /nsDialogs::|NSD_Create/,
  );
  assert.doesNotMatch(script, /w "BUTTON"/);
  assert.match(
    script,
    /!macro EveRawCommandStatic[\s\S]*?p \$\{ID\}[\s\S]*?!macroend/,
  );
  assert.match(
    script,
    /EveRawCommandStatic \$EveSecondary "" 450 346 106 40[\s\S]*?transparent[\s\S]*?\$\{EVE_STATIC_CENTER\} 2/,
  );
  assert.match(
    script,
    /!macro EveTextButton[\s\S]*?EveRawStatic \$EveButtonCaption[\s\S]*?EveTransparentClickTarget/,
  );
  assert.doesNotMatch(script, /"(?:Back|Next|Cancel)"/);
  assert.doesNotMatch(script, /NSD_CreateTimer|EveAdvanceWhenComplete|EveQueueAdvanceBody/);
  assert.doesNotMatch(script, /customUnInstallSection/);
  assert.match(script, /MUI_CUSTOMFUNCTION_UNGUIINIT un\.EveGuiInit/);
  assert.match(script, /System::Call 'USER32::SetWindowPos/);
  assert.doesNotMatch(script, /^\s*SetWindowPos\s/m);
  assert.match(script, /GetFullPathNameW/);
  assert.match(script, /GetRoot/);
  assert.match(script, /SelectFolderDialog/);
  assert.match(script, /EVE_MAX_INSTALL_PATH/);
  assert.match(script, /PathIsRelativeW/);
  assert.match(script, /PathIsUNCW/);
  assert.match(script, /StrStrW[\s\S]*上级目录标记/);
  assert.match(script, /PathIsPrefixW[\s\S]*Program Files/);
  assert.match(
    script,
    /EveSelectedInstallPath[\s\S]*EveNormalizePath[\s\S]*EvePathValid[\s\S]*PROGRAMFILES64\\Eve/,
  );
  assert.match(script, /SetOutPath \$PLUGINSDIR[\s\S]*File \/oname=eve-\$\{FILE\}/);
  assert.match(
    script,
    /LoadImageW[\s\S]*StrCpy \$\{HANDLE\} \$2[\s\S]*\$\{STM_SETIMAGE\} 0 \$2/,
  );
  assert.match(script, /SetWindowPos\(p \$EveDialog[\s\S]*0x54/);
  assert.match(script, /!macro EveShowPageBody[\s\S]*Call \$\{PREFIX\}EveFitPage/);
  assert.match(script, /ExecShell "open" "\$INSTDIR\\Eve\.exe"/);
  assert.match(script, /安装 Eve/);
  assert.match(script, /Eve 已安装到本机/);
  assert.match(script, /installerUninstallProgress\.bmp/);
  assert.doesNotMatch(
    script,
    /MUI_(?:UN)?PAGE_(?:WELCOME|FINISH)|installer(?:Sidebar|Header|Logo)\.bmp/,
  );
});

test('installer visual assets fill the custom window at deterministic dimensions', () => {
  const pages = [
    'installerWelcome.bmp',
    'installerProgress.bmp',
    'installerFinish.bmp',
    'installerUninstall.bmp',
    'installerUninstallProgress.bmp',
    'installerUninstallFinish.bmp',
  ];
  for (const page of pages) {
    assert.deepEqual(bmpSize(`installer/${page}`), {width: 620, height: 450});
    assert.ok(statSync(join(desktop, `installer/${page}`)).size > 500_000);
  }

  for (const legacy of [
    'installerSidebar.bmp',
    'installerHeader.bmp',
    'installerLogo.bmp',
  ]) {
    assert.equal(
      statSync(join(desktop, `installer/${legacy}`), {throwIfNoEntry: false}),
      undefined,
    );
  }

  const generator = read('scripts/generate-installer-assets.ps1');
  assert.match(generator, /\$pageWidth = 620/);
  assert.match(generator, /\$pageHeight = 450/);
  assert.match(generator, /Format24bppRgb/);
  for (const page of pages) {
    assert.match(generator, new RegExp(page.replace('.', '\\.')));
  }
});
