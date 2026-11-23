import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_EXPORTS, SUITE_NAMES, CLASSIFICATION_PROBES, isFailureAssertion, classifyProbe, failureAssertions } from './upstream-contract.mjs';

export const UPSTREAM = 'deepseek-ai/deepseek-harness';
export const BASELINE = { version: '0.2.2-rc.5', commit: '9c2670d3bce5275e0d1610272958121af87787bb' };
// Source-review attestations complement, rather than replace, archive admission.
// Extend only in the reviewed support-update PR.
export const REVIEWED_SOURCE_COMMITS = { [BASELINE.version]: BASELINE.commit,
  '0.2.3-alpha.2': '4b399c39a6d1479cd84ca591b4d7c88e24d38a96' };
export const TARGETS = ['mac-arm64', 'win-x64'];
// Original reviewed distributions are separate regression controls.
export const REVIEWED_INSTALLERS = {
  'mac-arm64': { format: 'dmg',
    url: 'https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.2-rc.5-mac-arm64.dmg',
    sha256: '9f0c4406ce97f0cdd3862ba1e70a085b422dbeb1390fdeb8a6e810c38b0a8ffd' },
  'win-x64': { format: 'exe',
    url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.5-win-x64.exe',
    sha256: '013e28bc8c714749331308386d814108336851914d243aa6bcfd14de1ab30923' },
};
const MARKER = /<!-- dsh-upstream-compat:v1 ([A-Za-z0-9+/=]+) -->/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const nativePath = /\/(?:subagent|tool-subagent|tool-subagent-control|agent-team|tool-agent-team|agent|agent-loop|agent-preset|agent-preset-registry|scope|tools|tool-executor-native|settings|config-editor|app-boot|official-bundles)\/(?:src\/.*\.[cm]?[jt]s|package\.json)$/;
const fail = message => { throw new Error(message); };
const checkedVersion = v => typeof v === 'string' && v.length < 80 && VERSION.test(v) ? v : fail('Invalid Harness version');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const repoName = value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : fail('Invalid repository');

function compareVersions(a, b) {
  const [aa, ap] = a.split('-'), [bb, bp] = b.split('-');
  const an = aa.split('.').map(Number), bn = bb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (an[i] !== bn[i]) return an[i] - bn[i];
  if (!ap || !bp) return ap === bp ? 0 : ap ? -1 : 1;
  const ax = ap.split('.'), bx = bp.split('.');
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    if (ax[i] === bx[i]) continue;
    if (ax[i] === undefined || bx[i] === undefined) return ax[i] === undefined ? -1 : 1;
    const aNumber = /^\d+$/.test(ax[i]), bNumber = /^\d+$/.test(bx[i]);
    if (aNumber && bNumber) return Number(ax[i]) - Number(bx[i]);
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return ax[i] < bx[i] ? -1 : 1;
  }
  return 0;
}

export function selectReleases(releases, minimum = BASELINE.version) {
  return releases.filter(r => !r.draft && typeof r.tag_name === 'string' && r.tag_name.startsWith('dsh-v')
    && VERSION.test(r.tag_name.slice(5)) && compareVersions(r.tag_name.slice(5), minimum) >= 0)
    .sort((a, b) => compareVersions(a.tag_name.slice(5), b.tag_name.slice(5)));
}

// This deliberately accepts only the three scalar fields used in the official
// electron-updater feed, including its folded scalars. It does not execute YAML.
export function parseFeed(text, target) {
  if (!TARGETS.includes(target) || typeof text !== 'string' || text.length > 65536) fail('Invalid update feed');
  const scalar = key => {
    const matches = [...text.matchAll(new RegExp(`^${key}:[ \\t]*(?:>-?\\r?\\n[ \\t]+)?([^\\r\\n]+)$`, 'gm'))];
    if (matches.length !== 1) fail(`Missing or duplicate feed ${key}`);
    return matches[0][1].trim();
  };
  const version = checkedVersion(scalar('version')), url = scalar('path'), sha512 = scalar('sha512');
  const parsed = new URL(url), extension = target === 'mac-arm64' ? 'zip' : 'exe';
  if (parsed.origin !== 'https://download.deepseek.com' || parsed.search || parsed.hash
    || parsed.username || parsed.password
    || ![ `/dsh-desk/bin/${target}/deepseek-harness-${version}-${target}.${extension}`,
      `/dsh-desk/bin/${target}/stable/deepseek-harness-${version}-${target}.${extension}` ].includes(parsed.pathname)
    || Buffer.from(sha512, 'base64').length !== 64 || Buffer.from(sha512, 'base64').toString('base64') !== sha512) {
    fail('Unverifiable official update artifact');
  }
  return { version, url, sha512 };
}

