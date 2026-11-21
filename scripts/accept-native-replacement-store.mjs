/** Real SettingsForms/ConfigEditor/profile persistence; temporary profile only. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plugin = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const runtime = resolve(process.argv[2] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh');
const receipt = resolve(process.argv[4] ?? 'native-replacement-store.json');
const sourceHead = process.argv[5] ?? 'working-tree';
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
const [{ Context }, { Loader }, { ConfigEditor }, { SettingsForms }, boot] = await Promise.all([
  load('cordis'), load('cordis-plugin-loader'), load('dsh-config-editor'), load('dsh-settings'), load('dsh-app-boot'),
]);
const { Config } = await import(pathToFileURL(join(plugin, 'current-entry.js')).href);
const { createReplacementStore, REPLACEMENT_OWNER } = await import(pathToFileURL(join(plugin, 'src/replacement-store.js')).href);
const { startReplacement, readReplacementRecord } = await import(pathToFileURL(join(plugin, 'src/member-replacement.js')).href);
const ROOT = 'session-' + randomUUID(), OTHER = 'session-' + randomUUID(), OLD = 'session-' + randomUUID();
const isolated = await mkdtemp(join(tmpdir(), 'dsh-replacement-store-'));
const profileDir = join(isolated, 'profile'), home = join(isolated, 'home');
const patchPath = join(profileDir, 'cordis.patch.yml'), basePath = join(isolated, 'base.json');
await mkdir(profileDir); await mkdir(home);
await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
await writeFile(basePath, '[]\n');
await writeFile(patchPath, JSON.stringify([{ insert: [{ id: REPLACEMENT_OWNER, name: 'cordis:replacement-store-fixture',
  config: { mode: 'current-session', template: { sentinel: 'original-template' } } }] }]));
const checks = [];
let ctx;
async function start() {
  const context = new Context();
  ctx = context;
  await context.plugin(Loader, { baseUrl: pathToFileURL(join(runtime, 'package.json')).href });
  const state = { mounts: 0, disposals: 0, records: undefined };
  context.loader.builtins['replacement-store-fixture'] = { Config, apply(scope, raw) {
    state.mounts++; state.records = raw.replacementRecords;
    scope.effect(() => () => { state.disposals++; });
  } };
  context.provide('profileContext', { name: 'replacement-isolated', dir: profileDir, patchPath,
    home, cwd: isolated, installAnchor: join(runtime, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: '1' });
  await boot.mountRootInclude(context, basePath, boot.readProfilePatches('dsh', context.profileContext));
  await context.loader.await();
  await context.plugin(ConfigEditor); await context.plugin(SettingsForms);
  assert.equal(state.mounts, 1);
  return { context, state, store: createReplacementStore(context.settings, ROOT) };
}
const check = (name, evidence = {}) => checks.push({ name, passed: true, ...evidence });
try {
  let active = await start(); ctx = active.context;
  await active.store.ensure();
  const before = active.store.read(), firstRef = active.state.records;
  const record = startReplacement(readReplacementRecord(before.value), { role: 'implementer', oldChildId: OLD,
    handoffDigest: 'a'.repeat(64), taskRefs: [] }).record;
  assert.equal(await active.store.write(record, before.revision), true);
  assert.deepEqual(active.store.read().value, record);
  assert.equal(active.state.records, firstRef);
  assert.equal(active.state.mounts, 1); assert.equal(active.state.disposals, 0);
  assert.ok(Object.isFrozen(firstRef.get())); assert.ok(Object.isFrozen(firstRef.get()[ROOT]));
  check('real volatile root mutation persists without remount and updates the stable frozen projection');

  const stale = active.store.read().revision;
  await createReplacementStore(ctx.settings, OTHER).ensure();
  assert.equal(await active.store.write(record, stale), false);
  const row = ctx.settings.describe().find(row => row.ns === REPLACEMENT_OWNER);
  assert.deepEqual(row.value.template, { sentinel: 'original-template' });
  assert.deepEqual(row.value.replacementRecords[ROOT], record);
  assert.deepEqual(row.value.replacementRecords[OTHER], readReplacementRecord(undefined));
  check('whole-entry CAS detects other-root edits and preserves both roots and template');

  const staleTemplate = active.store.read().revision;
  await ctx.settings.update(REPLACEMENT_OWNER, { template: { sentinel: 'updated-template' } }, staleTemplate);
  assert.equal(await active.store.write(record, staleTemplate), false);
  check('template edits share the same native CAS revision');
  const persisted = await readFile(patchPath, 'utf8');
  assert.ok(persisted.includes(ROOT) && persisted.includes(OLD) && persisted.includes('replacementRecords'));
  check('real ConfigEditor writes the root record to the isolated profile patch',
    { patchSha256: createHash('sha256').update(persisted).digest('hex') });
  await ctx.fiber.dispose(); ctx = undefined;
  active = await start(); ctx = active.context;
  assert.deepEqual(active.store.read({ requirePartition: true }).value, record);
  assert.deepEqual(ctx.settings.describe().find(row => row.ns === REPLACEMENT_OWNER).value.template,
    { sentinel: 'updated-template' });
  check('a fresh Context and Loader reload the same retirement and template from disk');
} catch (error) {
  checks.push({ name: 'native persistence failure', passed: false,
    error: { code: error.code ?? null, message: error.message, stack: error.stack } });
} finally {
  if (ctx) await ctx.fiber.dispose();
  await rm(isolated, { recursive: true, force: true });
}
const result = { sourceHead, runtime, isolatedProfileRemoved: true, passed: checks.every(check => check.passed), checks };
await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.passed) process.exitCode = 1;
