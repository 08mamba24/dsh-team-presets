import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { assertHostExecutable, hostArchiveForExecutable, hostPathApi, hostVersionForArchive,
  isHostControlPath } from '../src/host-support.js';
import { checkedControlEntry } from '../src/team-driver.js';
import { prepareLauncher } from '../src/launcher-prepare.js';

const macArchive = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const windowsApps = [
  String.raw`C:\Users\DSH Operator\AppData\Local\Programs\DeepSeek Harness`,
  String.raw`C:\Program Files\DeepSeek Harness`,
];
const macRc2 = '1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d';
const macRc5 = '6f019878f523428f452957dbaad601c6468051df4093eda8af751ec65226f88e';
const windowsRc5 = '5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69';
const control = '@deepseek-ai/dsh-tool-subagent-control';

test('Windows locates app.asar beside the running per-user or Program Files installation', () => {
  for (const app of windowsApps) {
    const executable = `${app}\\DeepSeek Harness.exe`, expected = `${app}\\resources\\app.asar`;
    assert.equal(hostArchiveForExecutable(executable, 'win32'), expected);
    assert.equal(assertHostExecutable(executable, 'win32'), expected);
    assert.equal(assertHostExecutable(`${app}\\deepseek harness.EXE`, 'win32'), expected);
  }
});

test('Windows executable admission refuses CLI, relative, UNC and noncanonical paths', () => {
  for (const executable of [
    String.raw`C:\Program Files\nodejs\node.exe`, String.raw`C:\Program Files\DeepSeek Harness\electron.exe`,
    'DeepSeek Harness.exe', String.raw`C:DeepSeek Harness.exe`,
    String.raw`\\server\share\DeepSeek Harness.exe`, 'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe',
    String.raw`C:\Program Files\DeepSeek Harness\..\DeepSeek Harness\DeepSeek Harness.exe`,
    String.raw`C:\Program Files\\DeepSeek Harness\DeepSeek Harness.exe`,
  ]) assert.throws(() => assertHostExecutable(executable, 'win32'), { code: 'WRONG_HOST_PROCESS' }, executable);
});

test('macOS keeps the reviewed application boundary and other platforms remain unsupported', () => {
  assert.equal(assertHostExecutable('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', 'darwin'), macArchive);
  for (const executable of ['/usr/local/bin/node', '/Applications/DeepSeek Harness.app-copy/Contents/host']) {
    assert.throws(() => assertHostExecutable(executable, 'darwin'), { code: 'WRONG_HOST_PROCESS' });
  }
  assert.equal(hostPathApi('darwin'), posix);
  assert.equal(hostPathApi('win32'), win32);
  assert.throws(() => hostArchiveForExecutable('/usr/bin/node', 'linux'), { code: 'HOST_PLATFORM_UNSUPPORTED' });
});

test('archive admission binds the exact reviewed version and operating system together', () => {
  assert.equal(hostVersionForArchive(macRc2, 'darwin'), '0.2.2-rc.2');
  assert.equal(hostVersionForArchive(macRc5, 'darwin'), '0.2.2-rc.5');
  assert.equal(hostVersionForArchive(windowsRc5, 'win32'), '0.2.2-rc.5');
  for (const digest of [macRc2, macRc5]) assert.equal(hostVersionForArchive(digest, 'win32'), undefined);
  assert.equal(hostVersionForArchive(windowsRc5, 'darwin'), undefined);
  for (const platform of ['darwin', 'win32', 'linux']) assert.equal(hostVersionForArchive('0'.repeat(64), platform), undefined);
});

for (const [platform, path, archive] of [
  ['darwin', posix, macArchive], ['win32', win32, `${windowsApps[0]}\\resources\\app.asar`],
]) {
  test(`${platform} native control paths stay in this archive, including nested package layouts`, () => {
    const modules = path.join(archive, 'dsh', 'node_modules');
    for (const packageRoot of [path.join(modules, control), path.join(modules, '.pnpm', 'control@0.2.2-rc.5', 'node_modules', control)]) {
      for (const suffix of ['package.json', 'lib/index.js']) {
        const entry = path.join(packageRoot, suffix);
        assert.equal(isHostControlPath(entry, suffix, archive, platform), true);
        if (platform === 'win32') assert.equal(isHostControlPath(entry.toUpperCase(), suffix, archive, platform), true);
      }
    }
    const suffix = 'lib/index.js', ending = path.join('node_modules', control, suffix);
    for (const entry of [
      path.join(path.dirname(archive), 'other.asar', 'dsh', ending),
      path.join(archive, 'dsh', 'node_modules-other', control, suffix),
      path.join(archive, 'profile', ending),
      `${modules}${path.sep}..${path.sep}${ending}`,
      `${modules}${path.sep}${path.sep}${control.replaceAll('/', path.sep)}${path.sep}lib${path.sep}index.js`,
      path.join(modules, control, 'lib', 'index.js.bak'),
      path.join(modules, control, 'lib', 'private.js'),
      'relative/node_modules/' + control + '/lib/index.js',
    ]) assert.equal(isHostControlPath(entry, suffix, archive, platform), false, entry);
  });
}

test('control URLs admit the pinned Windows and macOS entries and reject alternate authority or paths', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalExecutable = Object.getOwnPropertyDescriptor(process, 'execPath');
  try {
    for (const [platform, path, executable, archive] of [
      ['darwin', posix, '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', macArchive],
      ...windowsApps.map(app => ['win32', win32, `${app}\\DeepSeek Harness.exe`, `${app}\\resources\\app.asar`]),
    ]) {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
      Object.defineProperty(process, 'execPath', { ...originalExecutable, value: executable });
      const entryPath = path.join(archive, 'dsh', 'node_modules', control, 'lib/index.js');
      const name = pathToFileURL(entryPath, { windows: platform === 'win32' }).href;
      const entry = { name, config: { interrupt: false } };
      assert.deepEqual(checkedControlEntry(entry), entry);
      const outside = pathToFileURL(path.join(path.dirname(archive), 'other.asar', 'dsh', 'node_modules', control, 'lib/index.js'),
        { windows: platform === 'win32' }).href;
      for (const invalid of [
        { ...entry, name: outside }, { ...entry, name: name + '?redirect=other' }, { ...entry, name: name + '#entry' },
        { ...entry, name: name.replace('file:///', 'file://untrusted/') },
        { ...entry, name: 'https://example.invalid/control.js' },
        { ...entry, config: { interrupt: true } }, { ...entry, config: { interrupt: false, extra: true } },
      ]) assert.throws(() => checkedControlEntry(invalid), { code: 'NATIVE_CONTROL_ENTRY_UNAVAILABLE' });
    }
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    Object.defineProperty(process, 'execPath', originalExecutable);
  }
});

test('Windows refuses historical file-bound preparation before creating workspace or output files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-windows-legacy-rejection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    await assert.rejects(prepareLauncher({
      sessionId: 'session-11111111-2222-4333-8444-555555555555',
      workspace, outputDir: join(root, 'prepared'), templatePath: join(root, 'template.json'),
    }), { code: 'LEGACY_BOUND_ENTRY_REQUIRES_MACOS' });
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  assert.deepEqual(await readdir(root), ['workspace']);
  assert.deepEqual(await readdir(workspace), []);
});