export function sourceDelta(before, after) {
  if (before.truncated || after.truncated || !Array.isArray(before.tree) || !Array.isArray(after.tree)) fail('Incomplete upstream source tree');
  const files = tree => new Map(tree.filter(e => e.type === 'blob' && nativePath.test(e.path)).map(e => [e.path, e.sha]));
  const a = files(before.tree), b = files(after.tree);
  if (!a.size || !b.size) fail('Native source paths unavailable');
  return { baselineCommit: BASELINE.commit,
    changed: [...new Set([...a.keys(), ...b.keys()])].filter(path => a.get(path) !== b.get(path)).sort(),
    beforeFiles: a.size, afterFiles: b.size };
}

export function fingerprint(c) {
  return digest({ version: c.version, commit: c.commit, target: c.target, artifact: c.artifact,
    plugin: c.plugin, source: c.source, validation: c.validation });
}

async function validationDigest() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = ['.github/scripts/upstream-compat.mjs', '.github/scripts/upstream-contract.mjs',
    '.github/scripts/accept-upstream-host.mjs', '.github/scripts/inspect-upstream-runtime.mjs',
    'scripts/accept-native-admission.mjs', 'scripts/native-admission-check.mjs', 'scripts/native-error.mjs',
    'scripts/native-host-contract.mjs', 'scripts/native-legacy-seed.mjs',
    'scripts/accept-native-replacement-store.mjs', 'scripts/probe-native-team-addressing.mjs',
    'scripts/accept-native-replacement.mjs'];
  return digest(await Promise.all(files.map(async path => [path, digest(await readFile(join(root, path), 'utf8'))])));
}

export function shouldProbe(last, fp, now = Date.now(), force = false) {
  return force || !last || last.fingerprint !== fp
    || last.status === 'infrastructure-error' && now - Date.parse(last.checkedAt) >= 6 * 3600_000;
}

