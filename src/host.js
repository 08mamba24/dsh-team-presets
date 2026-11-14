import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fail } from './config.js';

const ARCHIVE = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

/** Resolve public package exports in the pinned original App, not in the external profile's node_modules. */
export async function nativeSubagentFromHost() {
  if (!process.execPath.startsWith('/Applications/DeepSeek Harness.app/Contents/')) fail('WRONG_HOST_PROCESS');
  // Electron's patched fs treats .asar as a directory; checksum the raw archive.
  const { createReadStream } = createRequire(import.meta.url)('original-fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(ARCHIVE)) hash.update(chunk);
  if (hash.digest('hex') !== '1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d') fail('HOST_ARCHIVE_CHANGED');
  const host = createRequire(`${ARCHIVE}/dsh/package.json`);
  const packagePath = host.resolve('@deepseek-ai/dsh-tool-subagent/package.json');
  if (JSON.parse(await readFile(packagePath, 'utf8')).version !== '0.2.2-rc.2') fail('WRONG_HOST_VERSION');
  return import(pathToFileURL(host.resolve('@deepseek-ai/dsh-tool-subagent')).href);
}
