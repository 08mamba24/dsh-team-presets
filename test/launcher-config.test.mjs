import { test } from 'node:test';
import assert from 'node:assert/strict';
const posixTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'Legacy macOS file-bound entry' : false }, fn);
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLauncherConfig, readLauncherTemplate, assertLauncherOwned } from '../src/launcher-config.js';

const example = JSON.parse(await fs.readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, template = structuredClone(example)) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dsh-launcher-config-')));
  const workspace = join(root, 'owned'); await fs.mkdir(workspace, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const templatePath = join(workspace, '.dsh-team-template.json');
  const markerPath = join(workspace, '.dsh-team-launcher.json');
  const bytes = Buffer.from(JSON.stringify(template));
  await fs.writeFile(templatePath, bytes, { mode: 0o600 });
  const config = { mode: 'launcher', ownedSessionId: 'session-20000000-0000-4000-8000-000000000001',
    workspace, runTag: 'launcher-config-test', timeoutMs: 60000, templateSha256: hash(bytes),
    startup: { maxTokens: 1024, maxStreams: { implementer: 6, reviewer: 5 } } };
  const marker = { purpose: 'dsh-native-team-launcher', ownedSessionId: config.ownedSessionId,
    runTag: config.runTag, templateSha256: config.templateSha256 };
  await fs.writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  const agent = { id: config.ownedSessionId, session: { id: config.ownedSessionId, header: { cwd: workspace } } };
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined } };
  return { root, workspace, templatePath, markerPath, config, marker, agent, ctx };
}
const code = wanted => error => {
  assert.equal(error.code, wanted); assert.equal(error.message, wanted); return true;
};

test('configuration is strict, deeply frozen and contains no inferred authorization', async t => {
  const { config } = await fixture(t);
  assert.equal(parseLauncherConfig({}), null);
  const value = parseLauncherConfig(config);
  config.startup.maxStreams.implementer = 10;
  assert.equal(value.startup.maxStreams.implementer, 6);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.startup) && Object.isFrozen(value.startup.maxStreams));
  for (const change of [
    x => { x.allowedModels = []; }, x => { x.ownedSessionId = 'session-not-a-uuid'; },
    x => { x.workspace = '/tmp/owned/../other'; }, x => { x.workspace = 'relative'; },
    x => { x.runTag = '../tag'; }, x => { x.timeoutMs = 120001; }, x => { x.templateSha256 = 'wrong'; },
    x => { x.startup.maxTokens = 4096; }, x => { x.startup.maxStreams.implementer = 0; },
    x => { x.startup.maxStreams.reviewer = 13; }, x => { x.startup.maxStreams.other = 1; },
  ]) { const altered = structuredClone(config); change(altered); assert.throws(() => parseLauncherConfig(altered), code('INVALID_LAUNCHER_CONFIG')); }
});

posixTest('the two fixed owned files validate without writes and keep persona separate from startup prompt', async t => {
  const h = await fixture(t), before = await fs.readFile(h.templatePath), markerBefore = await fs.readFile(h.markerPath);
  const template = await readLauncherTemplate(h.config);
  assert.equal(template.members.length, 2); assert.ok(Object.isFrozen(template));
  assert.equal(template.members[0].prompt, example.members[0].prompt);
  assert.equal(template.members[0].personaPrompt, example.members[0].persona_prompt);
  assert.equal(await assertLauncherOwned(h.ctx, h.config, h.agent), true);
  assert.deepEqual(await fs.readFile(h.templatePath), before);
  assert.deepEqual(await fs.readFile(h.markerPath), markerBefore);
});

posixTest('template byte drift and marker binding changes are refused without disclosing content', async t => {
  const h = await fixture(t);
  await fs.appendFile(h.templatePath, ' ');
  await assert.rejects(readLauncherTemplate(h.config), code('LAUNCHER_TEMPLATE_SHA_MISMATCH'));
  for (const marker of [{ ...h.marker, templateSha256: '0'.repeat(64) }, { ...h.marker, runTag: 'other-run' },
    { ...h.marker, extra: 'unapproved' }]) {
    await fs.writeFile(h.markerPath, JSON.stringify(marker));
    await assert.rejects(assertLauncherOwned(h.ctx, h.config, h.agent), code('INVALID_LAUNCHER_MARKER_BINDING'));
  }
});

posixTest('a data-valid template still requires complete exact roles and an explicit effort', async t => {
  const cases = [
    [x => { delete x.members[0].persona_prompt; }, 'LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE'],
    [x => { delete x.members[0].agent_preset; }, 'LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE'],
    [x => { delete x.members[0].native_tool_allowlist; }, 'LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE'],
    [x => { delete x.members[0].reasoning_effort; }, 'LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE'],
    [x => { x.members.pop(); x.seed_tasks = []; }, 'LAUNCHER_EXACT_ROLES_REQUIRED'],
  ];
  for (const [change, expected] of cases) {
    const input = structuredClone(example); change(input); const h = await fixture(t, input);
    await assert.rejects(readLauncherTemplate(h.config), code(expected));
  }
});