export function normalizeResult(c, raw) {
  const invalid = reason => ({ fingerprint: c.fingerprint, version: c.version, target: c.target,
    status: 'infrastructure-error', reason, checkedAt: new Date().toISOString() });
  const statuses = ['verified', 'needs-review', 'incompatible', 'infrastructure-error'];
  if (!raw || raw.fingerprint !== c.fingerprint || raw.target !== c.target || raw.version !== c.version
    || raw.commit !== c.commit || raw.validation !== c.validation || !samePlugin(raw.plugin, c.plugin)
    || !statuses.includes(raw.status)) return invalid('Missing or mismatched platform receipt');
  if (raw.status === 'infrastructure-error') return raw;
  if (raw.status === 'needs-review' && !c.artifact) {
    return raw.stage === 'artifact' && raw.isolatedDataRemoved === true
      && c.pendingReason?.startsWith('Official ') && c.pendingReason.includes('has not published')
      && raw.reason === c.pendingReason ? raw : invalid('No attested artifact or valid pending reason');
  }
  const sourceHead = 'tgz-sha256:' + raw.pluginSha256;
  const exactSet = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === expected.length && expected.every(value => actual.includes(value));
  const contracts = raw.contract?.packages;
  const contractValid = raw.contract?.passed === true && raw.contract.sourceHead === sourceHead
    && Array.isArray(raw.contract.errors) && raw.contract.errors.length === 0 && Array.isArray(contracts)
    && exactSet(contracts.map(p => p?.name), Object.keys(CONTRACT_EXPORTS).map(n => '@deepseek-ai/' + n))
    && contracts.every(p => exactSet(p.exports, CONTRACT_EXPORTS[p.name.slice(13)])
      && (p.name === '@deepseek-ai/cordis' || p.version === c.version));
  const artifactValid = c.artifact && DIGEST.test(raw.installerSha256 ?? '')
    && typeof raw.installerSha512 === 'string' && Buffer.from(raw.installerSha512, 'base64').length === 64
    && (c.artifact.sha512 ? raw.installerSha512 === c.artifact.sha512 : raw.installerSha256 === c.artifact.sha256);
  const installValid = raw.install?.passed === true && raw.install.name === 'dsh-subagent-live-rc2-local'
    && raw.install.bundleActivated === true && VERSION.test(raw.install.version ?? '')
    && (c.plugin.kind !== 'release' || raw.install.version === c.plugin.tag.slice(1));
  if (!artifactValid || !DIGEST.test(raw.archiveSha256 ?? '') || !DIGEST.test(raw.pluginSha256 ?? '')
    || c.plugin.kind === 'release' && raw.pluginSha256 !== c.plugin.sha256 || raw.isolatedDataRemoved !== true) {
    return invalid('Incomplete installer/plugin/archive identity or cleanup proof');
  }
  if (raw.status === 'incompatible') {
    const proof = raw.failureProof;
    const apiAssertions = failureAssertions(raw.contract);
    const valid = proof && proof.stage === raw.stage && (proof.stage === 'contract' && proof.suite === 'contract'
      || proof.stage === 'native' && SUITE_NAMES.includes(proof.suite))
      && proof.sourceHead === sourceHead && DIGEST.test(proof.receiptSha256 ?? '')
      && DIGEST.test(proof.harnessSha256 ?? '')
      && Array.isArray(proof.assertions) && proof.assertions.length > 0 && proof.assertions.every(isFailureAssertion)
      && classifyProbe({ code: 1 }, { passed: false, sourceHead, errors: proof.assertions }, sourceHead) === 'incompatible'
      && (proof.stage !== 'contract' || raw.contract?.passed === false
        && classifyProbe({ code: 1 }, raw.contract, sourceHead) === 'incompatible'
        && apiAssertions?.length === proof.assertions.length
        && apiAssertions.every((assertion, i) => ['message', 'name', 'code'].every(key => assertion[key] === proof.assertions[i][key])))
      && (proof.stage !== 'native' || contractValid && installValid && raw.admission === 'reviewed');
    return valid ? raw : invalid('No source-bound structured incompatibility proof');
  }
  if (raw.status === 'needs-review' && raw.stage === 'admission') {
    return contractValid && raw.admission === 'unreviewed' && Array.isArray(raw.suites) && raw.suites.length === 0
      ? raw : invalid('No complete public API/admission proof');
  }
  if (raw.status === 'verified' || raw.status === 'needs-review' && raw.candidateChecksPassed === true) {
    if (raw.admission !== 'reviewed' || !installValid
      || !contractValid || !Array.isArray(raw.suites) || !exactSet(raw.suites.map(s => s?.name), SUITE_NAMES)
      || raw.suites.some(s => s.passed !== true || !Number.isInteger(s.checks) || s.checks < 1
        || s.sourceHead !== sourceHead || !DIGEST.test(s.receiptSha256 ?? '') || !DIGEST.test(s.harnessSha256 ?? ''))
      || !Array.isArray(raw.classificationChecks)
      || !exactSet(raw.classificationChecks.map(c => c?.name), CLASSIFICATION_PROBES.map(([name]) => name))
      || raw.classificationChecks.some(check => check.passed !== true || check.sourceHead !== sourceHead
        || !DIGEST.test(check.receiptSha256 ?? '') || check.expected !== check.actual
        || check.actual !== CLASSIFICATION_PROBES.find(([name]) => name === check.name)?.[2]
        || check.actual === 'incompatible' && (check.failureProof?.stage !== 'native'
          || check.failureProof.suite !== 'addressing' || check.failureProof.sourceHead !== sourceHead
          || check.failureProof.receiptSha256 !== check.receiptSha256
          || check.failureProof.harnessSha256 !== raw.suites.find(s => s.name === 'addressing').harnessSha256
          || !Array.isArray(check.failureProof.assertions) || !check.failureProof.assertions.length
          || !check.failureProof.assertions.every(isFailureAssertion)
          || classifyProbe({ code: 1 }, { sourceHead, passed: false, errors: check.failureProof.assertions }, sourceHead) !== 'incompatible'))) {
      return invalid('Incomplete native contract, installation or exact suite proof');
    }
  } else return invalid('No executed proof for this status/stage');
  if (raw.status === 'verified' && (c.source?.reviewed !== true || c.plugin?.kind !== 'release')) {
    return { ...raw, status: 'needs-review', candidateChecksPassed: true,
      reason: c.plugin?.kind === 'source' ? 'Candidate checks passed; non-author review and published-byte verification are still required'
        : 'Upstream source commit has no review attestation; review the source before declaring compatibility' };
  }
  return raw;
}

