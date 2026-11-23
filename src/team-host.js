import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fail } from './config.js';
import { nativeHostFromApp } from './host.js';
import { hostPathApi, isHostControlPath } from './host-support.js';

const CONTROL = '@deepseek-ai/dsh-tool-subagent-control';
const TASK_CONTROL = '@deepseek-ai/dsh-tool-agent-team';
const SCOPE = '@deepseek-ai/dsh-scope';

async function resolvedControlHost() {
  const { nativeSubagent, adapter, version, archive, platform } = await nativeHostFromApp();
  const path = hostPathApi(platform), host = createRequire(path.join(archive, 'dsh', 'package.json'));
  const metadataPath = host.resolve(`${CONTROL}/package.json`);
  const entryPath = host.resolve(CONTROL);
  if (!isHostControlPath(metadataPath, 'package.json', archive, platform)
    || !isHostControlPath(entryPath, 'lib/index.js', archive, platform)
    || path.relative(entryPath, path.join(path.dirname(metadataPath), 'lib/index.js')) !== '') {
    fail('CONTROL_EXPORT_OUTSIDE_PINNED_HOST');
  }
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch { fail('CONTROL_PACKAGE_METADATA_INVALID'); }
  if (metadata?.name !== CONTROL) fail('WRONG_CONTROL_PACKAGE');
  if (metadata.version !== version) fail('WRONG_CONTROL_HOST_VERSION');
  return { nativeSubagent, adapter, version, archive, platform, path, host, entryPath };
}

/** M2-only native control entry; reuse the accepted Host guard before any new resolution. */
export async function nativeTeamFromHost() {
  const { nativeSubagent, adapter, entryPath, platform } = await resolvedControlHost();
  return Object.freeze({ nativeSubagent, adapter, controlEntry: Object.freeze({
    name: pathToFileURL(entryPath, { windows: platform === 'win32' }).href, config: Object.freeze({ interrupt: false }),
  }) });
}

/** Public scope primitive and native control module from the same pinned Host. */
export async function nativeRoleControlFromHost() {
  const { adapter, version, archive, platform, path, host, entryPath } = await resolvedControlHost();
  const scopeRoot = path.join(archive, 'dsh', 'node_modules', SCOPE);
  const scopeMetadataPath = host.resolve(`${SCOPE}/package.json`), scopeEntryPath = host.resolve(SCOPE);
  const taskRoot = path.join(archive, 'dsh', 'node_modules', TASK_CONTROL);
  const taskMetadataPath = host.resolve(`${TASK_CONTROL}/package.json`), taskEntryPath = host.resolve(TASK_CONTROL);
  if (path.relative(scopeRoot, scopeMetadataPath) !== 'package.json'
    || path.relative(scopeRoot, scopeEntryPath) !== path.join('lib', 'index.js')
    || path.relative(taskRoot, taskMetadataPath) !== 'package.json'
    || path.relative(taskRoot, taskEntryPath) !== path.join('lib', 'index.js')) {
    fail('SCOPE_EXPORT_OUTSIDE_PINNED_HOST');
  }
  let metadata, taskMetadata;
  try {
    [metadata, taskMetadata] = await Promise.all([scopeMetadataPath, taskMetadataPath]
      .map(async file => JSON.parse(await readFile(file, 'utf8'))));
  }
  catch { fail('SCOPE_PACKAGE_METADATA_INVALID'); }
  if (metadata?.name !== SCOPE || metadata.version !== version
    || taskMetadata?.name !== TASK_CONTROL || taskMetadata.version !== version) fail('WRONG_SCOPE_HOST_VERSION');
  const [controlModule, taskModule, scopeApi] = await Promise.all([
    import(pathToFileURL(entryPath, { windows: platform === 'win32' }).href),
    import(pathToFileURL(taskEntryPath, { windows: platform === 'win32' }).href),
    import(pathToFileURL(scopeEntryPath, { windows: platform === 'win32' }).href),
  ]);
  if (typeof controlModule.apply !== 'function' || typeof taskModule.apply !== 'function'
    || typeof scopeApi.createScope !== 'function'
    || typeof scopeApi.scopeOf !== 'function' || typeof scopeApi.scopeParentOf !== 'function') {
    fail('ROLE_CONTROL_HOST_CONTRACT_UNAVAILABLE');
  }
  return Object.freeze({ controlModule, taskModule, scopeApi, adapter });
}
