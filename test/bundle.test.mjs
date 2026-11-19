import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { composeEntries } from './fixtures/compose-rc2.mjs';
import { parseConfig } from '../src/config.js';
import { parseTeamConfig } from '../src/team-config.js';
import { parseLauncherConfig } from '../src/launcher-config.js';
import { apply as applyLauncherEntry } from '../launcher-entry.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('the generic launcher stays inert outside Harness and requires explicit configuration', async () => {
  let command;
  await applyLauncherEntry({ commands: { register: value => { command = value; } } }, {});
  assert.equal(command.name, 'dsh-team-launcher');
  assert.deepEqual(await command.handler(), { kind: 'error', text: 'NOT_CONFIGURED' });
});

test('the actual TGZ patch inserts one complete live entry without changing existing entries', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-live-bundle-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  let tgz = process.env.DSH_LIVE_CANDIDATE_TGZ;
  const generic = !tgz;
  let expected = { mode: 'current-session' };
  if (tgz) {
    assert.ok(process.env.DSH_LIVE_EXPECTED_CONFIG, 'a bound TGZ requires its independent expected config');
    expected = JSON.parse(await readFile(process.env.DSH_LIVE_EXPECTED_CONFIG, 'utf8'));
    assert.ok(expected.mode === 'launcher' ? parseLauncherConfig(expected)
      : expected.mode === 'team' ? parseTeamConfig(expected) : parseConfig(expected),
      'the candidate must contain the complete independent expected binding');
  } else {
    const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root });
    const [packed] = JSON.parse(stdout);tgz = join(scratch, packed.filename);
  }
  const provenance = JSON.parse(await readFile(new URL('./fixtures/compose-rc2.provenance.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('./fixtures/compose-rc2.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.adapterSha256);
  const { stdout } = await exec('tar', ['-xOzf', tgz, 'package/cordis.patch.yml']);
  // This bundle uses JSON, a YAML subset, so no test/runtime parser dependency is needed.
  const patch = JSON.parse(stdout);
  // The native installer validates this before composing entries. The
  // composition helper also accepts objects, so composition alone misses it.
  assert.equal(Array.isArray(patch), true, 'native cordis.patch.yml must be a top-level YAML array');
  const baseline = [{ insert: [
    { id: 'dsh-native-team-smoke-zero', name: 'dsh-team-smoke-rc2-local', config: { mode: 'dry-run' } },
    { id: 'unrelated-existing-entry', name: 'fixture', config: { nested: { keep: [1, 2] } } },
  ] }];
  const entryId = generic ? 'dsh-native-current-team' : expected.mode === 'launcher' ? 'dsh-native-team-launcher'
    : expected.mode === 'team' ? 'dsh-native-team-live-pair' : 'dsh-native-subagent-live-one';
  const entryName = generic ? 'dsh-subagent-live-rc2-local/current' : expected.mode === 'launcher' ? 'dsh-subagent-live-rc2-local/launcher'
    : expected.mode === 'team' ? 'dsh-subagent-live-rc2-local/team' : 'dsh-subagent-live-rc2-local';
  const original = structuredClone(baseline), warnings = [];
  const before = composeEntries([baseline]);
  assert.equal(before.filter(e => e.id === entryId).length, 0);
  const after = composeEntries([baseline, patch], warning => warnings.push(warning));
  const live = after.filter(e => e.id === entryId);
  assert.equal(live.length, 1, `first installation must create the entry; warnings: ${JSON.stringify(warnings)}`);
  assert.equal(after.length, before.length + 1);
  assert.equal(live[0].name, entryName);
  assert.deepEqual(live[0].config, expected);
  assert.deepEqual(after.filter(e => e.id !== live[0].id), before);
  assert.deepEqual(baseline, original);
  assert.deepEqual(warnings, []);
  if (expected.mode === 'team') {
    const { stdout: metadata } = await exec('tar', ['-xOzf', tgz, 'package/package.json']);
    const manifest = JSON.parse(metadata);
    assert.equal(manifest.exports['./team'], './team-entry.js');
    assert.equal(manifest.exports['./team-role'], './team-role.js');
    for (const path of ['team-entry.js', 'team-role.js', 'src/team-config.js', 'src/team-driver.js', 'src/team-gate.js']) {
      const { stdout: payload } = await exec('tar', ['-xOzf', tgz, `package/${path}`]);
      assert.ok(payload.length > 0, `missing pair payload: ${path}`);
    }
  }
  if (generic || expected.mode === 'launcher') {
    const { stdout: metadata } = await exec('tar', ['-xOzf', tgz, 'package/package.json']);
    const manifest = JSON.parse(metadata);
    assert.equal(manifest.exports['./launcher'], './launcher-entry.js');
    assert.equal(manifest.exports['./launcher-role'], './launcher-role.js');
    for (const path of ['launcher-entry.js', 'launcher-role.js', 'src/launcher-driver.js', 'src/launcher-board.js',
      'src/launcher-config.js', 'src/launcher-template.js', 'src/launcher-plan.js',
      'src/launcher-native.js', 'src/team-host.js', 'src/team-gate.js']) {
      const { stdout: payload } = await exec('tar', ['-xOzf', tgz, `package/${path}`]);
      assert.ok(payload.length > 0, `missing launcher payload: ${path}`);
    }
    if (generic) {
      assert.equal(manifest.exports['./current'], './current-entry.js');
      assert.equal(manifest.bin['dsh-team-prepare'], './scripts/prepare-launcher.mjs');
      for (const path of ['current-entry.js', 'src/launcher-current.js', 'scripts/prepare-launcher.mjs', 'src/launcher-prepare.js', 'examples/team-template.json', 'README.zh-CN.md']) {
        const { stdout: payload } = await exec('tar', ['-xOzf', tgz, `package/${path}`]);
        assert.ok(payload.length > 0, `missing setup payload: ${path}`);
      }
    }
  }
});