function samePlugin(a, b) {
  return a?.kind === b?.kind && a?.repo === b?.repo && a?.commit === b?.commit
    && SHA.test(a?.commit ?? '') && (b?.kind === 'source' || b?.kind === 'release'
      && a.tag === b.tag && a.url === b.url && a.sha256 === b.sha256);
}

function verifiedFor(result, expected, target, control = false) {
  const fp = (control ? expected?.controls : expected?.observations)?.[target];
  if (result?.status !== 'verified' || !DIGEST.test(fp ?? '') || expected.plugin?.kind !== 'release') return false;
  const c = { ...result, target, version: control ? BASELINE.version : expected.version,
    commit: control ? BASELINE.commit : expected.commit, plugin: expected.plugin, validation: expected.validation, fingerprint: fp,
    ...(control ? { artifact: REVIEWED_INSTALLERS[target] } : {}) };
  return fingerprint(c) === fp && normalizeResult(c, result).status === 'verified';
}

function stateFrom(issue) {
  if (issue.pull_request || issue.user?.login !== 'github-actions[bot]') return undefined;
  const match = issue.body?.match(MARKER);
  if (!match) return undefined;
  try {
    const state = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (VERSION.test(state.version) && state.observations && typeof state.observations === 'object') return state;
  } catch { /* An invalid marker is not ownership or deduplication evidence. */ }
}

export function renderIssue(state) {
  const lines = [`Harness **${checkedVersion(state.version)}** compatibility with DSH Team.`, '',
    '| Platform | Result | Runtime / package evidence |', '| --- | --- | --- |'];
  for (const target of TARGETS) {
    const r = state.observations[target];
    lines.push(`| ${target} | ${r?.status ?? 'not-tested'} | ${r?.runUrl ? `[Actions](${r.runUrl})` : 'No run receipt'} |`);
  }
  lines.push('', 'Results are specific to the recorded plugin build and official installer bytes. Unknown archive admission is **needs-review**, not a demonstrated API conflict. GUI and paid-provider behavior are not tested.', '');
  lines.push('Reviewed rc.5 regression controls: ' + TARGETS.map(t => `${t}: **${state.controls?.[t]?.status ?? 'not-tested'}**`).join('; '), '');
  for (const target of TARGETS) {
    const r = state.observations[target];
    if (!r) continue;
    lines.push(`### ${target}`, '', `- Upstream commit: \`${r.commit ?? 'unavailable'}\``,
      `- Installer SHA256: \`${r.installerSha256 ?? 'unavailable'}\``,
      `- app.asar SHA256: \`${r.archiveSha256 ?? 'unavailable'}\``,
      `- Plugin: \`${r.plugin?.tag ?? r.plugin?.commit ?? 'unavailable'}\` / \`${r.pluginSha256 ?? r.plugin?.sha256 ?? 'unavailable'}\``,
      `- Stage: \`${r.stage ?? 'complete'}\`; checked ${r.checkedAt ?? 'unknown'}`,
      `- ${String(r.reason ?? 'All required isolated checks passed.').replace(/[\r\n]/g, ' ').slice(0, 500)}`, '');
    const changed = r.source?.changed;
    if (changed?.length) lines.push(`Native source changes against reviewed baseline: ${changed.length} files.`,
      '<details><summary>First 60 changed paths</summary>', '', ...changed.slice(0, 60).map(p => `- \`${p.replace(/[`\r\n]/g, '')}\``), '', '</details>', '');
  }
  lines.push('### Maintenance loop', '',
    '- [ ] Inspect native source/API changes and installer identity; fix affected bindings on a candidate branch.',
    '- [ ] Run both platform canaries with `tag` and an exact 40-character `plugin_ref` in the manual workflow; keep the existing reviewed runtime as regression coverage.',
    '- [ ] Obtain non-author review before merging `REVIEWED_HOSTS` / `engines.dsh` changes and the exact `REVIEWED_SOURCE_COMMITS` attestation; the monitor never approves these itself.',
    '- [ ] After merge, publish a new plugin TGZ and checksum, then update the existing community catalog tarball entry and verify its public readback.',
    '- [ ] Run the monitor against the published plugin again. The same version Issue closes only after both platform receipts verify the exact build.', '',
    'See [upstream maintenance instructions](../blob/main/docs/UPSTREAM-COMPATIBILITY.md). Human discussion belongs in comments; the monitor owns this report body.', '',
    `<!-- dsh-upstream-compat:v1 ${Buffer.from(JSON.stringify(state)).toString('base64')} -->`);
  return lines.join('\n');
}

