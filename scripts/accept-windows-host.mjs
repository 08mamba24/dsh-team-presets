#!/usr/bin/env node
/**
 * Real Windows Desktop Host lifecycle plus native scripted replacement acceptance.
 * Run with ordinary Node; it relaunches this file under the installed Electron.
 * Upstream dsh-v0.2.2-rc.5 sources owning this route:
 * - apps/desktop/scripts/smoke-runtime.ts: isolated profile, CLI and authenticated Host.
 * - apps/desktop/src/project-manager.ts: initProfile(PROFILE_TEMPLATES.web.bundles).
 * - apps/desktop/src/host-process.ts and apps/desktop-host/src/index.ts: argv and IPC.
 * - packages/interaction/commands/src/index.ts: execute never submits to a model.
 * - Packaged dsh-commands/lib/typert.host.js: agent lookup is named agentId on wire.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hostVersionForArchive } from '../src/host-support.js';

const PACKAGE = 'dsh-subagent-live-rc2-local';
const TIMEOUT = 120_000;
const SHUTDOWN_TIMEOUT = 30_000;
const usage = 'node scripts/accept-windows-host.mjs --install-dir <installed app directory> --tgz <package.tgz> --lab-dir <new temporary directory> --receipt-dir <evidence directory>';
const { values } = parseArgs({ options: {
  'install-dir': { type: 'string' }, tgz: { type: 'string' },
  'previous-tgz': { type: 'string' },
  'legacy-plugin': { type: 'string' },
  'multi-role-legacy-plugin': { type: 'string' },
  'legacy-host-executable': { type: 'string' },
  'lab-dir': { type: 'string' }, 'receipt-dir': { type: 'string' },
  'electron-stage': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
}, allowPositionals: false });

const scrub = text => String(text).replace(/https?:\/\/[^\s"'<>]+/g, match => {
  try { const url = new URL(match); url.search = ''; url.hash = ''; return url.href; }
  catch { return '[url]'; }
}).replace(/(dsh-auth-[^=;\s]+)=([^;\s]+)/gi, '$1=[redacted]');

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function sha256(path, stream = createReadStream) {
  const hash = createHash('sha256');
  for await (const chunk of stream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function pathsFor(options) {
  for (const option of ['install-dir', 'tgz', 'lab-dir', 'receipt-dir']) {
    assert.ok(options[option], `${usage}\nMissing --${option}`);
  }
  const install = resolve(options['install-dir']), lab = resolve(options['lab-dir']);
  const resources = join(install, 'resources'), runtime = join(resources, 'app.asar', 'dsh');
  const home = join(lab, 'os-home'), harness = join(lab, 'harness');
  return { install, lab, resources, runtime, home, harness,
    executable: join(install, 'DeepSeek Harness.exe'), tgz: resolve(options.tgz),
    previousTgz: options['previous-tgz'] ? resolve(options['previous-tgz']) : undefined,
    legacyPlugin: options['legacy-plugin'] ? resolve(options['legacy-plugin']) : undefined,
    multiRoleLegacyPlugin: options['multi-role-legacy-plugin'] ? resolve(options['multi-role-legacy-plugin']) : undefined,
    legacyHostExecutable: options['legacy-host-executable'] ? resolve(options['legacy-host-executable']) : undefined,
    receipts: resolve(options['receipt-dir']), profile: join(harness, 'profiles', 'desktop'),
    agents: join(lab, 'agents'), workspace: join(lab, 'workspace'), temporary: join(lab, 'tmp'),
    cli: join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    host: join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
    primary: join(resources, 'runtime', 'primary-runtime'),
    pnpm: join(resources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    nodeBin: join(resources, 'runtime', 'bin'),
  };
}

// Child-only environment, not a mutation of the operator's HOME or shell.
// Official home-paths supports DSH_HOME and DSH_AGENTS_HOME. Desktop profile is
// argv[3]; CLI resolves DSH_HOME/profiles/desktop. No DSH_PROFILE_PATH is used.
function isolatedEnvironment(paths) {
  const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(system, 'Windows SystemRoot is required');
  const root = parse(paths.home).root;
  return {
    SystemRoot: system, WINDIR: system, ComSpec: join(system, 'System32', 'cmd.exe'),
    PATH: [paths.nodeBin, join(system, 'System32'), system, join(system, 'System32', 'Wbem')].join(';'),
    HOME: paths.home, USERPROFILE: paths.home, HOMEDRIVE: root.slice(0, 2), HOMEPATH: paths.home.slice(2),
    APPDATA: join(paths.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(paths.home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(paths.home, 'config'), XDG_CACHE_HOME: join(paths.home, 'cache'),
    XDG_DATA_HOME: join(paths.home, 'data'), XDG_STATE_HOME: join(paths.home, 'state'),
    TEMP: paths.temporary, TMP: paths.temporary,
    DSH_HOME: paths.harness, DSH_AGENTS_HOME: paths.agents, DSH_TELEMETRY_DISABLED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    npm_config_userconfig: join(paths.lab, 'npmrc'), npm_config_globalconfig: join(paths.lab, 'npmrc'),
    npm_config_store_dir: join(paths.lab, 'pnpm-store'), npm_config_enable_global_virtual_store: 'false',
  };
}

async function launchDriver(paths) {
  assert.ok((await stat(paths.executable)).isFile(), 'installed executable missing');
  assert.ok((await stat(paths.tgz)).isFile(), 'package TGZ missing');
  await mkdir(paths.lab); // Existing labs are refused; no daily profile can be adopted.
  const environment = isolatedEnvironment(paths);
  await Promise.all([paths.home, paths.harness, paths.agents, paths.workspace, paths.temporary,
    paths.receipts, environment.APPDATA, environment.LOCALAPPDATA].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(paths.lab, 'npmrc'), '', { flag: 'wx' });
  const child = spawn(paths.executable, ['--expose-internals', fileURLToPath(import.meta.url),
    ...process.argv.slice(2), '--electron-stage'], {
    cwd: paths.workspace, env: environment, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  });
  const result = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  assert.equal(result.code, 0, `Electron acceptance driver failed (${result.code ?? result.signal})`);
}

async function accept(paths) {
  assert.ok(process.versions.electron, 'driver must run under installed Electron');
  assert.equal((await realpath(process.execPath)).toLowerCase(), (await realpath(paths.executable)).toLowerCase());
  const environment = isolatedEnvironment(paths);
  for (const key of ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_AGENTS_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    assert.equal(process.env[key], environment[key], `driver isolation mismatch: ${key}`);
  }
  assert.deepEqual(await readdir(paths.harness), [], 'Harness home must be fresh');
  assert.deepEqual(await readdir(paths.agents), [], 'shared agents home must be fresh');
  const report = {
    schemaVersion: 1, kind: 'dsh-team-windows-host-acceptance', status: 'failed',
    startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    scope: 'Official CLI/Host lifecycle and native replacement with a local scripted provider; no account or remote inference.',
    notCovered: ['Electron GUI interaction', 'paid model calls', 'real-provider team launch and collaboration'],
    isolation: { lab: paths.lab, harness: paths.harness, profile: paths.profile, agents: paths.agents,
      workspace: paths.workspace, accountCredentialsInherited: false },
    checks: [],
  };
  const children = new Set();
  let logSequence = 0;

  function childProcess(label, args, ipc = false, hostPaths = paths) {
    const child = spawn(hostPaths.executable, ['--expose-internals', ...args], {
      cwd: paths.profile, env: isolatedEnvironment(hostPaths), windowsHide: true,
      stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    const log = `${String(++logSequence).padStart(2, '0')}-${label}.log`;
    const handle = { child, log, output: '', shutdownComplete: false, closed: false };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      handle.output = (handle.output + data.toString()).slice(-4 * 1024 * 1024);
    });
    handle.exit = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { handle.closed = true; done({ code, signal }); });
    });
    // A startup failure can occur before its first await attaches another listener.
    handle.exit.catch(() => {});
    children.add(handle);
    return handle;
  }

  async function saveLog(handle) {
    await writeFile(join(paths.receipts, handle.log), scrub(handle.output));
  }

  async function forceStop(handle) {
    if (handle.closed || !handle.child.pid) return;
    // This PID was spawned by this driver; Windows requires /T for its descendants.
    const killer = spawn(join(environment.SystemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(handle.child.pid), '/T', '/F'], { env: environment, windowsHide: true, stdio: 'ignore' });
    await bounded(new Promise((done, reject) => {
      killer.once('error', reject); killer.once('close', done);
    }), SHUTDOWN_TIMEOUT, 'owned process cleanup');
    await bounded(handle.exit, SHUTDOWN_TIMEOUT, 'owned process exit');
  }

  async function runCli(label, args, hostPaths = paths) {
    const handle = childProcess(label, [hostPaths.cli, 'plugin', '--profile', 'desktop', ...args], false, hostPaths);
    try {
      const result = await bounded(handle.exit, TIMEOUT, label);
      assert.equal(result.code, 0, `${label} failed; see ${handle.log}`);
      report.checks.push({ name: label, passed: true, exitCode: result.code, log: handle.log });
    } finally {
      await forceStop(handle);
      await saveLog(handle);
      children.delete(handle);
    }
  }

  async function runNativeAcceptance(installedRoot, script, receiptName, extra = []) {
    const receipt = join(paths.receipts, receiptName);
    const handle = childProcess(script, [join(installedRoot, 'scripts', script),
      paths.runtime, installedRoot, receipt, `tgz-sha256:${report.plugin.tgzSha256}`, ...extra]);
    try {
      const result = await bounded(handle.exit, TIMEOUT, script);
      assert.equal(result.code, 0, `${script} failed; see ${handle.log}`);
      const evidence = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(evidence.passed, true, `${script} reported failure`);
      report.checks.push({ name: script, passed: true, checks: evidence.checks.length,
        receipt: receiptName, log: handle.log });
    } finally {
      await forceStop(handle);
      await saveLog(handle);
      children.delete(handle);
    }
  }

  async function startHost(label, hostPaths = paths) {
    const handle = childProcess(label, [hostPaths.host, hostPaths.runtime, paths.profile, hostPaths.primary, hostPaths.pnpm, hostPaths.nodeBin], true, hostPaths);
    const ready = new Promise((done, reject) => {
      handle.child.on('message', message => {
        if (message?.type === 'ready') done(message);
        if (message?.type === 'shutdown-complete') handle.shutdownComplete = true;
        if (message?.type === 'fatal') reject(new Error(`Host fatal: ${scrub(message.diagnostic ?? message.message)}`));
      });
      handle.exit.then(result => reject(new Error(`Host exited before ready (${result.code ?? result.signal}); see ${handle.log}`)), reject);
    });
    const message = await bounded(ready, TIMEOUT, `${label} readiness`);
    const url = new URL(message.url);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'Host bootstrap did not issue an authentication cookie');
    const base = url.origin;
    handle.rpc = async (endpoint, args) => {
      const rpcId = randomUUID();
      const reply = await fetch(`${base}/api/${endpoint}`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      assert.equal(reply.status, 200, `${endpoint}: HTTP ${reply.status}`);
      const body = await reply.json();
      assert.equal(body.type, 'server-response'); assert.equal(body.rpcId, rpcId);
      assert.equal(body.result?.ok, true, `${endpoint}: ${scrub(JSON.stringify(body.result?.error))}`);
      return body.result.value;
    };
    report.checks.push({ name: label, passed: true, pid: handle.child.pid, log: handle.log });
    return handle;
  }

  async function stopHost(handle) {
    try {
      assert.ok(handle.child.connected, 'Host IPC disconnected before shutdown');
      handle.child.send({ type: 'shutdown' });
      const result = await bounded(handle.exit, SHUTDOWN_TIMEOUT, 'Host shutdown');
      assert.equal(result.code, 0, 'Host shutdown failed');
      assert.equal(handle.shutdownComplete, true, 'Host omitted shutdown-complete');
      report.checks.push({ name: 'graceful-shutdown', passed: true, log: handle.log });
    } finally {
      await forceStop(handle);
      await saveLog(handle);
      children.delete(handle);
    }
  }

  async function readQuietSession(host, sessionId, commandId) {
    const page = await host.rpc('session/events', { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } });
    assert.equal(page.hasMore, false, 'acceptance session history must fit one complete page');
    const events = page.records.map(record => { assert.equal(record.type, 'event'); return record.event; });
    assert.equal(events.some(event => /^(?:turn|step|assistant|request|user)\//.test(event.type)
      || ['team/member', 'team/task', 'team/message/queued'].includes(event.type)), false, 'plan unexpectedly started work');
    for (const type of ['command/run', 'command/done']) {
      assert.equal(events.filter(event => event.type === type && event.data.commandId === commandId).length, 1, `${type} receipt missing`);
    }
    const state = await host.rpc('session/state', { request: { sessionId } });
    assert.equal(state.running, false);
    assert.ok(state.queue === null || Array.isArray(state.queue) && state.queue.length === 0);
    assert.deepEqual(state.pendingInput, []);
    return { events, state, cursor: page.cursor };
  }

  try {
    const archive = join(paths.resources, 'app.asar');
    const originalFs = createRequire(import.meta.url)('original-fs');
    const archiveSha256 = await sha256(archive, originalFs.createReadStream);
    const hostVersion = hostVersionForArchive(archiveSha256, 'win32');
    assert.ok(hostVersion, 'unreviewed Windows app.asar');
    report.host = { version: hostVersion, archiveSha256, electron: process.versions.electron, node: process.versions.node };
    const legacyPaths = paths.legacyHostExecutable ? pathsFor({ ...values,
      'install-dir': dirname(paths.legacyHostExecutable) }) : paths;
    if (hostVersion === '0.2.3-alpha.2') {
      assert.ok(paths.legacyHostExecutable, 'alpha.2 upgrade requires a separately pinned rc.5 Host');
      assert.equal(await sha256(join(legacyPaths.resources, 'app.asar'), originalFs.createReadStream),
        '5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69');
    }
    report.plugin = { name: PACKAGE, tgzSha256: await sha256(paths.tgz) };
    const hostRequire = createRequire(join(paths.runtime, 'package.json'));
    const load = name => import(pathToFileURL(hostRequire.resolve(name)).href);
    const { initProfile } = await load('@deepseek-ai/dsh-app-boot');
    const { PROFILE_TEMPLATES } = await load('@deepseek-ai/dsh-official-bundles');
    initProfile(paths.profile, PROFILE_TEMPLATES.web.bundles);
    report.checks.push({ name: 'official-profile-initialization', passed: true });
    if (paths.previousTgz) {
      await runCli('install-previous-tgz', ['add', `file:${paths.previousTgz}`, '--offline', '--ignore-scripts'], legacyPaths);
      const oldPackage = JSON.parse(await readFile(join(paths.profile, 'node_modules', PACKAGE, 'package.json'), 'utf8'));
      report.previousVersion = oldPackage.version;
      const previousHost = await startHost('host-before-upgrade', legacyPaths);
      const previousRoot = await previousHost.rpc('session/create', { request: { cwd: paths.workspace } });
      const previousSkills = await previousHost.rpc('skills/list', { request: { sessionId: previousRoot.sessionId } });
      const oldSkills = previousSkills.skills.filter(skill => skill.name === 'dsh-team-configure');
      assert.equal(oldSkills.length, 1);
      assert.ok(!oldSkills[0].description.includes('工具集'), 'previous baseline already contains the new skill');
      await stopHost(previousHost);
      report.checks.push({ name: 'previous-version-skill-before-upgrade', passed: true, version: oldPackage.version });
    }
    await runCli('install-tgz', ['add', `file:${paths.tgz}`, '--offline', '--ignore-scripts']);
    const installed = JSON.parse(await readFile(join(paths.profile, 'node_modules', PACKAGE, 'package.json'), 'utf8'));
    assert.equal(installed.name, PACKAGE);
    report.plugin.version = installed.version;
    const profile = JSON.parse(await readFile(join(paths.profile, 'package.json'), 'utf8'));
    assert.ok(profile.dsh.profile.bundles.includes(PACKAGE), 'official manager did not activate the bundle');
    const installedRoot = join(paths.profile, 'node_modules', PACKAGE);
    const { probeNativeRoleTools } = await import(pathToFileURL(join(installedRoot, 'scripts', 'probe-native-role-tools.mjs')).href);
    report.nativeRoleTools = await probeNativeRoleTools({ runtime: paths.runtime, plugin: installedRoot, workspace: paths.workspace });
    assert.equal(report.nativeRoleTools.passed, true);
    report.checks.push(...report.nativeRoleTools.checks.map(name => ({ name, passed: true })));

    // Execute the installed TGZ's code through the official Electron/native
    // services. Each script creates and removes its own profile/Session data.
    await runNativeAcceptance(installedRoot, 'accept-native-admission.mjs', 'native-admission.json');
    await runNativeAcceptance(installedRoot, 'accept-native-replacement-store.mjs', 'native-replacement-store.json');
    await runNativeAcceptance(installedRoot, 'probe-native-team-addressing.mjs', 'native-team-addressing.json');
    await runNativeAcceptance(installedRoot, 'accept-native-replacement.mjs', 'native-replacement.json');
    assert.ok(paths.multiRoleLegacyPlugin, 'published rc.7 migration fixture is required');
    const multiRoleLegacy = JSON.parse(await readFile(join(paths.multiRoleLegacyPlugin, 'package.json'), 'utf8'));
    assert.equal(multiRoleLegacy.name, PACKAGE); assert.equal(multiRoleLegacy.version, '0.5.0-rc.7');
    await runNativeAcceptance(installedRoot, 'accept-native-multi-role.mjs', 'native-multi-role.json',
      [paths.multiRoleLegacyPlugin, 'changed', ...(paths.legacyHostExecutable ? [paths.legacyHostExecutable] : [])]);
    if (paths.legacyPlugin) {
      const legacy = JSON.parse(await readFile(join(paths.legacyPlugin, 'package.json'), 'utf8'));
      assert.equal(legacy.name, PACKAGE); assert.equal(legacy.version, '0.5.0-rc.6');
      await runNativeAcceptance(installedRoot, 'accept-native-replacement.mjs', 'native-replacement-legacy.json',
        [paths.legacyPlugin, 'changed', ...(paths.legacyHostExecutable ? [paths.legacyHostExecutable] : [])]);
      await runNativeAcceptance(installedRoot, 'accept-native-replacement.mjs', 'native-replacement-legacy-unchanged.json',
        [paths.legacyPlugin, 'unchanged', ...(paths.legacyHostExecutable ? [paths.legacyHostExecutable] : [])]);
    }

    let host = await startHost('host-installed');
    const { sessionId } = await host.rpc('session/create', { request: { cwd: paths.workspace } });
    assert.match(sessionId, /^session-[a-f0-9-]{36}$/);
    report.sessionId = sessionId;
    const skillCatalog = await host.rpc('skills/list', { request: { sessionId } });
    const configuredSkills = skillCatalog.skills.filter(skill => skill.name === 'dsh-team-configure');
    assert.equal(configuredSkills.length, 1, 'profile-wide configuration skill missing or duplicated');
    assert.ok(configuredSkills[0].description.includes('工具集'), 'new bundled skill not loaded');
    assert.equal(skillCatalog.skills.filter(skill => skill.name === 'dsh-team-replace').length, 1,
      'profile-wide replacement skill missing or duplicated');
    report.checks.push({ name: 'profile-wide-configuration-skill', passed: true });
    if (paths.previousTgz) report.checks.push({ name: 'cli-upgrade-replaces-bundled-skill', passed: true, from: report.previousVersion, to: installed.version });
    const commands = await host.rpc('commands/list', { agentId: sessionId });
    assert.ok(commands.some(command => command.name === 'dsh-team'), 'dsh-team command not registered');
    const execution = await host.rpc('commands/execute', { agentId: sessionId, line: '/dsh-team plan', submittedAttachments: [] });
    assert.equal(execution.result.kind, 'success', execution.result.text);
    const plan = JSON.parse(execution.result.text);
    assert.equal(plan.ok, true); assert.equal(plan.mode, 'plan'); assert.equal(plan.plan.blocked, false);
    assert.deepEqual(plan.plan.members.map(member => member.name).sort(), ['implementer', 'reviewer']);
    assert.ok(plan.plan.members.every(member => member.action === 'create'));
    report.plan = { commandId: execution.commandId, ...plan };
    const before = await readQuietSession(host, sessionId, execution.commandId);
    report.checks.push({ name: 'real-host-plan-without-model-turn', passed: true, eventTypes: before.events.map(event => event.type) });
    const settings = await host.rpc('settings/describe', {});
    const defaults = settings.namespaces.find(row => row.ns === 'dsh-native-current-team');
    assert.ok(defaults, 'native live-template settings namespace missing');
    const template = JSON.parse(await readFile(join(paths.profile, 'node_modules', PACKAGE, 'examples', 'team-template.json'), 'utf8'));
    template.members[0].persona_prompt = 'WINDOWS_CONFIG_PERSISTENCE_PROBE';
    await host.rpc('settings/update', { ns: defaults.ns, patch: { template }, expectedRevision: defaults.revision });
    const preserved = await host.rpc('commands/execute', { agentId: sessionId, line: '/dsh-team plan', submittedAttachments: [] });
    assert.equal(preserved.result.kind, 'success', preserved.result.text);
    assert.equal(JSON.parse(preserved.result.text).templateFingerprint, plan.templateFingerprint,
      'live template edit reloaded or changed the already-bound root');
    const restartBaseline = await readQuietSession(host, sessionId, execution.commandId);
    const { sessionId: configuredId } = await host.rpc('session/create', { request: { cwd: paths.workspace } });
    const configured = await host.rpc('commands/execute', { agentId: configuredId, line: '/dsh-team plan', submittedAttachments: [] });
    assert.equal(configured.result.kind, 'success', configured.result.text);
    const { parseLauncherTemplate, launcherTemplateFingerprint } = await import(pathToFileURL(join(paths.profile, 'node_modules', PACKAGE, 'src', 'launcher-template.js')).href);
    const scoped = structuredClone(template), suffix = createHash('sha256').update(configuredId).digest('hex').slice(0, 24);
    for (const member of scoped.members) member.agent_preset = `dsh-current-${suffix}-${member.name}`;
    assert.equal(JSON.parse(configured.result.text).templateFingerprint, launcherTemplateFingerprint(parseLauncherTemplate(scoped)));
    await readQuietSession(host, configuredId, configured.commandId);
    report.checks.push({ name: 'native-live-template-save-preserves-bound-root', passed: true });
    report.checks.push({ name: 'fresh-root-uses-saved-template-without-model-call', passed: true });
    await stopHost(host);

    host = await startHost('host-restarted');
    const after = await readQuietSession(host, sessionId, execution.commandId);
    assert.deepEqual(after.events, restartBaseline.events, 'command history changed across Host restart');
    report.checks.push({ name: 'persisted-command-history', passed: true, cursor: after.cursor });
    const restoredSettings = await host.rpc('settings/describe', {});
    const restoredTemplate = restoredSettings.namespaces.find(row => row.ns === 'dsh-native-current-team')?.value?.template;
    assert.deepEqual(restoredTemplate, template, 'team template did not persist across Host restart');
    const restoredSkills = await host.rpc('skills/list', { request: { sessionId } });
    assert.ok(restoredSkills.skills.some(skill => skill.name === 'dsh-team-configure'));
    assert.ok(restoredSkills.skills.some(skill => skill.name === 'dsh-team-replace'));
    report.checks.push({ name: 'configuration-and-skill-survive-host-restart', passed: true });
    await stopHost(host);

    await runCli('remove-plugin', ['remove', PACKAGE]);
    const removed = JSON.parse(await readFile(join(paths.profile, 'package.json'), 'utf8'));
    assert.ok(!Object.hasOwn(removed.dependencies ?? {}, PACKAGE));
    assert.ok(!removed.dsh.profile.bundles.includes(PACKAGE));
    host = await startHost('host-after-removal');
    const cleanSession = await host.rpc('session/create', { request: { cwd: paths.workspace } });
    const remaining = await host.rpc('commands/list', { agentId: cleanSession.sessionId });
    assert.ok(!remaining.some(command => command.name === 'dsh-team'), 'command still present after removal');
    const removedSkills = await host.rpc('skills/list', { request: { sessionId: cleanSession.sessionId } });
    assert.ok(!removedSkills.skills.some(skill => skill.name === 'dsh-team-configure'), 'skill still present after removal');
    assert.ok(!removedSkills.skills.some(skill => skill.name === 'dsh-team-replace'), 'replacement skill still present after removal');
    await stopHost(host);
    report.checks.push({ name: 'command-removed', passed: true });
    report.status = 'passed';
  } catch (error) {
    report.error = { name: error.name, message: scrub(String(error.message)) };
  } finally {
    for (const handle of children) {
      try { await stopHost(handle); }
      catch (error) {
        report.status = 'failed';
        report.cleanupError = scrub(String(error.message));
      }
    }
    report.completedAt = new Date().toISOString();
    await writeFile(join(paths.receipts, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.status !== 'passed') process.exitCode = 1;
}

try {
  if (values.help) process.stdout.write(`${usage}\n`);
  else {
    assert.equal(process.platform, 'win32', 'This acceptance script runs only on Windows');
    const paths = pathsFor(values);
    if (values['electron-stage']) await accept(paths);
    else await launchDriver(paths);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', phase: 'driver', message: scrub(String(error.message)) })}\n`);
  process.exitCode = 1;
}
