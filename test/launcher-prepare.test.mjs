// The historical file-bound entry relies on POSIX ownership and mode bits.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' ? 'Legacy macOS file-bound entry' : false }, fn);
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLauncher, LauncherPrepareError } from '../src/launcher-prepare.js';
import { readLauncherTemplate, assertLauncherOwned } from '../src/launcher-config.js';

const exec = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const example = JSON.parse(await fs.readFile(new URL('../examples/team-template.json', import.meta.url), 'utf8'));
// Deliberately synthetic; never use an acceptance Session in setup fixtures.
const sessionId = 'session-11111111-2222-4333-8444-555555555555';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, template = structuredClone(example)) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dsh-launcher-prepare-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), outputDir = join(root, 'prepared'), templatePath = join(root, 'input.json');
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  return { root, workspace, outputDir, templatePath, options: { sessionId, workspace, outputDir, templatePath, runTag: 'launcher-prepare-test' } };
}
async function missing(path) { await assert.rejects(fs.lstat(path), error => error.code === 'ENOENT'); }
const code = expected => error => {
  assert.ok(error instanceof LauncherPrepareError); assert.equal(error.code, expected);
  assert.equal(error.message, expected); return true;
};

test('offline preparation produces an exact bound TGZ and files accepted by existing readers', async t => {
  const h = await fixture(t), sourcePatch = await fs.readFile(join(sourceRoot, 'cordis.patch.yml'));
  const result = await prepareLauncher(h.options);
  assert.equal(result.status, 'PREPARED_FOR_OFFICIAL_INSTALL');
  assert.equal(result.installed, false); assert.equal(result.nativeAuthorizationVerified, false); assert.equal(result.modelCalls, 0);
  assert.equal((await fs.stat(h.outputDir)).mode & 0o777, 0o700);
  const config = JSON.parse(await fs.readFile(result.configPath, 'utf8'));
  assert.deepEqual(config.startup, { maxTokens: 1024, maxStreams: { implementer: 1, reviewer: 1 } });
  assert.equal(config.timeoutMs, 120000); assert.equal(config.workspace, h.workspace); assert.equal(config.ownedSessionId, sessionId);
  for (const path of [result.templatePath, result.markerPath, result.configPath, result.packagePath, join(h.outputDir, 'PREPARED.json')]) {
    const stat = await fs.lstat(path); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1);
  }
  const template = await readLauncherTemplate(config);
  assert.equal(template.members[0].personaPrompt, example.members[0].persona_prompt);
  const agent = { id: sessionId, session: { id: sessionId, header: { cwd: h.workspace } } };
  assert.equal(await assertLauncherOwned({ agents: { get: id => id === sessionId ? agent : undefined } }, config, agent), true);
  const { stdout } = await exec('tar', ['-xOzf', result.packagePath, 'package/cordis.patch.yml']);
  const patch = JSON.parse(stdout);
  assert.equal(Array.isArray(patch), true);
  const manifest = JSON.parse((await exec('tar', ['-xOzf', result.packagePath, 'package/package.json'])).stdout);
  assert.deepEqual(patch, [{ insert: [{ id: 'dsh-native-team-launcher', name: `${manifest.name}/launcher`, config }] }]);
  assert.equal(result.packageSha256, digest(await fs.readFile(result.packagePath)));
  assert.deepEqual(JSON.parse(await fs.readFile(join(h.outputDir, 'PREPARED.json'), 'utf8')), result);
  assert.deepEqual(await fs.readFile(join(sourceRoot, 'cordis.patch.yml')), sourcePatch);
});

test('existing template or marker, including symlinks and hardlinks, is never replaced', async t => {
  for (const filename of ['.dsh-team-template.json', '.dsh-team-launcher.json']) {
    for (const kind of ['file', 'symlink', 'hardlink']) {
      const h = await fixture(t), path = join(h.workspace, filename), target = join(h.root, 'preserved');
      await fs.writeFile(target, 'preserve-user-bytes', { mode: 0o600 });
      if (kind === 'file') await fs.writeFile(path, 'preserve-user-bytes', { mode: 0o600 });
      if (kind === 'symlink') await fs.symlink(target, path);
      if (kind === 'hardlink') await fs.link(target, path);
      const before = await fs.lstat(path);
      await assert.rejects(prepareLauncher(h.options), code(filename.includes('template') ? 'WORKSPACE_TEMPLATE_EXISTS' : 'WORKSPACE_MARKER_EXISTS'));
      const after = await fs.lstat(path);
      assert.equal(after.ino, before.ino); assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
      assert.equal(await fs.readFile(path, 'utf8'), 'preserve-user-bytes');
      assert.equal(await fs.readFile(target, 'utf8'), 'preserve-user-bytes');
      await missing(join(h.workspace, filename.includes('template') ? '.dsh-team-launcher.json' : '.dsh-team-template.json'));
      await missing(h.outputDir);
    }
  }
});

