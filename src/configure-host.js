import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { nativeHostFromApp } from './host.js';
import { hostPathApi } from './host-support.js';
import { fail } from './config.js';

/** Use the schema, tool and approval contracts from the same pinned physical Host. */
export async function nativeConfigurationFromHost() {
  const { adapter, version, archive, platform } = await nativeHostFromApp();
  const path = hostPathApi(platform), host = createRequire(path.join(archive, 'dsh', 'package.json'));
  const load = async name => {
    const root = path.join(archive, 'dsh', 'node_modules', name);
    const metadata = host.resolve(`${name}/package.json`), entry = host.resolve(name);
    const schema = name === '@deepseek-ai/schemastery';
    if (path.relative(root, metadata) !== 'package.json'
      || path.relative(root, entry) !== path.join('lib', schema ? 'index.cjs' : 'index.js')) fail('CONFIGURATION_EXPORT_OUTSIDE_PINNED_HOST');
    const manifest = JSON.parse(await readFile(metadata, 'utf8'));
    if (manifest.name !== name) fail('WRONG_CONFIGURATION_PACKAGE');
    if (!schema && manifest.version !== version) fail('WRONG_CONFIGURATION_HOST_VERSION');
    if (schema && manifest.exports?.['.']?.import !== './lib/index.mjs') fail('WRONG_CONFIGURATION_SCHEMA_EXPORT');
    return import(pathToFileURL(schema ? path.join(root, 'lib', 'index.mjs') : entry, { windows: platform === 'win32' }).href);
  };
  const [schema, tools, sandbox] = await Promise.all([
    load('@deepseek-ai/schemastery'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-sandbox'),
  ]);
  if (typeof schema.default?.object !== 'function' || typeof tools.defineTool !== 'function'
    || typeof sandbox.approveEscalation !== 'function') fail('CONFIGURATION_HOST_CONTRACT_UNAVAILABLE');
  return { adapter, Schema: schema.default, defineTool: tools.defineTool, approveEscalation: sandbox.approveEscalation };
}
