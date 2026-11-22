import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
    npm_config_globalconfig: join(lab, 'npmrc'), npm_config_store_dir: join(lab, 'pnpm-store'),
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

async function run(executable, args, { env, cwd, log, timeout = 180000 } = {}) {
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
  const code = await new Promise((done, reject) => {
    child.once('error', reject); child.once('close', done);
  }).finally(() => clearTimeout(timer));
  if (killing) await killing;
  if (log) await writeFile(log, output, { flag: 'wx' });
  if (code !== 0 || expired) throw Object.assign(new Error(`${executable.split(/[\\/]/).at(-1)} failed (${expired ? 'timeout' : code})`), { executionFailed: true });
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Real Host installation is restricted to disposable GitHub runners');
  const c = JSON.parse(process.env.COMPAT_CASE);
  const output = resolve(process.env.COMPAT_RESULT_DIR ?? 'compat-result');
  await mkdir(output, { recursive: true });
  const result = { fingerprint: c.fingerprint, version: c.version, target: c.target, commit: c.commit,
    plugin: c.plugin, status: 'infrastructure-error', stage: 'prepare', checkedAt: new Date().toISOString(),
    isolatedDataRemoved: false, suites: [] };
  const lab = await mkdtemp(join(tmpdir(), 'dsh-upstream-'));
  let installedMac = false, stage = 'prepare';
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
    let resources = process.platform === 'darwin' ? '/Applications/DeepSeek Harness.app/Contents/Resources' : join(install, 'resources');
    let env = isolatedEnvironment(lab, resources);
    stage = 'download';
    const installer = join(lab, process.platform === 'darwin' ? 'official.zip' : 'official.exe');
    result.installerSha256 = await download(c.artifact.url, installer, c.artifact.sha512, 'sha512', 'base64');
    stage = 'extract';
    if (process.platform === 'darwin') {
      try { await access('/Applications/DeepSeek Harness.app'); throw new Error('Refusing to replace an existing Host'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await run('/usr/bin/ditto', ['-x', '-k', installer, payload], { env, cwd: lab });
      const apps = (await readdir(payload)).filter(name => name.endsWith('.app'));
      assert.deepEqual(apps, ['DeepSeek Harness.app']);
      installedMac = true;
      await cp(join(payload, apps[0]), '/Applications/DeepSeek Harness.app', { recursive: true, errorOnExist: true, force: false });
    } else {
      // 7z is installed on the standard Windows runner; no installer or GUI runs.
      const sevenZip = 'C:\\Program Files\\7-Zip\\7z.exe';
      await run(sevenZip, ['x', installer, '-o' + payload, '-y', '$PLUGINSDIR/app-64.7z'], { env, cwd: lab });
      await run(sevenZip, ['x', join(payload, '$PLUGINSDIR', 'app-64.7z'), '-o' + install, '-y'], { env, cwd: lab });
    }
    const exe = process.platform === 'darwin' ? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' : join(install, 'DeepSeek Harness.exe');
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
    await run(exe, ['--expose-internals', join(dirname(fileURLToPath(import.meta.url)), 'inspect-upstream-runtime.mjs'), runtime, contractReceipt],
      { env, cwd: lab, log: join(output, 'contract.log') });
    result.contract = JSON.parse(await readFile(contractReceipt, 'utf8'));
    if (result.admission !== 'reviewed') {
      result.status = 'needs-review'; result.reason = 'Unknown app.asar: public API surface inspected; product allowlist and business execution were not changed.';
      result.stage = 'admission'; return;
    }
    // Genuine native CLI installation, followed by the installed package's full
    // scripted-provider acceptance. No hand-written empty Preset is substituted.
    stage = 'install';
    const cli = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    const cliRun = async (label, args) => run(exe, ['--expose-internals', cli, 'plugin', '--profile', 'desktop', ...args],
      { env, cwd: join(lab, 'workspace'), log: join(output, label + '.log') });
    await cliRun('create-profile', ['create', '--template', 'web']);
    await cliRun('install', ['add', 'file:' + pluginTgz, '--offline', '--ignore-scripts']);
    const installed = join(lab, 'harness', 'profiles', 'desktop', 'node_modules', 'dsh-subagent-live-rc2-local');
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    result.install = { passed: metadata.name === 'dsh-subagent-live-rc2-local', version: metadata.version };
    assert.ok(result.install.passed);
    const legacyTgz = join(lab, 'legacy.tgz');
    await download('https://github.com/08mamba24/dsh-team-presets/releases/download/v0.5.0-rc.6/dsh-subagent-live-rc2-local-0.5.0-rc.6.tgz',
      legacyTgz, '2cf65d1b843ead3b5fc051df2f1b6f8027022c4ecabb1d9d0375173cfd47f03d');
    await run(process.platform === 'win32' ? join(env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar',
      ['-xzf', legacyTgz, '-C', join(lab, 'legacy')], { env, cwd: lab });
    stage = 'native';
    const suites = [ ['admission', 'accept-native-admission.mjs'], ['store', 'accept-native-replacement-store.mjs'],
      ['addressing', 'probe-native-team-addressing.mjs'], ['replacement', 'accept-native-replacement.mjs'],
      ['legacy-changed', 'accept-native-replacement.mjs', join(lab, 'legacy', 'package')],
      ['legacy-unchanged', 'accept-native-replacement.mjs', join(lab, 'legacy', 'package'), 'unchanged'] ];
    for (const [name, script, ...extra] of suites) {
      const receipt = join(output, name + '.json');
      await run(exe, ['--expose-internals', join(installed, 'scripts', script), runtime, installed, receipt,
        'tgz-sha256:' + result.pluginSha256, ...extra], { env, cwd: join(lab, 'workspace'), log: join(output, name + '.log') });
      const evidence = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(evidence.passed, true);
      assert.ok(evidence.checks.length > 0 && evidence.checks.every(check => check.passed === true));
      result.suites.push({ name, passed: true, checks: evidence.checks.length });
    }
    stage = 'uninstall';
    await cliRun('uninstall', ['remove', 'dsh-subagent-live-rc2-local', '--offline', '--ignore-scripts']);
    result.status = 'verified'; result.stage = 'complete';
  } catch (error) {
    result.status = ['contract', 'install', 'native', 'uninstall'].includes(stage) && error.executionFailed ? 'incompatible' : 'infrastructure-error';
    result.reason = error.message.replaceAll(lab, '<isolated-lab>').slice(0, 500); result.stage = stage;
  } finally {
    try {
      if (installedMac) await rm('/Applications/DeepSeek Harness.app', { recursive: true });
      await rm(lab, { recursive: true }); result.isolatedDataRemoved = true;
    } catch (error) { result.status = 'infrastructure-error'; result.reason = 'Isolated cleanup failed: ' + error.code; }
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ target: result.target, version: result.version, status: result.status, stage: result.stage }));
    if (['incompatible', 'infrastructure-error'].includes(result.status)) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
