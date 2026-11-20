import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fail } from './config.js';
import { nativeHostFromApp } from './host.js';
import { hostPathApi, isHostControlPath } from './host-support.js';

const CONTROL = '@deepseek-ai/dsh-tool-subagent-control';

/** M2-only native control entry; reuse the accepted Host guard before any new resolution. */
export async function nativeTeamFromHost() {
  const { nativeSubagent, version, archive, platform } = await nativeHostFromApp();
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
  return Object.freeze({ nativeSubagent, controlEntry: Object.freeze({
    name: pathToFileURL(entryPath, { windows: platform === 'win32' }).href, config: Object.freeze({ interrupt: false }),
  }) });
}
