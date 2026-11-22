import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLauncherConfig, readLauncherTemplate } from './launcher-config.js';
import { parseLauncherTemplate } from './launcher-template.js';

const exec = (file, args, options) => new Promise((accept, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : accept({ stdout, stderr }));
});
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const TEMPLATE = '.dsh-team-template.json';
const MARKER = '.dsh-team-launcher.json';
const sameFile = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
  .every(key => a[key] === b[key]);

export class LauncherPrepareError extends Error {
  constructor(code, state) {
    super(code); this.code = code; this.state = structuredClone(state);
  }
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }
const sameDirectory = (a, b) => ['dev', 'ino', 'uid', 'mode'].every(key => a[key] === b[key]);

/** Bounded path checks, not atomic isolation from other processes running as the same UID. */
async function protectedDirectory(path, ownedLeaf, code) {
  if (await fs.realpath(path) !== path) fail(code);
  const components = [];
  for (let current = path; ; current = dirname(current)) {
    if (components.length >= 256) fail(code);
    const stat = await fs.lstat(current), leaf = current === path;
    const owned = stat.uid === process.getuid(), rootSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (!owned && stat.uid !== 0)
      || (ownedLeaf && leaf && !owned)
      || ((stat.mode & 0o022) !== 0 && (!rootSticky || (ownedLeaf && leaf)))) fail(code);
    components.push({ path: current, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
    if (dirname(current) === current) break;
  }
  if (await fs.realpath(path) !== path) fail(code);
  return { path, components };
}
async function unchangedDirectory(snapshot) {
  if (await fs.realpath(snapshot.path) !== snapshot.path) fail('PREPARE_DIRECTORY_CHANGED');
  for (const before of snapshot.components) {
    const current = await fs.lstat(before.path);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectory(before, current)) fail('PREPARE_DIRECTORY_CHANGED');
  }
}
async function regularBytes(path, limit, owned = false) {
  let file;
  try {
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit
      || (owned && (before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600))) fail('UNSAFE_PREPARE_INPUT');
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await file.stat();
    if (!sameFile(before, opened)) fail('PREPARE_INPUT_CHANGED');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await file.stat(), current = await fs.lstat(path);
    if (length > limit || length !== opened.size || !sameFile(opened, after) || !sameFile(opened, current)) fail('PREPARE_INPUT_CHANGED');
    return buffer.subarray(0, length);
  } finally { await file?.close(); }
}
async function exclusive(path, bytes, created) {
  let file;
  try {
    file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created?.push(path);
    await file.chmod(0o600);
    await file.writeFile(bytes);
    await file.sync();
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail('PREPARE_OUTPUT_UNSAFE');
  } finally { await file?.close(); }
}
async function absent(path, code) {
  try { await fs.lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail(code);
}
async function publishReceipt(outputDir, receipt, checkOutput) {
  const temporary = join(outputDir, `.PREPARED-${randomUUID()}.tmp`), final = join(outputDir, 'PREPARED.json');
  const bytes = encode(receipt);
  await checkOutput();
  // exclusive() fsyncs and closes before returning. A failed write/fsync/close cannot publish READY.
  await exclusive(temporary, bytes);
  if (!(await regularBytes(temporary, 65536, true)).equals(bytes)) fail('PREPARED_RECEIPT_CHANGED');
  await checkOutput();
  await fs.link(temporary, final); // Atomic publication; refuses to replace any existing final path.
  // Publication has succeeded. Cleanup failure must not turn an effective READY into a reported failure.
  try { await fs.unlink(temporary); } catch { /* Leave the private extra link for inspection. */ }
}
function relativePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && normalize(path) === path
    && path.split('/').every(part => part !== '..' && part !== '.' && part.length > 0)
    && !/[\\*?!\[\]{}\0]/.test(path);
}
async function copyPayload(sourceRoot, stage, entries) {
  let count = 0, total = 0;
  const copied = new Set();
  const copy = async relative => {
    if (copied.has(relative)) return;
    copied.add(relative);
    if (++count > 1000 || !relativePath(relative)) fail('INVALID_PACKAGE_PAYLOAD');
    const source = join(sourceRoot, relative), target = join(stage, relative), stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || await fs.realpath(source) !== source) fail('UNSAFE_PACKAGE_PAYLOAD');
    if (stat.isDirectory()) {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      for (const child of (await fs.readdir(source)).sort()) await copy(`${relative}/${child}`);
    } else if (stat.isFile()) {
      const bytes = await regularBytes(source, 2 * 1024 * 1024);
      if ((total += bytes.length) > 20 * 1024 * 1024) fail('PACKAGE_PAYLOAD_TOO_LARGE');
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await exclusive(target, bytes);
    } else fail('UNSAFE_PACKAGE_PAYLOAD');
  };
  for (const entry of entries) {
    if (entry === 'package.json' || entry === 'cordis.patch.yml') continue;
    await copy(entry);
  }
}