export async function publishVersion(api, repo, state, issues) {
  const matches = issues.filter(i => stateFrom(i)?.version === state.version);
  if (matches.length > 1) fail('Duplicate managed version Issues; reconcile before writing');
  const body = renderIssue(state), title = `[upstream-compat] Harness ${checkedVersion(state.version)}`;
  if (!matches.length && issues.some(i => i.title === title)) fail('Existing version Issue has no verifiable managed state');
  const closed = state.expected?.version === state.version && TARGETS.every(t =>
    verifiedFor(state.observations[t], state.expected, t) && verifiedFor(state.controls?.[t], state.expected, t, true));
  let issue = matches[0];
  if (!issue) issue = await api(`repos/${repo}/issues`, { method: 'POST', body: { title, body } });
  const wanted = closed ? 'closed' : 'open';
  if (issue.body !== body || issue.state !== wanted) {
    issue = await api(`repos/${repo}/issues/${issue.number}`, { method: 'PATCH', body: { body, state: wanted } });
  }
  return issue;
}

export async function ghApi(path, options = {}) {
  const args = ['api', path];
  if (options.method) args.push('--method', options.method, '--input', '-');
  return new Promise((done, reject) => {
    const child = spawn(process.env.GH_BIN ?? 'gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 16 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2048); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`GitHub API ${path.split('?')[0]} failed (${code}, ${stderr.match(/HTTP \d{3}/)?.[0] ?? 'no HTTP status'})`));
      try { done(JSON.parse(stdout)); } catch { reject(new Error('Invalid GitHub API JSON')); }
    });
    child.stdin.end(options.body ? JSON.stringify(options.body) : undefined);
  });
}

async function pages(api, path) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail('Invalid GitHub collection');
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  fail('GitHub collection exceeds bounded scan; no incomplete deduplication');
}

async function fetchArtifactHead(url) {
  if (new URL(url).origin !== 'https://download.deepseek.com') fail('Untrusted historical artifact origin');
  const head = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!head.ok) fail(`Official artifact HTTP ${head.status}`);
  return { etag: head.headers.get('etag'), size: head.headers.get('content-length'), lastModified: head.headers.get('last-modified') };
}

