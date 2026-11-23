import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
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
  const contained = candidate => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) return false;
    const relative = path.relative(archive, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const resolve = async name => {
    const candidate = host.resolve(name);
    if (!contained(candidate) || !contained(await realpath(candidate))) fail('HOST_MODULE_OUTSIDE_PINNED_ARCHIVE');
    return candidate;
  };
  const runtimeMetadata = JSON.parse(await readFile(await resolve('./package.json'), 'utf8'));
  const cliMetadata = JSON.parse(await readFile(await resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
  if (runtimeMetadata.name !== '@deepseek-ai/dsh-desktop-runtime' || runtimeMetadata.version !== version
    || cliMetadata.name !== '@deepseek-ai/dsh' || cliMetadata.version !== version) fail('WRONG_HOST_VERSION');
  const packagePath = await resolve('@deepseek-ai/dsh-tool-subagent/package.json');
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  if (metadata.name !== '@deepseek-ai/dsh-tool-subagent' || metadata.version !== version) fail('WRONG_HOST_VERSION');
  const nativeEntry = await resolve('@deepseek-ai/dsh-tool-subagent');
  let cordisEntry;
  if (version === '0.2.3-alpha.2') {
    const cordisMetadata = JSON.parse(await readFile(await resolve('@deepseek-ai/cordis/package.json'), 'utf8'));
    // Cordis has its own version, inspected in the exact alpha.2 archive.
    if (cordisMetadata.name !== '@deepseek-ai/cordis' || cordisMetadata.version !== '4.2.0-alpha.1') fail('WRONG_HOST_VERSION');
    cordisEntry = await resolve('@deepseek-ai/cordis');
  }
  const nativeSubagent = await import(pathToFileURL(nativeEntry, { windows: platform === 'win32' }).href);
  const Context = cordisEntry === undefined ? undefined
    : (await import(pathToFileURL(cordisEntry, { windows: platform === 'win32' }).href)).Context;
  const adapter = createHostAdapter({ version, Context });
  return Object.freeze({ nativeSubagent, adapter, version, archive, platform });
}

export async function nativeSubagentFromHost() {
  return (await nativeHostFromApp()).nativeSubagent;
}
