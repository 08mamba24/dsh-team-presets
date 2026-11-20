import { test } from 'node:test';
import assert from 'node:assert/strict';
import moduleApi, { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeTeamFromHost } from '../src/team-host.js';

const archive = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const pin = '1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d';
const rc5Pin = '6f019878f523428f452957dbaad601c6468051df4093eda8af751ec65226f88e';
const windowsPin = '5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69';
const control = '@deepseek-ai/dsh-tool-subagent-control';
const controlRoot = `${archive}/dsh/node_modules/${control}`;

// Synthetic built-in/module boundaries only: no installed App, profile, Host or provider is read or started.
async function fixture(t, options = {}) {
  const platform = options.platform ?? 'darwin', hostPath = platform === 'win32' ? win32 : posix;
  const executable = options.executable ?? '/Applications/DeepSeek Harness.app/Contents/Frameworks/synthetic-host';
  const fixtureArchive = platform === 'win32' ? win32.join(win32.dirname(executable), 'resources', 'app.asar') : archive;
  const fixtureControlRoot = hostPath.join(fixtureArchive, 'dsh', 'node_modules', control);
  const defaultVersion = platform === 'win32' ? '0.2.2-rc.5' : '0.2.2-rc.2';
  const dir = await fsp.mkdtemp(join(tmpdir(), 'dsh-team-host-'));
  const subagentMetadata = join(dir, 'package.json'), subagentEntry = join(dir, 'subagent.mjs');
  await fsp.writeFile(subagentMetadata, JSON.stringify({ version: options.subagentVersion ?? defaultVersion }));
  await fsp.writeFile(subagentEntry, 'export function apply() {}');
  const originalRead = fsp.readFile, originalHash = crypto.createHash;
  const execPath = Object.getOwnPropertyDescriptor(process, 'execPath');
  const processPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const bytes = Buffer.from('synthetic owned archive for team Host boundary');
  const digest = originalHash('sha256').update(bytes).digest('hex');
  const stats = { rawReads: 0, subagentMetadataResolutions: 0, subagentEntryResolutions: 0,
    controlMetadataResolutions: 0, controlEntryResolutions: 0, controlMetadataReads: 0 };
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, 'execPath', execPath);
    Object.defineProperty(process, 'platform', processPlatform);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  Object.defineProperty(process, 'execPath', { ...execPath, value: executable });
  Object.defineProperty(process, 'platform', { ...processPlatform, value: platform });
  t.mock.method(crypto, 'createHash', algorithm => {
    assert.equal(algorithm, 'sha256'); const hash = originalHash(algorithm);
    return { update(chunk) { hash.update(chunk); return this; }, digest(encoding) {
      assert.equal(hash.digest(encoding), digest);
      return options.archiveDigest ?? (platform === 'win32' ? windowsPin : pin);
    } };
  });
  t.mock.method(fs, 'createReadStream', () => assert.fail('patched fs must not read the ASAR itself'));
  t.mock.method(fsp, 'readFile', async (path, ...args) => {
    if (path === (options.metadataPath ?? hostPath.join(fixtureControlRoot, 'package.json'))) {
      assert.ok(String(path).startsWith(hostPath.join(fixtureArchive, 'dsh', 'node_modules') + hostPath.sep), 'outside metadata must be refused before I/O');
      stats.controlMetadataReads++;
      return options.metadataText ?? JSON.stringify({ name: options.controlName ?? control, version: options.controlVersion ?? defaultVersion });
    }
    assert.equal(path, subagentMetadata, 'fixture must never read an installed App/profile');
    return originalRead(path, ...args);
  });
  t.mock.method(moduleApi, 'createRequire', anchor => {
    const require = name => {
      assert.equal(name, 'original-fs');
      return { async *createReadStream(path) { assert.equal(path, fixtureArchive); stats.rawReads++; yield bytes; } };
    };
    require.resolve = name => {
      assert.equal(anchor, hostPath.join(fixtureArchive, 'dsh', 'package.json'));
      if (name === '@deepseek-ai/dsh-tool-subagent/package.json') { stats.subagentMetadataResolutions++; return subagentMetadata; }
      if (name === '@deepseek-ai/dsh-tool-subagent') { stats.subagentEntryResolutions++; return subagentEntry; }
      if (name === `${control}/package.json`) { stats.controlMetadataResolutions++; return options.metadataPath ?? hostPath.join(fixtureControlRoot, 'package.json'); }
      assert.equal(name, control); stats.controlEntryResolutions++;
      if (options.missingExport) throw Object.assign(new Error('public control export unavailable'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      return options.entryPath ?? hostPath.join(fixtureControlRoot, 'lib/index.js');
    };
    return require;
  });
  syncBuiltinESMExports();
  return stats;
}

test('ordinary CLI is refused by the unchanged original Host guard', async () => {
  assert.ok(!process.execPath.startsWith('/Applications/DeepSeek Harness.app/Contents/'));
  await assert.rejects(nativeTeamFromHost(), /WRONG_HOST_PROCESS/);
});

test('pinned public control exports become an immutable preset entry without a bare-name fallback', async t => {
  const stats = await fixture(t);
  const result = await nativeTeamFromHost();
  assert.equal(typeof result.nativeSubagent.apply, 'function');
  assert.deepEqual(result.controlEntry, { name: pathToFileURL(`${controlRoot}/lib/index.js`, { windows: false }).href, config: { interrupt: false } });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.controlEntry) && Object.isFrozen(result.controlEntry.config));
  assert.deepEqual(stats, { rawReads: 1, subagentMetadataResolutions: 1, subagentEntryResolutions: 1,
    controlMetadataResolutions: 1, controlEntryResolutions: 1, controlMetadataReads: 1 });
});