posixTest('symlinks, hardlinks, permissive modes and oversized files never become owned inputs', async t => {
  for (const kind of ['template', 'marker']) for (const condition of ['symlink', 'hardlink', 'mode', 'size']) {
    const h = await fixture(t), path = kind === 'template' ? h.templatePath : h.markerPath;
    const expected = kind === 'template' ? 'INVALID_LAUNCHER_TEMPLATE_FILE' : 'INVALID_LAUNCHER_MARKER_FILE';
    if (condition === 'symlink') { const target = join(h.root, 'real-input'); await fs.rename(path, target); await fs.symlink(target, path); }
    if (condition === 'hardlink') await fs.link(path, join(h.root, 'second-link'));
    if (condition === 'mode') await fs.chmod(path, 0o644);
    if (condition === 'size') await fs.writeFile(path, Buffer.alloc(kind === 'template' ? 65537 : 4097));
    const operation = kind === 'template' ? readLauncherTemplate(h.config) : assertLauncherOwned(h.ctx, h.config, h.agent);
    await assert.rejects(operation, code(expected));
  }
});

posixTest('only the exact registered root and canonical workspace can use the existing marker', async t => {
  const h = await fixture(t);
  for (const agent of [{ ...h.agent }, { ...h.agent, id: 'wrong' },
    { ...h.agent, session: { ...h.agent.session, header: { ...h.agent.session.header, origin: 'subagent' } } }]) {
    await assert.rejects(assertLauncherOwned(h.ctx, h.config, agent), code('WRONG_AGENT'));
  }
  h.agent.session.header.cwd = join(h.workspace, '..');
  await assert.rejects(assertLauncherOwned(h.ctx, h.config, h.agent), code('WRONG_WORKSPACE'));
  const alias = join(h.root, 'alias'); await fs.symlink(h.workspace, alias);
  await assert.rejects(readLauncherTemplate({ ...h.config, workspace: alias }), code('LAUNCHER_WORKSPACE_NOT_CANONICAL'));
});

posixTest('inode replacement between lstat and open is detected before template bytes are trusted', async t => {
  const h = await fixture(t), replacement = join(h.root, 'replacement');
  await fs.writeFile(replacement, await fs.readFile(h.templatePath), { mode: 0o600 });
  const originalOpen = fs.open; let replaced = false;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, 'open', async (path, ...args) => {
    if (path === h.templatePath && !replaced) { replaced = true; await fs.rename(replacement, h.templatePath); }
    return originalOpen(path, ...args);
  });
  syncBuiltinESMExports();
  await assert.rejects(readLauncherTemplate(h.config), code('INVALID_LAUNCHER_TEMPLATE_FILE'));
  assert.equal(replaced, true);
});

posixTest('the exact live root is rechecked after marker I/O yields', async t => {
  const h = await fixture(t); let reads = 0;
  h.ctx.agents.get = () => ++reads === 1 ? h.agent : { ...h.agent };
  await assert.rejects(assertLauncherOwned(h.ctx, h.config, h.agent), code('WRONG_AGENT'));
  assert.equal(reads, 2);
});

posixTest('foreign ownership is refused before opening a configured file', async t => {
  const h = await fixture(t), originalLstat = fs.lstat;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, 'lstat', async (path, ...args) => {
    const stat = await originalLstat(path, ...args);
    if (path === h.templatePath) stat.uid = process.getuid() + 1;
    return stat;
  });
  t.mock.method(fs, 'open', () => assert.fail('foreign-owned file was opened'));
  syncBuiltinESMExports();
  await assert.rejects(readLauncherTemplate(h.config), code('INVALID_LAUNCHER_TEMPLATE_FILE'));
});

posixTest('missing or malformed fixed files return stable errors without paths or template text', async t => {
  const h = await fixture(t);
  await fs.writeFile(h.markerPath, '{broken');
  await assert.rejects(assertLauncherOwned(h.ctx, h.config, h.agent), code('INVALID_LAUNCHER_MARKER_JSON'));
  await fs.unlink(h.templatePath);
  await assert.rejects(readLauncherTemplate(h.config), error => {
    assert.equal(error.code, 'INVALID_LAUNCHER_TEMPLATE_FILE');
    assert.ok(!String(error).includes(h.workspace) && !String(error).includes(example.members[0].persona_prompt)); return true;
  });
  await fs.writeFile(h.templatePath, '{broken', { mode: 0o600 });
  await assert.rejects(readLauncherTemplate({ ...h.config, templateSha256: hash('{broken') }), code('INVALID_LAUNCHER_TEMPLATE_JSON'));
});
