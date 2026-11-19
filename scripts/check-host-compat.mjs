#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOST_ARCHIVE, REVIEWED_HOSTS, hostVersionForArchive } from '../src/host-support.js';

const options = process.argv.slice(2);
if (options.some(option => option !== '--upstream')) throw new Error('Usage: check-host-compat.mjs [--upstream]');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const hash = createHash('sha256');
for await (const chunk of createReadStream(HOST_ARCHIVE)) hash.update(chunk);
const archiveSha256 = hash.digest('hex'), version = hostVersionForArchive(archiveSha256);
const manifestMatches = manifest.engines.dsh === Object.keys(REVIEWED_HOSTS).join(' || ');
const report = { status: !manifestMatches ? 'MANIFEST_HOST_MISMATCH' : version ? 'REVIEWED_HOST' : 'UNREVIEWED_HOST_ARCHIVE',
  packageVersion: manifest.version, archive: HOST_ARCHIVE, archiveSha256, hostVersion: version ?? null,
  declaredHosts: manifest.engines.dsh, reviewedHosts: Object.keys(REVIEWED_HOSTS),
  upstreamReleases: 'https://github.com/deepseek-ai/deepseek-harness/releases',
  scope: 'Read-only archive/manifest check; installation, plugin activation and live acceptance remain separate.' };
if (options.includes('--upstream')) {
  try {
    const { stdout } = await promisify(execFile)('gh', ['api', 'repos/deepseek-ai/deepseek-harness/releases?per_page=10',
      '--jq', '[.[] | select(.tag_name | startswith("dsh-v")) | {version:(.tag_name | ltrimstr("dsh-v")), url:.html_url, publishedAt:.published_at}][0]'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    const latest = JSON.parse(stdout);
    report.upstream = latest ? { status: 'checked', ...latest, needsReview: !Object.hasOwn(REVIEWED_HOSTS, latest.version) }
      : { status: 'unavailable', reason: 'NO_DSH_RELEASE' };
  } catch (error) { report.upstream = { status: 'unavailable', reason: typeof error.code === 'string' ? error.code : 'GH_READ_FAILED' }; }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = manifestMatches && version ? 0 : 2;
