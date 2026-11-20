#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { MAC_HOST_ARCHIVE, REVIEWED_HOSTS, hostArchiveForExecutable, hostVersionForArchive } from '../src/host-support.js';

const options = process.argv.slice(2);
let archive = process.platform === 'darwin' ? MAC_HOST_ARCHIVE : undefined;
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--app-executable' && options[i + 1]) archive = hostArchiveForExecutable(resolve(options[++i]));
  else if (options[i] !== '--upstream') throw new Error('Usage: check-host-compat.mjs [--app-executable <Harness executable>] [--upstream]');
}
if (!archive) throw new Error('On Windows, pass --app-executable with the installed DeepSeek Harness.exe path.');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const archiveSha256 = hash.digest('hex'), version = hostVersionForArchive(archiveSha256);
const allVersions = [...new Set(Object.values(REVIEWED_HOSTS).flatMap(versions => Object.keys(versions)))];
const reviewedVersions = Object.keys(REVIEWED_HOSTS[process.platform] ?? {});
const manifestMatches = manifest.engines.dsh === allVersions.join(' || ')
  && manifest.dsh.bundle.platforms.join(',') === Object.keys(REVIEWED_HOSTS).join(',');
const report = { status: !manifestMatches ? 'MANIFEST_HOST_MISMATCH' : version ? 'REVIEWED_HOST' : 'UNREVIEWED_HOST_ARCHIVE',
  packageVersion: manifest.version, platform: process.platform, archive, archiveSha256, hostVersion: version ?? null,
  declaredHosts: manifest.engines.dsh, reviewedHosts: reviewedVersions,
  upstreamReleases: 'https://github.com/deepseek-ai/deepseek-harness/releases',
  scope: 'Read-only archive/manifest check; installation, plugin activation and live acceptance remain separate.' };
if (options.includes('--upstream')) {
  try {
    const { stdout } = await promisify(execFile)('gh', ['api', 'repos/deepseek-ai/deepseek-harness/releases?per_page=10',
      '--jq', '[.[] | select(.tag_name | startswith("dsh-v")) | {version:(.tag_name | ltrimstr("dsh-v")), url:.html_url, publishedAt:.published_at}][0]'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    const latest = JSON.parse(stdout);
    report.upstream = latest ? { status: 'checked', ...latest, needsReview: !reviewedVersions.includes(latest.version) }
      : { status: 'unavailable', reason: 'NO_DSH_RELEASE' };
  } catch (error) { report.upstream = { status: 'unavailable', reason: typeof error.code === 'string' ? error.code : 'GH_READ_FAILED' }; }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = manifestMatches && version ? 0 : 2;
