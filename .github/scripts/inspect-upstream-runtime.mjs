// Executed only by the official Electron binary, with a temporary HOME and no
// repository token or operator credentials. No Harness profile is started.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [runtime, destination] = process.argv.slice(2);
const require = createRequire(join(runtime, 'package.json'));
const contracts = {
  'cordis': ['Context'],
  'dsh-scope': ['createScope', 'scopeOf', 'scopeParentOf'],
  'dsh-tools': ['ToolsService', 'defineTool'],
  'dsh-agent': ['AgentRegistry'],
  'dsh-agent-preset-registry': ['AgentPresetRegistry'],
  'dsh-agent-loop': ['AgentLoop'],
  'dsh-tool-executor-native': ['NativeToolExecutor'],
};
const result = { passed: true, packages: [], errors: [] };
for (const [short, exports] of Object.entries(contracts)) {
  const name = '@deepseek-ai/' + short;
  try {
    const metadata = JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8'));
    const module = await import(pathToFileURL(require.resolve(name)).href);
    const missing = exports.filter(key => typeof module[key] !== 'function');
    if (missing.length) throw new Error('Missing public exports: ' + missing.join(', '));
    result.packages.push({ name, version: metadata.version, exports });
  } catch (error) { result.passed = false; result.errors.push({ name, message: error.message }); }
}
await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.exitCode = result.passed ? 0 : 1;
