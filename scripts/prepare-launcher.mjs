#!/usr/bin/env node
import { prepareLauncher } from '../src/launcher-prepare.js';

const usage = `Prepare a local launcher package; does not install or call a model.

Usage:
  node scripts/prepare-launcher.mjs --session-id SESSION --workspace PATH --template FILE --output-dir NEW_DIR

Optional: --run-tag TAG --timeout-ms INTEGER
Requires an existing root and its workspace. Both native model routes must already be authorized.
NEW_DIR must not exist. Workspace template/marker files are created exclusively with mode0600.
Workspace must belong to you and must not be group/world writable. Ancestors of workspace and output
must belong to you or root and must not be group/world writable, except root-owned sticky temp ancestors.
These checks do not provide atomic isolation from other processes running as your UID.
The generated bound TGZ contains personal Session/workspace bindings: keep it local.
Install using the official Harness plugin manager only after this command exits 0 and the complete
PREPARED.json has status PREPARED_FOR_OFFICIAL_INSTALL. File existence alone is insufficient.
`;

function argumentsOf(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const keys = { '--session-id': 'sessionId', '--workspace': 'workspace', '--template': 'templatePath',
    '--output-dir': 'outputDir', '--run-tag': 'runTag', '--timeout-ms': 'timeoutMs' };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(options, key) || typeof value !== 'string' || value.startsWith('--') || !value) throw new Error('INVALID_PREPARE_ARGUMENTS');
    options[key] = key === 'timeoutMs' ? (/^[1-9]\d*$/.test(value) ? Number(value) : NaN) : value;
  }
  return options;
}

try {
  const options = argumentsOf(process.argv.slice(2));
  if (options === null) process.stdout.write(usage);
  else process.stdout.write(`${JSON.stringify(await prepareLauncher(options), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error?.state ? error.code : 'INVALID_PREPARE_ARGUMENTS',
    ...(error?.state ? { state: error.state } : {}) })}\n`);
  process.exitCode = 1;
}
