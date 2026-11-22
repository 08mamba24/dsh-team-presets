// Executed only by the official Electron binary, with a temporary HOME and no
// repository token or operator credentials. No Harness profile is started.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { CONTRACT_EXPORTS } from './upstream-contract.mjs';
import { describeNativeError } from '../../scripts/native-error.mjs';

const [runtime, destination, profile, sourceHead] = process.argv.slice(2);
const require = createRequire(join(runtime, 'package.json'));
const result = { passed: true, sourceHead, packages: [], errors: [] };
for (const [short, exports] of Object.entries(CONTRACT_EXPORTS)) {
  const name = '@deepseek-ai/' + short;
  try {
    const metadata = JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8'));
    const module = await import(pathToFileURL(require.resolve(name)).href);
    const missing = exports.filter(key => typeof module[key] !== 'function');
    if (missing.length) throw new Error('Missing public exports: ' + missing.join(', '));
    result.packages.push({ name, version: metadata.version, exports });
  } catch (error) { result.passed = false; result.errors.push({ ...describeNativeError(error), name, code: error.code }); }
}
if (profile && result.passed) {
  try {
    const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
    const [{ initProfile }, { PROFILE_TEMPLATES }] = await Promise.all([load('dsh-app-boot'), load('dsh-official-bundles')]);
    initProfile(profile, PROFILE_TEMPLATES.web.bundles);
    result.profileInitialized = true;
  } catch (error) { result.passed = false; result.errors.push({ ...describeNativeError(error), name: 'profile-initialization', code: error.code }); }
}
await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.exitCode = result.passed ? 0 : 1;