test('the original ASAR and subagent-version guards run before any control resolution', async t => {
  for (const [options, error] of [[{ archiveDigest: '0'.repeat(64) }, /HOST_ARCHIVE_CHANGED/],
    [{ subagentVersion: '0.2.2-rc.1' }, /WRONG_HOST_VERSION/]]) {
    await t.test(String(error), async child => {
      const stats = await fixture(child, options);
      await assert.rejects(nativeTeamFromHost(), error);
      assert.equal(stats.controlMetadataResolutions, 0); assert.equal(stats.controlEntryResolutions, 0);
      assert.equal(stats.controlMetadataReads, 0);
    });
  }
});

test('rc.5 loads the matching public native control entry', async t => {
  const stats = await fixture(t, { archiveDigest: rc5Pin,
    subagentVersion: '0.2.2-rc.5', controlVersion: '0.2.2-rc.5' });
  const result = await nativeTeamFromHost();
  assert.equal(typeof result.nativeSubagent.apply, 'function');
  assert.equal(result.controlEntry.name, pathToFileURL(`${controlRoot}/lib/index.js`, { windows: false }).href);
  assert.equal(stats.controlMetadataReads, 1);
});

test('rc.5 refuses an rc.2 control package even though that version is supported on its own archive', async t => {
  await fixture(t, { archiveDigest: rc5Pin, subagentVersion: '0.2.2-rc.5' });
  await assert.rejects(nativeTeamFromHost(), /WRONG_CONTROL_HOST_VERSION/);
});

test('outside, traversing or mismatched public paths refuse before control metadata reads', async t => {
  const cases = [
    { metadataPath: '/tmp/unowned-control/package.json' },
    { entryPath: '/tmp/unowned-control/lib/index.js' },
    { entryPath: `${controlRoot}/../dsh-tool-subagent-control/lib/index.js` },
    { metadataPath: `${archive}/dsh/node_modules/.pnpm/other/node_modules/${control}/package.json` },
  ];
  for (let i = 0; i < cases.length; i++) await t.test(`untrusted path ${i + 1}`, async child => {
    const stats = await fixture(child, cases[i]);
    await assert.rejects(nativeTeamFromHost(), /CONTROL_EXPORT_OUTSIDE_PINNED_HOST/);
    assert.equal(stats.controlMetadataReads, 0);
  });
});

test('control package version, name and metadata errors refuse with no alternate module', async t => {
  const cases = [[{ controlVersion: '0.2.2-rc.1' }, /WRONG_CONTROL_HOST_VERSION/],
    [{ controlName: '@unowned/replacement' }, /WRONG_CONTROL_PACKAGE/],
    [{ metadataText: '{broken' }, /CONTROL_PACKAGE_METADATA_INVALID/]];
  for (const [options, error] of cases) await t.test(String(error), async child => {
    const stats = await fixture(child, options);
    await assert.rejects(nativeTeamFromHost(), error);
    assert.equal(stats.controlEntryResolutions, 1); assert.equal(stats.controlMetadataReads, 1);
  });
});

test('a missing public export is not replaced by a private path or another package root', async t => {
  const stats = await fixture(t, { missingExport: true });
  await assert.rejects(nativeTeamFromHost(), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.equal(stats.controlEntryResolutions, 1); assert.equal(stats.controlMetadataReads, 0);
});

for (const installDir of [String.raw`C:\Users\DSH Operator\AppData\Local\Programs\DeepSeek Harness`, String.raw`C:\Program Files\DeepSeek Harness`]) {
  test(`Windows control export uses an escaped file URL from ${installDir}`, async t => {
    const stats = await fixture(t, { platform: 'win32', executable: `${installDir}\\DeepSeek Harness.exe` });
    const result = await nativeTeamFromHost();
    const expectedPath = `${installDir}\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tool-subagent-control\\lib\\index.js`;
    assert.equal(result.controlEntry.name, pathToFileURL(expectedPath, { windows: true }).href);
    assert.match(result.controlEntry.name, /^file:\/\/\/C:\//);
    assert.ok(result.controlEntry.name.includes('%20'));
    assert.equal(stats.controlMetadataReads, 1);
  });
}

test('Windows refuses foreign archives, noncanonical paths and mismatched package roots before control reads', async t => {
  const installDir = String.raw`C:\Program Files\DeepSeek Harness`;
  const root = `${installDir}\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tool-subagent-control`;
  const cases = [
    { entryPath: String.raw`C:\Users\Operator\profile\node_modules\@deepseek-ai\dsh-tool-subagent-control\lib\index.js` },
    { entryPath: `${root}\\..\\dsh-tool-subagent-control\\lib\\index.js` },
    { entryPath: `${root}\\lib\\\\index.js` },
    { metadataPath: `${installDir}\\resources\\other.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tool-subagent-control\\package.json` },
    { metadataPath: `${installDir}\\resources\\app.asar\\dsh\\node_modules\\.pnpm\\other\\node_modules\\@deepseek-ai\\dsh-tool-subagent-control\\package.json` },
  ];
  for (let i = 0; i < cases.length; i++) await t.test(`untrusted Windows path ${i + 1}`, async child => {
    const stats = await fixture(child, { platform: 'win32', executable: `${installDir}\\DeepSeek Harness.exe`, ...cases[i] });
    await assert.rejects(nativeTeamFromHost(), /CONTROL_EXPORT_OUTSIDE_PINNED_HOST/);
    assert.equal(stats.controlMetadataReads, 0);
  });
});
