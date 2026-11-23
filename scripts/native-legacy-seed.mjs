import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertCanonicalHostBundle, REVIEWED_HOSTS } from '../src/host-support.js';

/** Produce old Settings/JSONL with the old official Host, then close it before upgrade. */
export async function seedNativeLegacy({ executable, script, plugin, legacyPlugin, sourceHead, lab, mode = 'changed' }) {
  assert.ok(executable, 'alpha.2 migration requires the exact rc.5 Host executable');
  const raw = createRequire(import.meta.url)('original-fs');
  const archive = await assertCanonicalHostBundle(executable, process.platform, file => raw.realpathSync(file));
  const hash = createHash('sha256');
  for await (const chunk of raw.createReadStream(archive)) hash.update(chunk);
  const archiveSha256 = hash.digest('hex');
  assert.equal(archiveSha256, REVIEWED_HOSTS[process.platform]['0.2.2-rc.5']);
  const receipt = join(lab, `legacy-seed-${randomUUID()}.json`), resources = dirname(archive);
  const environment = { ...process.env, DSH_PRIMARY_RUNTIME: join(resources, 'runtime', 'primary-runtime') };
  if (process.platform === 'win32') environment.PATH = [join(resources, 'runtime', 'bin'),
    join(environment.SystemRoot, 'System32'), environment.SystemRoot].join(';');
  const child = spawn(executable, ['--expose-internals', script, join(archive, 'dsh'), plugin,
    receipt, sourceHead, legacyPlugin, mode, '', '--seed-legacy'],
  { cwd: join(lab, 'workspace'), env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', timedOut = false;
  const capture = chunk => { output = (output + chunk).slice(-65536); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  const outcome = await new Promise((done, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(timedOut, false, output); assert.equal(outcome.signal, null, output);
  assert.equal(outcome.code, 0, output);
  const bytes = await readFile(receipt), result = JSON.parse(bytes);
  assert.equal(result.sourceHead, sourceHead); assert.equal(result.hostVersion, '0.2.2-rc.5');
  assert.equal(result.passed, true, JSON.stringify(result.errors)); assert.deepEqual(result.errors, []);
  assert.ok(result.seed && typeof result.seed.rootId === 'string');
  return { ...result, archiveSha256, receiptSha256: createHash('sha256').update(bytes).digest('hex') };
}
