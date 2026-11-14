import { test } from 'node:test';
import assert from 'node:assert/strict';
import moduleApi, { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeSubagentFromHost } from '../src/host.js';

const archive = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const pin = '1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d';

// Synthetic Electron filesystem contract; never starts Electron or reads the installed App.
async function hostFixture(t, { digest = pin, version = '0.2.2-rc.2' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-host-'));
  const metadata = join(dir, 'package.json'), entry = join(dir, 'subagent.mjs');
  await writeFile(metadata, JSON.stringify({ version }));
  await writeFile(entry, 'export function apply() {}');
  const execPath = Object.getOwnPropertyDescriptor(process, 'execPath');
  const createHash = crypto.createHash, bytes = Buffer.from('owned synthetic ASAR archive');
  const fixtureDigest = createHash('sha256').update(bytes).digest('hex');
  let virtualReads = 0, rawReads = 0, metadataResolutions = 0, entryResolutions = 0;
  t.after(async () => {
    t.mock.restoreAll();syncBuiltinESMExports();
    Object.defineProperty(process, 'execPath', execPath);
    await rm(dir, { recursive: true, force: true });
  });
  Object.defineProperty(process, 'execPath', { ...execPath, value: '/Applications/DeepSeek Harness.app/Contents/Frameworks/fixture-host' });
  t.mock.method(fs, 'createReadStream', async function* (path) {
    assert.equal(path, archive);virtualReads++;
    throw Object.assign(new Error(`ENOENT,  not found in ${archive}`), { code: 'ENOENT' });
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
      return { async *createReadStream(path) { assert.equal(path, archive);rawReads++;yield bytes; } };
    };
    require.resolve = name => {
      assert.equal(anchor, `${archive}/dsh/package.json`);
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

test('native package version remains checked after reading the raw pinned archive', async t => {
  const stats = await hostFixture(t, { version: '0.2.2-rc.1' });
  await assert.rejects(nativeSubagentFromHost(), /WRONG_HOST_VERSION/);
  assert.deepEqual(stats(), { virtualReads: 0, rawReads: 1, metadataResolutions: 1, entryResolutions: 0 });
});