/** Offline preparation only. No Host/profile access, installation or native authorization is performed. */
export async function prepareLauncher(options, packageRoot = PACKAGE_ROOT) {
  if (process.platform === 'win32') fail('LEGACY_BOUND_ENTRY_REQUIRES_MACOS');
  const state = { status: 'PREPARING', outputDir: null, createdWorkspacePaths: [], packagePath: null,
    installed: false, nativeAuthorizationVerified: false, modelCalls: 0 };
  let phase = 'INVALID_PREPARE_OPTIONS';
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['sessionId', 'workspace', 'templatePath', 'outputDir', 'runTag', 'timeoutMs'].includes(key))
      || ['sessionId', 'workspace', 'templatePath', 'outputDir'].some(key => typeof options[key] !== 'string' || !options[key])) fail(phase);
    const workspace = await fs.realpath(resolve(options.workspace));
    const workspaceSnapshot = await protectedDirectory(workspace, true, 'UNSAFE_PREPARE_WORKSPACE');
    const templateBytes = await regularBytes(resolve(options.templatePath), 65536);
    let rawTemplate;
    try { rawTemplate = JSON.parse(templateBytes.toString('utf8')); }
    catch { fail('INVALID_LAUNCHER_TEMPLATE_JSON'); }
    const parsedTemplate = parseLauncherTemplate(rawTemplate);
    const config = parseLauncherConfig({ mode: 'launcher', ownedSessionId: options.sessionId, workspace,
      runTag: options.runTag ?? `team-${randomUUID()}`, timeoutMs: options.timeoutMs ?? 120000,
      templateSha256: digest(templateBytes), startup: { maxTokens: 1024,
        maxStreams: Object.fromEntries(parsedTemplate.members.map(member => [member.name, 1])) } });
    const templatePath = join(workspace, TEMPLATE), markerPath = join(workspace, MARKER);
    await absent(templatePath, 'WORKSPACE_TEMPLATE_EXISTS');
    await absent(markerPath, 'WORKSPACE_MARKER_EXISTS');
    phase = 'PREPARE_OUTPUT_DIRECTORY_FAILED';
    const requestedOutput = resolve(options.outputDir);
    const outputDir = join(await fs.realpath(dirname(requestedOutput)), basename(requestedOutput));
    const outputParentSnapshot = await protectedDirectory(dirname(outputDir), false, 'UNSAFE_PREPARE_OUTPUT_PARENT');
    const sourceRoot = await fs.realpath(packageRoot);
    if (outputDir === sourceRoot || outputDir.startsWith(`${sourceRoot}/`)) fail('OUTPUT_INSIDE_PACKAGE');
    await unchangedDirectory(outputParentSnapshot);
    await fs.mkdir(outputDir, { mode: 0o700 });
    state.outputDir = outputDir;
    const outputStat = await fs.lstat(outputDir);
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || outputStat.uid !== process.getuid()
      || (outputStat.mode & 0o777) !== 0o700) fail('PREPARE_OUTPUT_UNSAFE');
    const outputSnapshot = await protectedDirectory(outputDir, true, 'PREPARE_OUTPUT_UNSAFE');
    const checkOutput = async () => {
      await unchangedDirectory(outputParentSnapshot);
      await unchangedDirectory(outputSnapshot);
    };
    const validation = join(outputDir, 'validation');
    await fs.mkdir(validation, { mode: 0o700 });
    await exclusive(join(validation, TEMPLATE), templateBytes);
    // Reuse the runtime's complete two-role, effort, alias and distinct-model validation.
    await readLauncherTemplate({ ...config, workspace: validation });
    phase = 'PREPARE_PACKAGE_FAILED';
    const manifestBytes = await regularBytes(join(sourceRoot, 'package.json'), 65536);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
    catch { fail('INVALID_PREPARE_PACKAGE'); }
    if (typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)
      || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version)
      || !Array.isArray(manifest.files) || !manifest.files.includes('cordis.patch.yml')
      || manifest.files.some(entry => !relativePath(entry))
      || manifest.exports?.['./launcher'] !== './launcher-entry.js'
      || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('INVALID_PREPARE_PACKAGE');
    const stage = join(outputDir, 'package-stage');
    await fs.mkdir(stage, { mode: 0o700 });
    await exclusive(join(stage, 'package.json'), manifestBytes);
    await copyPayload(sourceRoot, stage, manifest.files);
    await regularBytes(join(stage, 'launcher-entry.js'), 2 * 1024 * 1024);
    const patch = [{ insert: [{ id: 'dsh-native-team-launcher', name: `${manifest.name}/launcher`, config }] }];
    // Generate only our private staging patch, never change the source or an installed profile.
    await exclusive(join(stage, 'cordis.patch.yml'), encode(patch));
    const configPath = join(outputDir, 'launcher-config.json');
    await exclusive(configPath, encode(config));
    const userConfig = join(outputDir, 'npm-user.conf'), globalConfig = join(outputDir, 'npm-global.conf');
    await exclusive(userConfig, Buffer.alloc(0)); await exclusive(globalConfig, Buffer.alloc(0));
    const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', outputDir,
      '--userconfig', userConfig, '--globalconfig', globalConfig], {
      cwd: stage, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/tmp',
        npm_config_cache: join(outputDir, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    await checkOutput();
    await unchangedDirectory(workspaceSnapshot);
    let packed;
    try { packed = JSON.parse(stdout); } catch { fail('PREPARE_PACK_RESULT_INVALID'); }
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== 'string'
      || basename(packed[0].filename) !== packed[0].filename || !packed[0].filename.endsWith('.tgz')) fail('PREPARE_PACK_RESULT_INVALID');
    const packagePath = join(outputDir, packed[0].filename);
    await fs.chmod(packagePath, 0o600);
    const packageBytes = await regularBytes(packagePath, 20 * 1024 * 1024);
    state.packagePath = packagePath;
    const marker = { purpose: 'dsh-native-team-launcher', ownedSessionId: config.ownedSessionId,
      runTag: config.runTag, templateSha256: config.templateSha256 };
    phase = 'WORKSPACE_TEMPLATE_CREATE_FAILED';
    await unchangedDirectory(workspaceSnapshot);
    await exclusive(templatePath, templateBytes, state.createdWorkspacePaths);
    phase = 'WORKSPACE_MARKER_CREATE_FAILED';
    await unchangedDirectory(workspaceSnapshot);
    await exclusive(markerPath, encode(marker), state.createdWorkspacePaths);
    phase = 'PREPARE_FINAL_VALIDATION_FAILED';
    await unchangedDirectory(workspaceSnapshot);
    await readLauncherTemplate(config);
    if (!(await regularBytes(markerPath, 4096, true)).equals(encode(marker))) fail('PREPARED_MARKER_CHANGED');
    const receipt = { ...state, status: 'PREPARED_FOR_OFFICIAL_INSTALL', configPath, templatePath, markerPath,
      ownedSessionId: config.ownedSessionId, workspace, runTag: config.runTag,
      templateSha256: config.templateSha256, packageSha256: digest(packageBytes),
      packageName: manifest.name, packageVersion: manifest.version };
    await unchangedDirectory(workspaceSnapshot);
    phase = 'PREPARE_RECEIPT_PUBLISH_FAILED';
    await publishReceipt(outputDir, receipt, checkOutput);
    return receipt;
  } catch (error) {
    state.status = state.createdWorkspacePaths.length ? 'PARTIAL_PREPARATION' : 'PREPARATION_FAILED';
    // Parser codes are fixed constants. Never return npm output, prompts or arbitrary error text.
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)
      && !['EEXIST', 'EACCES', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) ? error.code : phase;
    throw new LauncherPrepareError(code, state);
  }
}
