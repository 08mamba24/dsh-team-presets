import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import * as host from '../src/host-support.js';

test('portable pinned bundle discovery derives resources from the exact executable layout', () => {
  for (const parent of ['/Applications', '/private/tmp/isolated host', '/Users/test/Apps']) {
    const app = `${parent}/DeepSeek Harness.app`;
    assert.equal(host.assertHostExecutable(`${app}/Contents/MacOS/DeepSeek Harness`, 'darwin'),
      `${app}/Contents/Resources/app.asar`);
  }
  for (const executable of ['/tmp/DeepSeek Harness',
    '/tmp/Renamed.app/Contents/MacOS/DeepSeek Harness',
    '/tmp/DeepSeek Harness.app/Contents/MacOS/node',
    '/tmp/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness',
    '/tmp/DeepSeek Harness.app/Contents/MacOS/../MacOS/DeepSeek Harness']) {
    assert.throws(() => host.assertHostExecutable(executable, 'darwin'), { code: 'WRONG_HOST_PROCESS' });
  }
});

async function bundle(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-bundle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, process.platform === 'win32' ? 'DeepSeek Harness' : 'DeepSeek Harness.app');
  const executable = process.platform === 'win32' ? join(app, 'DeepSeek Harness.exe') : join(app, 'Contents', 'MacOS', 'DeepSeek Harness');
  const archive = process.platform === 'win32' ? join(app, 'resources', 'app.asar') : join(app, 'Contents', 'Resources', 'app.asar');
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(executable, 'synthetic executable; never executed'); await writeFile(archive, 'synthetic archive');
  return { root, app, executable, archive };
}

test('canonical bundle checks keep executable and archive in the same real bundle', async t => {
  const b = await bundle(t);
  assert.equal(await host.assertCanonicalHostBundle(b.executable, process.platform, realpath), b.archive);
});

test('external executable or archive symlinks are rejected before reading archive bytes', async t => {
  for (const target of ['executable', 'archive']) {
    const b = await bundle(t), outside = join(b.root, `outside-${target}`);
    await writeFile(outside, 'foreign bytes'); await unlink(b[target]); await symlink(outside, b[target]);
    await assert.rejects(host.assertCanonicalHostBundle(b.executable, process.platform, realpath),
      { code: 'HOST_BUNDLE_PATH_CHANGED' });
  }
});

test('a bundle directory alias cannot substitute for its canonical owner', async t => {
  const b = await bundle(t), parent = join(b.root, 'alias-parent'); await mkdir(parent);
  const alias = join(parent, process.platform === 'win32' ? 'DeepSeek Harness' : 'DeepSeek Harness.app');
  await symlink(b.app, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(host.assertCanonicalHostBundle(join(alias, relative(b.app, b.executable)), process.platform, realpath),
    { code: 'HOST_BUNDLE_PATH_CHANGED' });
});
