import { test } from 'node:test';
import assert from 'node:assert/strict';
import moduleApi, { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { nativeHostFromApp, nativeSubagentFromHost } from '../src/host.js';

const archive = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const pin = '1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d';
const rc5Pin = '6f019878f523428f452957dbaad601c6468051df4093eda8af751ec65226f88e';
const windowsPin = '5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69';

// Synthetic Electron filesystem contract; never starts Electron or reads the installed App.
async function hostFixture(t, { platform = 'darwin',
  executable = '/Applications/DeepSeek Harness.app/Contents/Frameworks/fixture-host',
  digest = platform === 'win32' ? windowsPin : pin, version = platform === 'win32' ? '0.2.2-rc.5' : '0.2.2-rc.2' } = {}) {
  const hostPath = platform === 'win32' ? win32 : posix;
  const fixtureArchive = platform === 'win32' ? win32.join(win32.dirname(executable), 'resources', 'app.asar') : archive;
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-host-'));
  const metadata = join(dir, 'package.json'), entry = join(dir, 'subagent.mjs');
  await writeFile(metadata, JSON.stringify({ version }));
  await writeFile(entry, 'export function apply() {}');
  const execPath = Object.getOwnPropertyDescriptor(process, 'execPath');
  const processPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const createHash = crypto.createHash, bytes = Buffer.from('owned synthetic ASAR archive');
  const fixtureDigest = createHash('sha256').update(bytes).digest('hex');
  let virtualReads = 0, rawReads = 0, metadataResolutions = 0, entryResolutions = 0;
  t.after(async () => {
    t.mock.restoreAll();syncBuiltinESMExports();
    Object.defineProperty(process, 'execPath', execPath);
    Object.defineProperty(process, 'platform', processPlatform);
    await rm(dir, { recursive: true, force: true });
  });
  Object.defineProperty(process, 'execPath', { ...execPath, value: executable });
  Object.defineProperty(process, 'platform', { ...processPlatform, value: platform });
  t.mock.method(fs, 'createReadStream', async function* (path) {
    assert.equal(path, fixtureArchive);virtualReads++;
    throw Object.assign(new Error(`ENOENT,  not found in ${fixtureArchive}`), { code: 'ENOENT' });
  });
  t.mock.method(crypto, 'createHash', algorithm => {
    const hash = createHash(algorithm);assert.equal(algorithm, 'sha256');
    return { update(chunk) { hash.update(chunk);return this; }, digest(encoding) {
      assert.equal(hash.digest(encoding), fixtureDigest);
      return digest; // Only the fixture's verified bytes stand in for the pinned archive.
    } };
  });
  t.mock.method(moduleApi, 'createRequire', anchor => {
    const require = name => {
      assert.equal(name, 'original-fs');
      return { async *createReadStream(path) { assert.equal(path, fixtureArchive);rawReads++;yield bytes; } };
    };
    require.resolve = name => {
      assert.equal(anchor, hostPath.join(fixtureArchive, 'dsh', 'package.json'));
      if (name === '@deepseek-ai/dsh-tool-subagent/package.json') { metadataResolutions++;return metadata; }
      assert.equal(name, '@deepseek-ai/dsh-tool-subagent');entryResolutions++;return entry;
    };
    return require;
  });
  syncBuiltinESMExports();
  return () => ({ virtualReads, rawReads, metadataResolutions, entryResolutions });
}

test('an ordinary CLI cannot load a daily Desktop native module as a substitute Host', async () => {
  assert.ok(!process.execPath.startsWith('/Applications/DeepSeek Harness.app/Contents/'));
  await assert.rejects(nativeSubagentFromHost(), /WRONG_HOST_PROCESS/);
});

test('archive checksum reads raw bytes while public package loading keeps ASAR resolution', async t => {
  const stats = await hostFixture(t);
  const result = await nativeSubagentFromHost();
  assert.equal(typeof result.apply, 'function');
  assert.deepEqual(stats(), { virtualReads: 0, rawReads: 1, metadataResolutions: 1, entryResolutions: 1 });
});

test('a changed raw archive is refused before resolving a native package', async t => {
  const stats = await hostFixture(t, { digest: '0'.repeat(64) });
  await assert.rejects(nativeSubagentFromHost(), /HOST_ARCHIVE_CHANGED/);
  assert.deepEqual(stats(), { virtualReads: 0, rawReads: 1, metadataResolutions: 0, entryResolutions: 0 });
});

test('the reviewed rc.5 archive loads its matching native package', async t => {
  const stats = await hostFixture(t, { digest: rc5Pin, version: '0.2.2-rc.5' });
  assert.equal(typeof (await nativeSubagentFromHost()).apply, 'function');
  assert.equal(stats().entryResolutions, 1);
});

test('an rc.5 version cannot borrow the reviewed rc.2 archive identity', async t => {
  const stats = await hostFixture(t, { version: '0.2.2-rc.5' });
  await assert.rejects(nativeSubagentFromHost(), /WRONG_HOST_VERSION/);
  assert.equal(stats().entryResolutions, 0);
});

test('native package version remains checked after reading the raw pinned archive', async t => {
  const stats = await hostFixture(t, { version: '0.2.2-rc.1' });
  await assert.rejects(nativeSubagentFromHost(), /WRONG_HOST_VERSION/);
  assert.deepEqual(stats(), { virtualReads: 0, rawReads: 1, metadataResolutions: 1, entryResolutions: 0 });
});

for (const installDir of [String.raw`C:\Users\DSH Operator\AppData\Local\Programs\DeepSeek Harness`, String.raw`C:\Program Files\DeepSeek Harness`]) {
  test(`Windows raw archive and package resolution follow the running app at ${installDir}`, async t => {
    const stats = await hostFixture(t, { platform: 'win32', executable: `${installDir}\\DeepSeek Harness.exe` });
    const result = await nativeHostFromApp();
    assert.equal(result.platform, 'win32');
    assert.equal(result.archive, `${installDir}\\resources\\app.asar`);
    assert.equal(result.version, '0.2.2-rc.5');
    assert.equal(typeof result.nativeSubagent.apply, 'function');
    assert.deepEqual(stats(), { virtualReads: 0, rawReads: 1, metadataResolutions: 1, entryResolutions: 1 });
  });
}

test('a Windows Host cannot borrow a reviewed macOS archive digest', async t => {
  const stats = await hostFixture(t, { platform: 'win32', executable: String.raw`C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe`, digest: rc5Pin });
  await assert.rejects(nativeSubagentFromHost(), /HOST_ARCHIVE_CHANGED/);
  assert.deepEqual(stats(), { virtualReads: 0, rawReads: 1, metadataResolutions: 0, entryResolutions: 0 });
});