test('invalid routes, capabilities, roles and effort are refused without any workspace writes', async t => {
  const cases = [
    [x => { x.members[0].native_tool_allowlist.push('spawn_agent'); }, 'UNSUPPORTED_MEMBER_TOOL'],
    [x => { x.members[0].reasoning_effort = ''; }, 'INVALID_MEMBER_EFFORT'],
    [x => { delete x.members[0].persona_prompt; }, 'LAUNCHER_ROLE_CONFIGURATION_INCOMPLETE'],
    [x => { x.members.pop(); x.seed_tasks = []; }, 'LAUNCHER_EXACT_ROLES_REQUIRED'],
  ];
  for (const [change, expected] of cases) {
    const template = structuredClone(example); change(template); const h = await fixture(t, template);
    await assert.rejects(prepareLauncher(h.options), error => {
      code(expected)(error); assert.equal(error.state.status, 'PREPARATION_FAILED');
      assert.deepEqual(error.state.createdWorkspacePaths, []); return true;
    });
    assert.deepEqual(await fs.readdir(h.workspace), []);
    await missing(join(h.outputDir, 'PREPARED.json'));
  }
});

test('a second-file race preserves both the new template and conflicting marker, reports partial and produces no ready receipt', async t => {
  const h = await fixture(t), markerPath = join(h.workspace, '.dsh-team-launcher.json'), originalOpen = fs.open;
  let raced = false;
  t.mock.method(fs, 'open', async (path, flags, ...args) => {
    if (path === markerPath && (flags & constants.O_EXCL) && !raced) {
      raced = true;
      const other = await originalOpen(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await other.writeFile('concurrent-marker'); await other.close();
      const error = new Error('untrusted error containing arbitrary prompt text'); error.code = 'EEXIST'; throw error;
    }
    return originalOpen(path, flags, ...args);
  });
  await assert.rejects(prepareLauncher(h.options), error => {
    code('WORKSPACE_MARKER_CREATE_FAILED')(error);
    assert.equal(error.state.status, 'PARTIAL_PREPARATION');
    assert.deepEqual(error.state.createdWorkspacePaths, [join(h.workspace, '.dsh-team-template.json')]);
    assert.ok(error.state.packagePath.endsWith('.tgz'));
    assert.equal(JSON.stringify(error).includes('arbitrary prompt'), false); return true;
  });
  t.mock.restoreAll();
  assert.equal(raced, true); assert.equal(await fs.readFile(markerPath, 'utf8'), 'concurrent-marker');
  assert.deepEqual(await fs.readFile(join(h.workspace, '.dsh-team-template.json')), await fs.readFile(h.templatePath));
  await missing(join(h.outputDir, 'PREPARED.json'));
});

test('output must be new and a workspace symlink becomes only its canonical path', async t => {
  const h = await fixture(t);
  await fs.mkdir(h.outputDir, { mode: 0o700 }); await fs.writeFile(join(h.outputDir, 'keep'), 'old');
  await assert.rejects(prepareLauncher(h.options), code('PREPARE_OUTPUT_DIRECTORY_FAILED'));
  assert.equal(await fs.readFile(join(h.outputDir, 'keep'), 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(h.workspace), []);
  const alias = join(h.root, 'workspace-alias'); await fs.symlink(h.workspace, alias);
  const result = await prepareLauncher({ ...h.options, workspace: alias, outputDir: join(h.root, 'canonical-output') });
  assert.equal(result.workspace, h.workspace);
});

test('package whitelist traversal through a symlink is refused before workspace writes', async t => {
  const h = await fixture(t), packageRoot = join(h.root, 'source'), outside = join(h.root, 'outside');
  await fs.mkdir(packageRoot); await fs.mkdir(outside); await fs.writeFile(join(outside, 'secret'), 'never-copy');
  await fs.symlink(outside, join(packageRoot, 'aliased'));
  await fs.writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.4.0',
    files: ['aliased/secret', 'cordis.patch.yml'], exports: { './launcher': './launcher-entry.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await assert.rejects(prepareLauncher(h.options, packageRoot), code('UNSAFE_PACKAGE_PAYLOAD'));
  assert.deepEqual(await fs.readdir(h.workspace), []); await missing(join(h.outputDir, 'PREPARED.json'));
  await missing(join(h.outputDir, 'package-stage/aliased/secret'));
});

test('npm packing ignores lifecycle scripts and leaves other local data untouched', async t => {
  const h = await fixture(t), packageRoot = join(h.root, 'source'), unrelated = join(h.root, 'preserved-data');
  await fs.mkdir(packageRoot); await fs.writeFile(unrelated, 'unchanged');
  const manifest = { name: 'fixture', version: '0.4.0', private: true,
    files: ['launcher-entry.js', 'cordis.patch.yml'], exports: { './launcher': './launcher-entry.js' },
    scripts: { prepack: `node -e "require('fs').writeFileSync('PREPACK_EXECUTED', 'bad')"` },
    dsh: { bundle: { patch: './cordis.patch.yml' } } };
  await fs.writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(join(packageRoot, 'launcher-entry.js'), 'export const name = "fixture";\n');
  await fs.writeFile(join(packageRoot, 'cordis.patch.yml'), '[{"insert":[]}]');
  const result = await prepareLauncher(h.options, packageRoot);
  assert.equal(result.status, 'PREPARED_FOR_OFFICIAL_INSTALL');
  await missing(join(h.outputDir, 'package-stage/PREPACK_EXECUTED'));
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unchanged');
  assert.equal(await fs.readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8'), '[{"insert":[]}]');
  assert.equal(await fs.readFile(join(h.outputDir, 'npm-user.conf'), 'utf8'), '');
  assert.equal(await fs.readFile(join(h.outputDir, 'npm-global.conf'), 'utf8'), '');
});

test('CLI help and argument errors do not start preparation or disclose supplied text', async t => {
  const script = fileURLToPath(new URL('../scripts/prepare-launcher.mjs', import.meta.url));
  const { stdout } = await exec(process.execPath, [script, '--help']);
  assert.match(stdout, /does not install or call a model/); assert.match(stdout, /--session-id/);
  assert.match(stdout, /command exits 0/); assert.match(stdout, /File existence alone is insufficient/);
  await assert.rejects(exec(process.execPath, [script, '--unknown', 'personal-prompt-text']), error => {
    assert.deepEqual(JSON.parse(error.stderr), { code: 'INVALID_PREPARE_ARGUMENTS' });
    assert.equal(error.stderr.includes('personal-prompt-text'), false); return true;
  });
});

test('receipt write and fsync failures cannot publish PREPARED.json', async t => {
  for (const fault of ['write', 'sync']) {
    const h = await fixture(t), originalOpen = fs.open;
    let injected = false;
    t.mock.method(fs, 'open', async (path, ...args) => {
      const file = await originalOpen(path, ...args);
      if (/\/(?:PREPARED\.json|\.PREPARED-[^/]+\.tmp)$/.test(path)) {
        const operation = fault === 'write' ? 'writeFile' : 'sync', originalWrite = file.writeFile.bind(file);
        t.mock.method(file, operation, async () => {
          injected = true;
          if (fault === 'write') await originalWrite('{"status":"PREPARED_FOR_OFFICIAL_INSTALL"');
          const error = new Error('receipt storage failure'); error.code = 'EIO'; throw error;
        });
      }
      return file;
    });
    await assert.rejects(prepareLauncher(h.options), error => {
      assert.equal(error.state.status, 'PARTIAL_PREPARATION'); return true;
    });
    t.mock.restoreAll();
    assert.equal(injected, true);
    await missing(join(h.outputDir, 'PREPARED.json'));
    assert.equal((await fs.readdir(h.outputDir)).filter(name => /^\.PREPARED-.*\.tmp$/.test(name)).length, 1);
  }
});

test('failure to remove the temporary receipt alias after publication does not report a failed preparation', async t => {
  const h = await fixture(t), originalUnlink = fs.unlink;
  let injected = false;
  t.mock.method(fs, 'unlink', async path => {
    if (/\/\.PREPARED-[^/]+\.tmp$/.test(path)) {
      injected = true; const error = new Error('alias cleanup failure'); error.code = 'EACCES'; throw error;
    }
    return originalUnlink(path);
  });
  const result = await prepareLauncher(h.options);
  t.mock.restoreAll();
  assert.equal(injected, true); assert.equal(result.status, 'PREPARED_FOR_OFFICIAL_INSTALL');
  assert.deepEqual(JSON.parse(await fs.readFile(join(h.outputDir, 'PREPARED.json'), 'utf8')), result);
  assert.equal((await fs.stat(join(h.outputDir, 'PREPARED.json'))).mode & 0o777, 0o600);
});

test('atomic receipt publication never replaces an existing final receipt', async t => {
  const h = await fixture(t), originalLink = fs.link;
  t.mock.method(fs, 'link', async (source, target) => {
    if (target === join(h.outputDir, 'PREPARED.json')) await fs.writeFile(target, 'concurrent-receipt', { flag: 'wx', mode: 0o600 });
    return originalLink(source, target);
  });
  await assert.rejects(prepareLauncher(h.options), code('PREPARE_RECEIPT_PUBLISH_FAILED'));
  t.mock.restoreAll();
  assert.equal(await fs.readFile(join(h.outputDir, 'PREPARED.json'), 'utf8'), 'concurrent-receipt');
});

test('shared writable workspace or output parents are refused before creating data', async t => {
  const workspaceCase = await fixture(t);
  await fs.chmod(workspaceCase.workspace, 0o777);
  await assert.rejects(prepareLauncher(workspaceCase.options), code('UNSAFE_PREPARE_WORKSPACE'));
  assert.deepEqual(await fs.readdir(workspaceCase.workspace), []); await missing(workspaceCase.outputDir);

  const parentCase = await fixture(t), parent = join(parentCase.root, 'shared-output');
  await fs.mkdir(parent, { mode: 0o777 }); await fs.chmod(parent, 0o777);
  await assert.rejects(prepareLauncher({ ...parentCase.options, outputDir: join(parent, 'prepared') }), code('UNSAFE_PREPARE_OUTPUT_PARENT'));
  assert.deepEqual(await fs.readdir(parentCase.workspace), []); assert.deepEqual(await fs.readdir(parent), []);

  const ancestorCase = await fixture(t);
  await fs.chmod(ancestorCase.root, 0o777);
  await assert.rejects(prepareLauncher(ancestorCase.options), code('UNSAFE_PREPARE_WORKSPACE'));
  assert.deepEqual(await fs.readdir(ancestorCase.workspace), []); await missing(ancestorCase.outputDir);
});

test('a root-owned sticky temporary directory is allowed as the output parent', async t => {
  const h = await fixture(t), temporaryParent = await fs.realpath('/tmp'), stat = await fs.lstat(temporaryParent);
  assert.equal(stat.uid, 0); assert.notEqual(stat.mode & 0o1000, 0);
  const outputDir = join(temporaryParent, `dsh-sticky-output-${basename(h.root)}`);
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const result = await prepareLauncher({ ...h.options, outputDir });
  assert.equal(result.status, 'PREPARED_FOR_OFFICIAL_INSTALL');
  assert.equal((await fs.stat(outputDir)).mode & 0o777, 0o700);
});

test('a workspace renamed and redirected while npm pack is awaited receives no prepared workspace files', async t => {
  const h = await fixture(t), redirected = join(h.root, 'redirected'), original = join(h.root, 'original-workspace');
  await fs.mkdir(redirected, { mode: 0o700 });
  const originalExec = childProcess.execFile;
  let pivoted = false;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => originalExec(file, args, options, (error, stdout, stderr) => {
    if (file !== 'npm' || error) return callback(error, stdout, stderr);
    // Keep the pack promise pending through the pivot; no timer-dependent race in this test.
    (async () => {
      await fs.rename(h.workspace, original); await fs.symlink(redirected, h.workspace); pivoted = true;
      callback(error, stdout, stderr);
    })().catch(callback);
  }));
  syncBuiltinESMExports();
  await assert.rejects(prepareLauncher(h.options), error => {
    code('PREPARE_DIRECTORY_CHANGED')(error);
    assert.deepEqual(error.state.createdWorkspacePaths, []); return true;
  });
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(pivoted, true); assert.deepEqual(await fs.readdir(redirected), []);
  assert.deepEqual(await fs.readdir(original), []); await missing(join(h.outputDir, 'PREPARED.json'));
});
