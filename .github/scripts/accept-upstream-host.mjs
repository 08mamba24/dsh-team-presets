import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { classifyProbe, failureAssertions, CLASSIFICATION_PROBES } from './upstream-contract.mjs';
import { REVIEWED_INSTALLERS } from './upstream-compat.mjs';
import { REVIEWED_HOSTS } from '../../src/host-support.js';

export function isolatedEnvironment(lab, resources, platform = process.platform, source = process.env) {
  const home = join(lab, 'home'), temporary = join(lab, 'tmp');
  const system = source.SystemRoot ?? source.SYSTEMROOT;
  if (platform === 'win32' && !system) throw new Error('Windows SystemRoot is required');
  return {
    ...(system ? { SystemRoot: system, WINDIR: system, ComSpec: join(system, 'System32', 'cmd.exe') } : {}),
    PATH: platform === 'win32' ? [join(resources, 'runtime', 'bin'), join(system, 'System32'), system].join(';')
      : [join(resources, 'runtime', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home, USERPROFILE: home,
    ...(platform === 'win32' ? { HOMEDRIVE: parse(home).root.slice(0, 2), HOMEPATH: home.slice(2) } : {}),
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
    TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    DSH_HOME: join(lab, 'harness'), DSH_AGENTS_HOME: join(lab, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    ELECTRON_RUN_AS_NODE: '1', npm_config_userconfig: join(lab, 'npmrc'),
    npm_config_globalconfig: join(lab, 'global-npmrc'), npm_config_store_dir: join(lab, 'pnpm-store'),
    npm_config_enable_global_virtual_store: 'false',
  };
}

async function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

async function download(url, destination, expected, algorithm = 'sha256', encoding = 'hex') {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error('Download HTTP ' + response.status);
  // GitHub release downloads redirect to its release-assets origin. Official
  // installers must remain on the official HTTPS origin, including redirects.
  const final = new URL(response.url), original = new URL(url);
  assert.equal(final.protocol, 'https:');
  if (original.hostname === 'download.deepseek.com') assert.equal(final.hostname, original.hostname);
  else assert.ok(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(final.hostname));
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > 2 * 1024 ** 3 ? new Error('Installer exceeds 2 GiB') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(destination, { flags: 'wx' }));
  assert.equal(await hashFile(destination, algorithm, encoding), expected, 'Downloaded artifact digest mismatch');
  return hashFile(destination);
}

async function run(executable, args, { env, cwd, log, timeout = 180000, allowFailure = false } = {}) {
  const child = spawn(executable, args, { env, cwd, detached: process.platform !== 'win32',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', expired = false, killing;
  const record = data => { output = (output + data).slice(-1024 * 1024); };
  child.stdout.on('data', record); child.stderr.on('data', record);
  const timer = setTimeout(() => {
    expired = true;
    if (process.platform === 'win32' && child.pid) {
      killing = new Promise(done => {
        const killer = spawn(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { env, windowsHide: true, stdio: 'ignore' });
        killer.once('error', done); killer.once('close', done);
      });
    } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  }, timeout);
  const { code, signal } = await new Promise((done, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
  }).finally(() => clearTimeout(timer));
  if (killing) await killing;
  if (log) await writeFile(log, output, { flag: 'wx' });
  if ((code !== 0 || expired) && !allowFailure) throw Object.assign(new Error(`${executable.split(/[\\/]/).at(-1)} failed (${expired ? 'timeout' : code ?? signal})`), { executionFailed: true });
  return { code, signal, timedOut: expired };
}

async function readProof(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return undefined; }
}
async function requireProof(outcome, receipt, sourceHead, path, stage, suite, harness) {
  const status = classifyProbe(outcome, receipt, sourceHead);
  if (status !== 'passed') throw Object.assign(new Error(`${suite}: ${status}; ${receipt?.errors?.[0]?.message ?? 'no complete successful source-bound receipt'}`),
    { compatibilityFailure: status === 'incompatible', ...(status === 'incompatible' ? { failureProof: {
      stage, suite, sourceHead, receiptSha256: await hashFile(path), harnessSha256: await hashFile(harness),
      assertions: failureAssertions(receipt) } } : {}) });
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Real Host installation is restricted to disposable GitHub runners');
  const c = JSON.parse(process.env.COMPAT_CASE);
  const output = resolve(process.env.COMPAT_RESULT_DIR ?? 'compat-result');
  await mkdir(output, { recursive: true });
  const result = { fingerprint: c.fingerprint, version: c.version, target: c.target, commit: c.commit,
    plugin: c.plugin, validation: c.validation, status: 'infrastructure-error', stage: 'prepare', checkedAt: new Date().toISOString(),
    isolatedDataRemoved: false, suites: [] };
  // Windows TEMP may use an 8.3 alias. One canonical path prevents duplicate
  // native module/Service identities across CLI, Loader and child fixtures.
  const lab = await realpath(await mkdtemp(join(tmpdir(), 'dsh-upstream-')));
  let installedMac = false, mounted = false, stage = 'prepare';
  try {
    assert.ok(c.target === 'mac-arm64' && process.platform === 'darwin' && process.arch === 'arm64'
      || c.target === 'win-x64' && process.platform === 'win32' && process.arch === 'x64', 'Wrong platform runner');
    if (!c.artifact) {
      result.status = c.pendingReason?.startsWith('Official ') && c.pendingReason.includes('has not published') ? 'needs-review' : 'infrastructure-error';
      result.reason = c.pendingReason; result.stage = 'artifact';
      return;
    }
    const install = join(lab, 'install'), payload = join(lab, 'payload');
    for (const dir of ['home', 'tmp', 'harness', 'agents', 'workspace', 'install', 'payload', 'plugin', 'legacy']) await mkdir(join(lab, dir));
    await writeFile(join(lab, 'npmrc'), '', { flag: 'wx' });
    await writeFile(join(lab, 'global-npmrc'), '', { flag: 'wx' });
    const selectedMac = c.version === '0.2.3-alpha.2' ? join(install, 'DeepSeek Harness.app') : '/Applications/DeepSeek Harness.app';
    let resources = process.platform === 'darwin' ? join(selectedMac, 'Contents', 'Resources') : join(install, 'resources');
    let env = isolatedEnvironment(lab, resources);
    stage = 'download';
    const installer = join(lab, c.artifact.format === 'dmg' ? 'official.dmg' : process.platform === 'darwin' ? 'official.zip' : 'official.exe');
    result.installerSha256 = await download(c.artifact.url, installer, c.artifact.sha512 ?? c.artifact.sha256,
      c.artifact.sha512 ? 'sha512' : 'sha256', c.artifact.sha512 ? 'base64' : 'hex');
    result.installerSha512 = await hashFile(installer, 'sha512', 'base64');
    stage = 'extract';
    if (process.platform === 'darwin') {
      try { await access(selectedMac); throw new Error('Refusing to replace an existing Host'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let appRoot = payload;
      if (c.artifact.format === 'dmg') {
        appRoot = join(lab, 'mount'); await mkdir(appRoot);
        await run('/usr/bin/hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', appRoot], { env, cwd: lab });
        mounted = true;
      } else await run('/usr/bin/ditto', ['-x', '-k', installer, payload], { env, cwd: lab });
      const apps = (await readdir(appRoot)).filter(name => name.endsWith('.app'));
      assert.deepEqual(apps, ['DeepSeek Harness.app']);
      installedMac = selectedMac === '/Applications/DeepSeek Harness.app';
      await cp(join(appRoot, apps[0]), selectedMac,
        { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      if (mounted) { await run('/usr/bin/hdiutil', ['detach', appRoot], { env, cwd: lab }); mounted = false; }
    } else {
      // 7z is installed on the standard Windows runner; no installer or GUI runs.
      const sevenZip = 'C:\\Program Files\\7-Zip\\7z.exe';
      await run(sevenZip, ['x', installer, '-o' + payload, '-y', '$PLUGINSDIR/app-64.7z'], { env, cwd: lab });
      await run(sevenZip, ['x', join(payload, '$PLUGINSDIR', 'app-64.7z'), '-o' + install, '-y'], { env, cwd: lab });
    }
    const exe = process.platform === 'darwin' ? join(selectedMac, 'Contents', 'MacOS', 'DeepSeek Harness') : join(install, 'DeepSeek Harness.exe');
    let legacyHostExecutable;
    if (c.version === '0.2.3-alpha.2') {
      const legacy = REVIEWED_INSTALLERS[c.target];
      const legacyInstaller = join(lab, 'legacy-host.' + legacy.format);
      const installerSha256 = await download(legacy.url, legacyInstaller, legacy.sha256);
      let legacyResources;
      if (process.platform === 'darwin') {
        // Old immutable plugins require this path, on the disposable CI runner only.
        try { await access('/Applications/DeepSeek Harness.app'); throw new Error('Refusing to replace an existing legacy Host'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const mount = join(lab, 'mount'); await mkdir(mount);
        await run('/usr/bin/hdiutil', ['attach', legacyInstaller, '-readonly', '-nobrowse', '-mountpoint', mount], { env, cwd: lab });
        mounted = true;
        assert.deepEqual((await readdir(mount)).filter(name => name.endsWith('.app')), ['DeepSeek Harness.app']);
        installedMac = true;
        await cp(join(mount, 'DeepSeek Harness.app'), '/Applications/DeepSeek Harness.app',
          { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        await run('/usr/bin/hdiutil', ['detach', mount], { env, cwd: lab }); mounted = false;
        legacyResources = '/Applications/DeepSeek Harness.app/Contents/Resources';
        legacyHostExecutable = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
      } else {
        const sevenZip = 'C:\\Program Files\\7-Zip\\7z.exe';
        const payload = join(lab, 'legacy-host-payload'), install = join(lab, 'legacy-host-install');
        await run(sevenZip, ['x', legacyInstaller, '-o' + payload, '-y', '$PLUGINSDIR/app-64.7z'], { env, cwd: lab });
        await run(sevenZip, ['x', join(payload, '$PLUGINSDIR', 'app-64.7z'), '-o' + install, '-y'], { env, cwd: lab });
        legacyResources = join(install, 'resources'); legacyHostExecutable = join(install, 'DeepSeek Harness.exe');
      }
      const archiveSha256 = await hashFile(join(legacyResources, 'app.asar'));
      assert.equal(archiveSha256, REVIEWED_HOSTS[process.platform]['0.2.2-rc.5']);
      result.legacyHost = { version: '0.2.2-rc.5', installerSha256, archiveSha256 };
    }
    result.archiveSha256 = await hashFile(join(resources, 'app.asar'));
    const runtime = join(resources, 'app.asar', 'dsh');
    const pluginDirectory = join(lab, 'plugin');
    const pluginTgz = join(lab, 'plugin.tgz');
    stage = 'plugin';
    if (c.plugin.kind === 'release') result.pluginSha256 = await download(c.plugin.url, pluginTgz, c.plugin.sha256);
    else {
      const candidate = resolve('candidate');
      // npm sees only the laboratory environment; lifecycle scripts are disabled.
      const npm = process.platform === 'win32'
        ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--pack-destination', pluginDirectory],
        { env, cwd: candidate, log: join(output, 'candidate-pack.log') });
      const packed = (await readdir(pluginDirectory)).filter(name => name.endsWith('.tgz'));
      assert.equal(packed.length, 1);
      await cp(join(pluginDirectory, packed[0]), pluginTgz);
      result.pluginSha256 = await hashFile(pluginTgz);
    }
    await run(process.platform === 'win32' ? join(env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar',
      ['-xzf', pluginTgz, '-C', pluginDirectory], { env, cwd: lab });
    const plugin = join(pluginDirectory, 'package');
    const { hostVersionForArchive } = await import(pathToFileURL(join(plugin, 'src', 'host-support.js')).href);
    result.admission = hostVersionForArchive(result.archiveSha256) === c.version ? 'reviewed' : 'unreviewed';
    stage = 'contract';
    const contractReceipt = join(output, 'runtime-contract.json');
    const inspector = join(dirname(fileURLToPath(import.meta.url)), 'inspect-upstream-runtime.mjs');
    const sourceHead = 'tgz-sha256:' + result.pluginSha256;
    const inspected = await run(exe, ['--expose-internals', inspector,
      runtime, contractReceipt, '', sourceHead], { env, cwd: lab, log: join(output, 'contract.log'), allowFailure: true });
    result.contract = await readProof(contractReceipt);
    await requireProof(inspected, result.contract, sourceHead, contractReceipt, 'contract', 'contract', inspector);
    if (result.admission !== 'reviewed') {
      result.status = 'needs-review'; result.reason = 'Unknown app.asar: public API surface inspected; product allowlist and business execution were not changed.';
      result.stage = 'admission'; return;
    }
    // Genuine native CLI installation; the monitor's harness independently
    // exercises those installed bytes. No empty Preset is substituted.
    stage = 'install';
    const cli = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    const cliRun = async (label, args) => run(exe, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', ...args],
      { env, cwd: join(lab, 'workspace'), log: join(output, label + '.log') });
    stage = 'profile';
    await run(exe, ['--expose-internals', inspector,
      runtime, join(output, 'profile-initialization.json'), join(lab, 'harness', 'profiles', 'desktop'), sourceHead],
      { env, cwd: lab, log: join(output, 'profile-initialization.log') });
    stage = 'install';
    await cliRun('install', ['add', 'file:' + pluginTgz, '--offline', '--ignore-scripts']);
    const installed = join(lab, 'harness', 'profiles', 'desktop', 'node_modules', 'dsh-subagent-live-rc2-local');
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    const expectedVersion = c.plugin.kind === 'release' ? c.plugin.tag.slice(1)
      : JSON.parse(await readFile(resolve('candidate', 'package.json'), 'utf8')).version;
    assert.equal(metadata.version, expectedVersion, 'CLI installed a different plugin version');
    const profile = JSON.parse(await readFile(join(lab, 'harness', 'profiles', 'desktop', 'package.json'), 'utf8'));
    result.install = { passed: metadata.name === 'dsh-subagent-live-rc2-local', name: metadata.name,
      version: metadata.version, bundleActivated: profile.dsh?.profile?.bundles?.includes(metadata.name) === true };
    assert.ok(result.install.passed);
    assert.ok(result.install.bundleActivated);
    const legacyTgz = join(lab, 'legacy.tgz');
    await download('https://github.com/08mamba24/dsh-team-presets/releases/download/v0.5.0-rc.6/dsh-subagent-live-rc2-local-0.5.0-rc.6.tgz',
      legacyTgz, '2cf65d1b843ead3b5fc051df2f1b6f8027022c4ecabb1d9d0375173cfd47f03d');
    await run(process.platform === 'win32' ? join(env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar',
      ['-xzf', legacyTgz, '-C', join(lab, 'legacy')], { env, cwd: lab });
    stage = 'native';
    const suites = [ ['admission', 'accept-native-admission.mjs'], ['store', 'accept-native-replacement-store.mjs'],
      ['addressing', 'probe-native-team-addressing.mjs'], ['replacement', 'accept-native-replacement.mjs'],
      ['legacy-changed', 'accept-native-replacement.mjs', join(lab, 'legacy', 'package'), 'changed', ...(legacyHostExecutable ? [legacyHostExecutable] : [])],
      ['legacy-unchanged', 'accept-native-replacement.mjs', join(lab, 'legacy', 'package'), 'unchanged', ...(legacyHostExecutable ? [legacyHostExecutable] : [])] ];
    for (const [name, script, ...extra] of suites) {
      const receipt = join(output, name + '.json');
      const harness = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', script);
      const executed = await run(exe, ['--expose-internals', harness, runtime, installed, receipt,
        'tgz-sha256:' + result.pluginSha256, ...extra], { env, cwd: join(lab, 'workspace'), log: join(output, name + '.log'), allowFailure: true });
      const evidence = await readProof(receipt);
      await requireProof(executed, evidence, sourceHead, receipt, 'native', name, harness);
      assert.ok(evidence.checks.length > 0 && evidence.checks.every(check => check.passed === true));
      result.suites.push({ name, passed: true, checks: evidence.checks.length,
        sourceHead: evidence.sourceHead, receiptSha256: await hashFile(receipt), harnessSha256: await hashFile(harness) });
      if (name === 'addressing') {
        result.classificationChecks = [];
        for (const [label, fault, expected] of CLASSIFICATION_PROBES) {
          const faultReceipt = join(output, label + '.json');
          const outcome = await run(exe, ['--expose-internals', harness, runtime, installed, faultReceipt, sourceHead, fault],
            { env, cwd: join(lab, 'workspace'), log: join(output, label + '.log'), allowFailure: true });
          const proof = await readProof(faultReceipt);
          assert.equal(outcome.code, 1); assert.equal(outcome.signal, null); assert.equal(outcome.timedOut, false);
          assert.equal(proof?.sourceHead, sourceHead); assert.equal(proof.passed, false);
          if (fault === '--setup-failure') assert.equal(proof.setupError?.code, 'ERR_ASSERTION');
          if (fault === '--cleanup-failure') assert.equal(proof.cleanupError?.code, 'ERR_ASSERTION');
          if (fault === '--nested-io-failure') {
            assert.equal(proof.checks.at(-1).error.code, 'ERR_ASSERTION');
            assert.ok(proof.checks.at(-1).error.provenance.some(error => error.code === 'EPERM'));
          }
          const actual = classifyProbe(outcome, proof, sourceHead);
          assert.equal(actual, expected, label);
          let failureProof;
          try { await requireProof(outcome, proof, sourceHead, faultReceipt, 'native', 'addressing', harness); }
          catch (error) {
            assert.equal(error.compatibilityFailure, expected === 'incompatible'); failureProof = error.failureProof;
          }
          if (expected === 'incompatible') assert.ok(failureProof?.assertions.length > 0);
          result.classificationChecks.push({ name: label, passed: true, expected, actual, sourceHead,
            receiptSha256: await hashFile(faultReceipt), ...(failureProof ? { failureProof } : {}) });
        }
      }
    }
    stage = 'uninstall';
    await cliRun('uninstall', ['remove', 'dsh-subagent-live-rc2-local']);
    result.status = 'verified'; result.stage = 'complete';
  } catch (error) {
    result.status = error.compatibilityFailure === true ? 'incompatible' : 'infrastructure-error';
    if (error.failureProof) result.failureProof = error.failureProof;
    result.reason = error.message.replaceAll(lab, '<isolated-lab>').slice(0, 500); result.stage = stage;
  } finally {
    try {
      if (mounted) await run('/usr/bin/hdiutil', ['detach', join(lab, 'mount')],
        { env: isolatedEnvironment(lab, '/Applications/DeepSeek Harness.app/Contents/Resources'), cwd: lab });
      if (installedMac) await rm('/Applications/DeepSeek Harness.app', { recursive: true });
      await rm(lab, { recursive: true }); result.isolatedDataRemoved = true;
    } catch (error) { result.status = 'infrastructure-error'; result.reason = 'Isolated cleanup failed: ' + error.code; }
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ target: result.target, version: result.version, status: result.status, stage: result.stage }));
    if (['incompatible', 'infrastructure-error'].includes(result.status)) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
