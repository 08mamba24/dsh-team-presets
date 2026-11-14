import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail } from './config.js';
import { nativeSubagentFromHost } from './host.js';

const ARCHIVE = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const HOST_MODULES = `${ARCHIVE}/dsh/node_modules/`;
const CONTROL = '@deepseek-ai/dsh-tool-subagent-control';

function assertControlPath(path, suffix) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path
    || !path.startsWith(HOST_MODULES) || !path.endsWith(`/node_modules/${CONTROL}/${suffix}`)) {
    fail('CONTROL_EXPORT_OUTSIDE_PINNED_HOST');
  }
}

/** M2-only native control entry; reuse the accepted Host guard before any new resolution. */
export async function nativeTeamFromHost() {
  const nativeSubagent = await nativeSubagentFromHost();
  const host = createRequire(`${ARCHIVE}/dsh/package.json`);
  const metadataPath = host.resolve(`${CONTROL}/package.json`);
  const entryPath = host.resolve(CONTROL);
  assertControlPath(metadataPath, 'package.json');
  assertControlPath(entryPath, 'lib/index.js');
  if (entryPath !== join(dirname(metadataPath), 'lib/index.js')) fail('CONTROL_EXPORT_OUTSIDE_PINNED_HOST');
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch { fail('CONTROL_PACKAGE_METADATA_INVALID'); }
  if (metadata?.name !== CONTROL) fail('WRONG_CONTROL_PACKAGE');
  if (metadata.version !== '0.2.2-rc.2') fail('WRONG_CONTROL_HOST_VERSION');
  return Object.freeze({ nativeSubagent, controlEntry: Object.freeze({
    name: pathToFileURL(entryPath).href, config: Object.freeze({ interrupt: false }),
  }) });
}
