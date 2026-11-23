import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-host-compat.mjs', import.meta.url));
const supported = ['darwin', 'win32'].includes(process.platform);

test('compat CLI requires the intended Host executable instead of reading a daily default', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass --app-executable/);
});

test('compat CLI reads the explicitly selected relocated archive', { skip: !supported }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'DeepSeek Harness.app');
  const executable = process.platform === 'darwin' ? join(app, 'Contents/MacOS/DeepSeek Harness')
    : join(app, 'DeepSeek Harness.exe');
  const resources = process.platform === 'darwin' ? join(app, 'Contents/Resources') : join(app, 'resources');
  await mkdir(resources, { recursive: true });
  const archive = join(resources, 'app.asar');
  await writeFile(archive, 'owned unknown archive used only for the read-only CLI target test');
  const result = spawnSync(process.execPath, [script, '--app-executable', executable], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.archive, archive); assert.equal(report.status, 'UNREVIEWED_HOST_ARCHIVE');
});