async function fetchFeed(target) {
  const suffix = target === 'mac-arm64' ? 'stable-mac.yml' : 'stable.yml';
  const url = `https://download.deepseek.com/dsh-desk/feeds/${target}/${suffix}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) fail(`Official ${target} feed HTTP ${response.status}`);
  const artifact = parseFeed(await response.text(), target);
  return { ...artifact, ...await fetchArtifactHead(artifact.url) };
}

export async function makePlan({ api = ghApi, feedReader = fetchFeed, headReader = fetchArtifactHead, repo, tag, force = false, pluginRef,
  now = Date.now() }) {
  repoName(repo);
  const [allReleases, issues, baseTree] = await Promise.all([
    pages(api, `repos/${UPSTREAM}/releases`), pages(api, `repos/${repo}/issues?state=all`),
    api(`repos/${UPSTREAM}/git/trees/${BASELINE.commit}?recursive=1`),
  ]);
  let plugin;
  if (pluginRef) {
    if (!SHA.test(pluginRef)) fail('plugin_ref must be an exact commit in this repository');
    const verified = await api(`repos/${repo}/commits/${pluginRef}`);
    if (verified.sha !== pluginRef) fail('Candidate commit could not be resolved');
    plugin = { kind: 'source', commit: pluginRef, repo };
  } else {
    const releases = await pages(api, `repos/${repo}/releases`);
    const candidates = releases.filter(r => !r.draft && /^v\d/.test(r.tag_name)
      && VERSION.test(r.tag_name.slice(1))).sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
    const latest = candidates.find(r => r.assets?.some(a => a.name.endsWith('.tgz')));
    const asset = latest?.assets.find(a => a.name.endsWith('.tgz'));
    if (!asset?.digest?.match(/^sha256:[a-f0-9]{64}$/)
      || !asset.browser_download_url.startsWith(`https://github.com/${repo}/releases/download/`)) fail('No verifiable published plugin TGZ');
    const commit = await api(`repos/${repo}/commits/${encodeURIComponent(latest.tag_name)}`);
    plugin = { kind: 'release', tag: latest.tag_name, commit: commit.sha, repo,
      url: asset.browser_download_url, sha256: asset.digest.slice(7) };
  }
  const feeds = Object.fromEntries(await Promise.all(TARGETS.map(async target => {
    try { return [target, await feedReader(target)]; }
    catch (error) { return [target, { error: error.message }]; }
  })));
  const releases = selectReleases(allReleases);
  if (tag && (!tag.startsWith('dsh-v') || !VERSION.test(tag.slice(5)))) fail('Invalid upstream tag');
  const selected = tag ? releases.filter(r => r.tag_name === tag) : releases;
  if (!selected.length) fail('No matching published Harness release');
  const validation = await validationDigest();
  const cases = [], states = {};
  for (const release of selected) {
    const version = release.tag_name.slice(5);
    const resolved = await api(`repos/${UPSTREAM}/commits/${encodeURIComponent(release.tag_name)}`);
    if (!SHA.test(resolved.sha)) fail('Upstream tag did not resolve to a commit');
    const tree = resolved.sha === BASELINE.commit ? baseTree
      : await api(`repos/${UPSTREAM}/git/trees/${resolved.sha}?recursive=1`);
    const source = { ...sourceDelta(baseTree, tree), reviewed: REVIEWED_SOURCE_COMMITS[version] === resolved.sha };
    const prior = issues.map(stateFrom).find(s => s?.version === version);
    states[version] = prior ?? { version, observations: {} };
    states[version].expected = { version, commit: resolved.sha, plugin, validation,
      observations: {}, controls: prior?.expected?.controls ?? {} };
    for (const target of TARGETS) {
      const feed = feeds[target];
      let artifact = feed.version === version ? feed : null, historicalError;
      const retained = prior?.observations[target]?.artifact;
      // A previously observed official feed is an attestation for its original
      // bytes, even after the live feed advances. Revalidate its URL and HTTP
      // object; never skip an old tag move or invent a historical download URL.
      if (!artifact && !feed.error && compareVersions(feed.version, version) > 0 && retained) {
        try {
          const original = parseFeed(`version: ${version}\npath: ${retained.url}\nsha512: ${retained.sha512}\n`, target);
          artifact = { ...original, ...await headReader(original.url) };
        } catch (error) { historicalError = error.message; }
      }
      const c = { version, tag: release.tag_name, commit: resolved.sha, target, artifact, plugin, source, validation,
        pendingReason: historicalError ?? feed.error ?? (!artifact ? `Official ${target} feed has not published this version` : null) };
      c.fingerprint = fingerprint(c);
      states[version].expected.observations[target] = c.fingerprint;
      if (shouldProbe(prior?.observations[target], c.fingerprint, now, force)) {
        cases.push({ ...c, runner: target === 'mac-arm64' ? 'macos-15' : 'windows-2022' });
      }
    }
  }
  if (cases.length) for (const target of TARGETS) {
    const control = { version: BASELINE.version, tag: 'dsh-v' + BASELINE.version,
      commit: BASELINE.commit, target, control: true, artifact: REVIEWED_INSTALLERS[target],
      plugin, validation, source: { ...sourceDelta(baseTree, baseTree), reviewed: true }, runner: target === 'mac-arm64' ? 'macos-15' : 'windows-2022' };
    control.fingerprint = fingerprint(control); cases.push(control);
    for (const state of Object.values(states)) state.expected.controls[target] = control.fingerprint;
  }
  return { schemaVersion: 1, status: 'planned', repo, createdAt: new Date(now).toISOString(), plugin, states, cases };
}

