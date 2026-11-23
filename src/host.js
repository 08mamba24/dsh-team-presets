import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fail } from './config.js';
import { assertHostExecutable, assertCanonicalHostBundle, hostPathApi, hostVersionForArchive } from './host-support.js';
import { createHostAdapter } from './host-adapter.js';

/** Resolve public package exports in the pinned original App, not in the external profile's node_modules. */
export async function nativeHostFromApp() {
  const platform = process.platform, archive = assertHostExecutable(), path = hostPathApi(platform);
  // Electron's patched fs treats .asar as a directory; checksum the raw archive.
  const rawFs = createRequire(import.meta.url)('original-fs');
  const { createReadStream } = rawFs;
  await assertCanonicalHostBundle(process.execPath, platform, file => rawFs.realpathSync(file));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const version = hostVersionForArchive(hash.digest('hex'), platform);
  if (!version) fail('HOST_ARCHIVE_CHANGED');
  const host = createRequire(path.join(archive, 'dsh', 'package.json'));
  const runtimeMetadata = JSON.parse(await readFile(host.resolve('./package.json'), 'utf8'));
  const cliMetadata = JSON.parse(await readFile(host.resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
  if (runtimeMetadata.name !== '@deepseek-ai/dsh-desktop-runtime' || runtimeMetadata.version !== version
    || cliMetadata.name !== '@deepseek-ai/dsh' || cliMetadata.version !== version) fail('WRONG_HOST_VERSION');
  const packagePath = host.resolve('@deepseek-ai/dsh-tool-subagent/package.json');
  if (JSON.parse(await readFile(packagePath, 'utf8')).version !== version) fail('WRONG_HOST_VERSION');
  const nativeSubagent = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-tool-subagent')).href);
  const Context = version === '0.2.3-alpha.2'
    ? (await import(pathToFileURL(host.resolve('@deepseek-ai/cordis')).href)).Context : undefined;
  const adapter = createHostAdapter({ version, Context });
  return Object.freeze({ nativeSubagent, adapter, version, archive, platform });
}

export async function nativeSubagentFromHost() {
  return (await nativeHostFromApp()).nativeSubagent;
}