async function main() {
  const command = process.argv[2], directory = resolve(process.env.COMPAT_OUTPUT_DIR ?? 'compat-output');
  const repo = repoName(process.env.GITHUB_REPOSITORY ?? '08mamba24/dsh-team-presets');
  await mkdir(directory, { recursive: true });
  if (command === 'plan') {
    let plan;
    try { plan = await makePlan({ repo, tag: process.env.COMPAT_TAG || undefined,
      pluginRef: process.env.COMPAT_PLUGIN_REF || undefined, force: process.env.COMPAT_FORCE === 'true' }); }
    catch (error) { plan = { status: 'infrastructure-error', repo, error: error.message, cases: [] }; process.exitCode = 1; }
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include: plan.cases })}\ncount=${plan.cases.length}\n`);
    console.log(JSON.stringify({ status: plan.status, cases: plan.cases.map(c => ({ version: c.version, target: c.target })), error: plan.error }));
  } else if (command === 'publish') {
    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
    if (plan.repo !== repo) fail('Plan repository mismatch');
    const issues = await pages(ghApi, `repos/${repo}/issues?state=all`);
    const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    if (plan.status !== 'planned') {
      const title = '[upstream-compat] Monitor health';
      let issue = issues.find(i => i.title === title && i.user?.login === 'github-actions[bot]');
      const body = `Upstream observation could not complete. No compatibility claim was made.\n\n${plan.error}\n\n[Failed run](${runUrl})`;
      if (process.env.COMPAT_PUBLISH === 'true') {
        await ghApi(`repos/${repo}/issues${issue ? '/' + issue.number : ''}`,
          { method: issue ? 'PATCH' : 'POST', body: { title, body, ...(issue ? { state: 'open' } : {}) } });
      }
      fail('Upstream observation unavailable');
    }
    const files = await readdir(directory, { recursive: true });
    const raw = [];
    for (const name of files.filter(n => n.endsWith('result.json'))) {
      try { const result = JSON.parse(await readFile(join(directory, name), 'utf8')); if (result) raw.push(result); }
      catch { /* An unreadable receipt becomes missing proof for its planned case. */ }
    }
    const touched = new Set(), controls = {};
    for (const c of plan.cases) {
      const matches = raw.filter(r => r.fingerprint === c.fingerprint);
      const result = normalizeResult(c, matches.length === 1 ? matches[0] : undefined);
      Object.assign(result, { commit: c.commit, source: c.source, plugin: c.plugin, artifact: c.artifact, validation: c.validation, runUrl });
      if (c.control) { controls[c.target] = result; continue; }
      plan.states[c.version].observations[c.target] = result; touched.add(c.version);
    }
    const published = [];
    for (const version of touched) {
      const state = plan.states[version];
      state.controls = controls;
      if (process.env.COMPAT_PUBLISH === 'true') {
        const issue = await publishVersion(ghApi, repo, state, issues);
        published.push({ version, issue: issue.html_url, state: issue.state });
      } else await writeFile(join(directory, `preview-${version}.md`), renderIssue(state));
    }
    const health = issues.find(i => i.title === '[upstream-compat] Monitor health' && i.user?.login === 'github-actions[bot]' && i.state === 'open');
    if (health && process.env.COMPAT_PUBLISH === 'true') await ghApi(`repos/${repo}/issues/${health.number}`, { method: 'PATCH', body: { state: 'closed' } });
    await writeFile(join(directory, 'summary.json'), JSON.stringify({ published, states: plan.states }, null, 2) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Upstream compatibility\n\n${published.map(p => `- [${p.version}](${p.issue}): ${p.state}`).join('\n') || 'No new observations; unchanged inputs were deduplicated.'}\n`);
    console.log(JSON.stringify({ planned: plan.cases.length, published }));
    if (Object.values(controls).some(r => r.status !== 'verified' && r.candidateChecksPassed !== true)
      || [...touched].some(v => Object.values(plan.states[v].observations).some(r => r.status === 'infrastructure-error' || r.status === 'incompatible'))) process.exitCode = 1;
  } else fail('Usage: upstream-compat.mjs plan|publish');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
