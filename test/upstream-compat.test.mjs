import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { parseFeed, selectReleases, sourceDelta, fingerprint, shouldProbe, normalizeResult,
  publishVersion, makePlan, BASELINE, REVIEWED_INSTALLERS, renderIssue } from '../.github/scripts/upstream-compat.mjs';
import { isolatedEnvironment } from '../.github/scripts/accept-upstream-host.mjs';
import { CONTRACT_EXPORTS, SUITE_NAMES, CLASSIFICATION_PROBES, classifyProbe } from '../.github/scripts/upstream-contract.mjs';
import { nativeAdmissionCheck } from '../scripts/native-admission-check.mjs';
import { describeNativeError } from '../scripts/native-error.mjs';

const sha = 'a'.repeat(40), hash = 'b'.repeat(64);
const feed = `version: 0.2.2-rc.5\npath: >-\n  https://download.deepseek.com/dsh-desk/bin/mac-arm64/stable/deepseek-harness-0.2.2-rc.5-mac-arm64.zip\nsha512: >-\n  ${Buffer.alloc(64, 7).toString('base64')}\n`;
const observation = { version: '0.2.2-rc.5', tag: 'dsh-v0.2.2-rc.5', commit: sha,
  target: 'mac-arm64', artifact: { ...parseFeed(feed, 'mac-arm64'), etag: 'v1' },
  plugin: { kind: 'release', repo: 'owner/repo', tag: 'v0.5.0-rc.7', commit: sha, sha256: hash,
    url: 'https://github.com/owner/repo/releases/download/v0.5.0-rc.7/plugin.tgz' }, source: { changed: [], reviewed: true } };

function caseFor(target = 'mac-arm64', control = false) {
  const c = { ...observation, target,
    ...(control ? { commit: BASELINE.commit, control: true } : {}),
    artifact: control ? REVIEWED_INSTALLERS[target] : parseFeed(feed.replaceAll('mac-arm64', target)
      .replaceAll('.zip', target === 'win-x64' ? '.exe' : '.zip'), target) };
  return { ...c, fingerprint: fingerprint(c) };
}
function verified(c) {
  const sourceHead = 'tgz-sha256:' + (c.plugin.sha256 ?? hash);
  return { ...c, status: 'verified', archiveSha256: hash,
    installerSha256: c.artifact.sha256 ?? hash, installerSha512: c.artifact.sha512 ?? Buffer.alloc(64, 7).toString('base64'),
    pluginSha256: c.plugin.sha256 ?? hash, admission: 'reviewed', isolatedDataRemoved: true,
    install: { passed: true, name: 'dsh-subagent-live-rc2-local', version: '0.5.0-rc.7', bundleActivated: true },
    contract: { passed: true, sourceHead, errors: [], packages: Object.entries(CONTRACT_EXPORTS)
      .map(([name, exports]) => ({ name: '@deepseek-ai/' + name, version: name === 'cordis' ? '4.0.0' : c.version, exports })) },
    suites: SUITE_NAMES.map(name => ({ name, passed: true, checks: 5, sourceHead, receiptSha256: hash, harnessSha256: hash })),
    classificationChecks: CLASSIFICATION_PROBES.map(([name, _fault, expected]) => ({ name, passed: true,
      sourceHead, receiptSha256: hash, expected, actual: expected, ...(expected === 'incompatible' ? { failureProof: {
        stage: 'native', suite: 'addressing', sourceHead, receiptSha256: hash, harnessSha256: hash,
        assertions: [{ code: 'ERR_ASSERTION', name: 'early addressing assertion', message: 'Injected business failure' }],
      } } : {}) })) };
}
function report(status = 'verified') {
  const observations = {}, controls = {}, expected = { version: observation.version, commit: sha,
    plugin: observation.plugin, observations: {}, controls: {} };
  for (const target of ['mac-arm64', 'win-x64']) {
    const c = caseFor(target), control = caseFor(target, true);
    observations[target] = { ...verified(c), status }; controls[target] = verified(control);
    expected.observations[target] = c.fingerprint; expected.controls[target] = control.fingerprint;
  }
  return { version: observation.version, expected, observations, controls };
}

test('official folded update feed resolves its exact version and SHA512, with no arbitrary installer URL', () => {
  const actual = parseFeed(feed, 'mac-arm64');
  assert.equal(actual.version, '0.2.2-rc.5');
  assert.equal(Buffer.from(actual.sha512, 'base64').length, 64);
  assert.ok(actual.url.endsWith('-mac-arm64.zip'));
  for (const bad of [feed.replace('download.deepseek.com', 'example.com'), feed.replace('sha512:', 'digest:'),
    feed.replace('0.2.2-rc.5-mac', '0.2.2-rc.4-mac'), feed.replace('version:', 'version: {bad}\nunused:')]) {
    assert.throws(() => parseFeed(bad, 'mac-arm64'));
  }
  assert.throws(() => parseFeed(feed, 'win-x64'));
});

test('RC releases are monitored even when a full release exists; drafts and unrelated tags are excluded', () => {
  const releases = ['dsh-v0.2.2-rc.4', 'dsh-v0.2.2-rc.5', 'dsh-v0.2.2-rc.6', 'dsh-v0.2.2', 'other-v9.0.0']
    .map(tag_name => ({ tag_name, draft: false }));
  releases.push({ tag_name: 'dsh-v0.2.3', draft: true });
  assert.deepEqual(selectReleases(releases, '0.2.2-rc.5').map(r => r.tag_name),
    ['dsh-v0.2.2-rc.5', 'dsh-v0.2.2-rc.6', 'dsh-v0.2.2']);
});

test('native source comparison includes removed paths and refuses an incomplete Git tree', () => {
  const tree = (path, id) => ({ path, sha: id, type: 'blob' });
  const before = { tree: [tree('packages/agent/subagent/src/index.ts', sha)] };
  const after = { tree: [tree('packages/agent/subagent/src/renamed.ts', hash.slice(0, 40))] };
  assert.equal(sourceDelta(before, after).changed.length, 2);
  assert.throws(() => sourceDelta(before, { ...after, truncated: true }));
});

test('tag moves, repackages and a new plugin build each invalidate deduplication', () => {
  const original = fingerprint(observation);
  for (const next of [{ ...observation, commit: 'c'.repeat(40) },
    { ...observation, artifact: { ...observation.artifact, sha512: 'new bytes' } },
    { ...observation, artifact: { ...observation.artifact, etag: 'new HTTP object' } },
    { ...observation, validation: 'c'.repeat(64) },
    { ...observation, plugin: { ...observation.plugin, sha256: 'd'.repeat(64) } }]) {
    assert.notEqual(fingerprint(next), original);
  }
  assert.equal(fingerprint({ ...observation, checkedAt: 'later' }), original);
});

test('unchanged verified and pending versions deduplicate; infrastructure failures retry after six hours', () => {
  const now = Date.parse('2026-11-22T00:00:00Z'), fp = fingerprint(observation);
  assert.equal(shouldProbe(undefined, fp, now), true);
  for (const status of ['verified', 'needs-review', 'incompatible']) {
    const last = { fingerprint: fp, status, checkedAt: new Date(now).toISOString() };
    assert.equal(shouldProbe(last, fp, now), false);
    assert.equal(shouldProbe(last, fp, now, true), true);
  }
  const last = { fingerprint: fp, status: 'infrastructure-error', checkedAt: new Date(now).toISOString() };
  assert.equal(shouldProbe(last, fp, now + 60_000), false);
  assert.equal(shouldProbe(last, fp, now + 6 * 3600_000), true);
});

test('unknown archive admission is pending; missing, forged and failed results cannot become compatible', () => {
  const c = { ...observation, fingerprint: fingerprint(observation) };
  assert.equal(normalizeResult(c, { ...verified(c), status: 'needs-review', stage: 'admission', admission: 'unreviewed', suites: [] }).status, 'needs-review');
  assert.equal(normalizeResult(c, undefined).status, 'infrastructure-error');
  assert.equal(normalizeResult(c, { ...c, status: 'verified' }).status, 'infrastructure-error');
  assert.equal(normalizeResult(c, { ...c, fingerprint: 'forged', status: 'verified',
    admission: 'reviewed', suites: [{ passed: true }] }).status, 'infrastructure-error');
  assert.equal(normalizeResult(c, { ...c, status: 'incompatible', stage: 'native',
    admission: 'reviewed' }).status, 'infrastructure-error');
});

test('one version keeps one Issue across repeat runs and reopens after a previously verified version changes', async () => {
  let issues = [], next = 1, creates = 0;
  const api = async (path, options = {}) => {
    const id = Number(path.split('/').at(-1));
    if (options.method === 'POST') {
      const issue = { number: next++, user: { login: 'github-actions[bot]' }, state: 'open', ...options.body };
      issues.push(issue); creates++; return issue;
    }
    if (options.method === 'PATCH') { Object.assign(issues.find(i => i.number === id), options.body); return issues.find(i => i.number === id); }
    return issues;
  };
  const first = await publishVersion(api, 'owner/repo', report('verified'), issues);
  assert.equal(first.state, 'closed');
  await publishVersion(api, 'owner/repo', report('verified'), issues);
  assert.equal(creates, 1);
  const changed = await publishVersion(api, 'owner/repo', report('needs-review'), issues);
  assert.equal(changed.number, first.number);
  assert.equal(changed.state, 'open');
  const missingControl = report('verified'); delete missingControl.controls;
  const incomplete = await publishVersion(api, 'owner/repo', missingControl, issues);
  assert.equal(incomplete.state, 'open', 'platform observations alone cannot replace the reviewed baseline controls');
  for (const field of ['commit', 'pluginSha256']) {
    const mixed = report(); mixed.observations['win-x64'][field] = 'c'.repeat(field === 'commit' ? 40 : 64);
    assert.equal((await publishVersion(api, 'owner/repo', mixed, issues)).state, 'open', 'mixed builds cannot close the version');
  }
  await assert.rejects(() => publishVersion(api, 'owner/repo', report('verified'),
    [{ title: '[upstream-compat] Harness ' + observation.version, user: { login: 'github-actions[bot]' }, body: 'corrupt' }]), /verifiable/);
});

test('a verified platform requires all six suites, CLI installation, reviewed admission and successful cleanup', () => {
  const c = caseFor(), raw = verified(c);
  assert.equal(normalizeResult(c, raw).status, 'verified');
  for (const invalid of [{ ...raw, isolatedDataRemoved: false }, { ...raw, admission: 'unreviewed' },
    { ...raw, suites: raw.suites.slice(1) }, { ...raw, install: { passed: false } }]) {
    assert.equal(normalizeResult(c, invalid).status, 'infrastructure-error');
  }
  for (const [next, wanted] of [[{ ...c, source: { changed: ['native.ts'], reviewed: false } }, 'needs-review'],
    [{ ...c, plugin: { ...c.plugin, kind: 'source' } }, 'needs-review'],
    [{ ...c, source: { changed: [], reviewed: false } }, 'needs-review'],
    [{ ...c, source: { changed: ['native.ts'], reviewed: true } }, 'verified']]) {
    next.fingerprint = fingerprint(next);
    assert.equal(normalizeResult(next, verified(next)).status, wanted);
  }
});

test('matching public fingerprints cannot turn incomplete or mismatched proof into verified', () => {
  const c = caseFor(), raw = verified(c);
  const invalid = [ { ...raw, commit: 'c'.repeat(40) }, { ...raw, plugin: { ...raw.plugin, commit: 'c'.repeat(40) } },
    { ...raw, classificationChecks: [] },
    { ...raw, classificationChecks: raw.classificationChecks.map(check => ({ ...check, failureProof: undefined })) },
    { ...raw, installerSha256: undefined }, { ...raw, installerSha512: Buffer.alloc(64, 8).toString('base64') },
    { ...raw, pluginSha256: 'd'.repeat(64) }, { ...raw, contract: undefined },
    { ...raw, contract: { ...raw.contract, packages: {} } }, { ...raw, suites: {} },
    { ...raw, install: { ...raw.install, version: '0.5.0-rc.6' } },
    { ...raw, suites: raw.suites.map(s => ({ ...s, name: 'same-fake-suite' })) } ];
  for (const r of invalid) assert.equal(normalizeResult(c, r).status, 'infrastructure-error');
});

test('timeouts, signals and cleanup errors stay infrastructure failures; source-bound contract failures are distinct', () => {
  const outcome = { code: 1, signal: null, timedOut: false }, sourceHead = 'tgz-sha256:' + hash;
  const receipt = { sourceHead, passed: false, errors: [{ code: 'ERR_ASSERTION', message: 'Native contract changed' }] };
  assert.equal(classifyProbe(outcome, receipt, sourceHead), 'incompatible');
  for (const [o, r] of [[{ ...outcome, timedOut: true }, receipt], [{ ...outcome, signal: 'SIGABRT' }, receipt],
    [outcome, undefined], [outcome, { ...receipt, isolatedDataRemoved: false }],
    [outcome, { ...receipt, errors: [{ code: 'EPERM', message: 'unlink' }] }],
    [outcome, { ...receipt, checks: [{ passed: false, error: { code: 'EPERM', message: 'unlink' } }] }],
    [outcome, { ...receipt, errors: 'corrupt' }], [{ ...outcome, code: undefined }, receipt],
    [outcome, { ...receipt, errors: [{}] }], [outcome, { ...receipt, errors: ['not an error record'] }],
    [outcome, { ...receipt, checks: null }], [outcome, { ...receipt, errors: null }],
    [outcome, { ...receipt, cleanupError: { code: 'ERR_ASSERTION', message: 'fixture teardown' } }],
    [outcome, { ...receipt, errors: [{ code: 'ERR_ASSERTION', message: 'wrapper', provenance: ['corrupt'] }] }],
    [outcome, { ...receipt, errors: [{ code: 'ERR_ASSERTION', message: 'wrapper', provenanceIncomplete: true }] }],
    [outcome, { ...receipt, errors: [{ code: 'ERR_ASSERTION', message: 'wrapper', actual: { code: 'EPERM' } }] }],
    [outcome, { ...receipt, errors: [{ code: 'ERR_ASSERTION', message: 'wrapper', cause: { code: 'EPERM' } }] }],
    [outcome, { ...receipt, errors: [{ code: 'ERR_ASSERTION', message: 'wrapper', provenance: [
      { code: 'ERR_ASSERTION', message: 'partial nested provenance', provenanceIncomplete: true },
    ] }] }],
    [outcome, { sourceHead, passed: false, checks: [{ passed: false }] }],
    [outcome, { sourceHead, passed: false, checks: [{ name: 'business', passed: false }] }]]) {
    assert.equal(classifyProbe(o, r, sourceHead), 'infrastructure-error');
  }
});

test('pending admission and incompatibility require the corresponding source-bound execution proof', () => {
  const c = caseFor(), raw = verified(c);
  for (const status of ['incompatible', 'needs-review']) assert.equal(normalizeResult(c, { ...c, status }).status, 'infrastructure-error');
  const failed = { ...raw, status: 'incompatible', stage: 'native', failureProof: {
    stage: 'native', suite: 'replacement', sourceHead: raw.contract.sourceHead, receiptSha256: hash, harnessSha256: hash,
    assertions: [{ name: 'native replacement', code: 'ERR_ASSERTION', message: 'Native behavior changed' }] } };
  assert.equal(normalizeResult(c, failed).status, 'incompatible');
  for (const proof of [undefined, { ...failed.failureProof, receiptSha256: undefined },
    { ...failed.failureProof, sourceHead: 'other-source' }, { ...failed.failureProof, assertions: [{}] },
    { ...failed.failureProof, assertions: [{ code: 'EPERM', message: 'unlink' }] }]) {
    assert.equal(normalizeResult(c, { ...failed, failureProof: proof }).status, 'infrastructure-error');
  }
  assert.equal(normalizeResult(c, { ...failed, install: undefined }).status, 'infrastructure-error');
  assert.equal(normalizeResult(c, { ...failed, stage: undefined, failureProof: undefined }).status, 'infrastructure-error');
  const apiFailure = { ...failed, stage: 'contract', contract: { ...raw.contract, passed: false,
    errors: [{ name: '@deepseek-ai/dsh-scope', message: 'Missing public export' }] },
    failureProof: { ...failed.failureProof, stage: 'contract', suite: 'contract',
      assertions: [{ name: '@deepseek-ai/dsh-scope', message: 'Missing public export' }] } };
  assert.equal(normalizeResult(c, apiFailure).status, 'incompatible');
  assert.equal(normalizeResult(c, { ...apiFailure, contract: undefined }).status, 'infrastructure-error');
  const pending = { ...raw, status: 'needs-review', stage: 'admission', admission: 'unreviewed', suites: [] };
  assert.equal(normalizeResult(c, pending).status, 'needs-review');
  for (const missing of ['contract', 'installerSha256', 'pluginSha256', 'archiveSha256']) {
    assert.equal(normalizeResult(c, { ...pending, [missing]: undefined }).status, 'infrastructure-error');
  }
  const unavailable = { ...c, artifact: null, pendingReason: 'Official mac-arm64 feed has not published this version' };
  unavailable.fingerprint = fingerprint(unavailable);
  assert.equal(normalizeResult(unavailable, { ...unavailable, status: 'needs-review', stage: 'artifact',
    reason: unavailable.pendingReason, isolatedDataRemoved: true }).status, 'needs-review');
});

test('the admission suite emits explicit business failures while setup exceptions remain infrastructure', () => {
  const sourceHead = 'tgz-sha256:' + hash;
  // Shape of the physical admission.json: predicate evidence is spread into
  // each named check. A frozen member executing a write is a business failure.
  const failed = nativeAdmissionCheck('real-preset-frozen-old-blocks-direct-tool-and-ui-input', false,
    { stats: { prepare: 1, stream: 1, approval: 0, bodies: { write: 1 }, agentErrors: [] }, historyCount: 4 });
  assert.equal(classifyProbe({ code: 1 }, { sourceHead, passed: false, checks: [failed] }, sourceHead), 'incompatible');
  assert.equal(classifyProbe({ code: 1 }, { sourceHead, passed: false, checks: [failed],
    setupError: { code: 'EPERM', message: 'setup write failed' } }, sourceHead), 'infrastructure-error');
  const ioFailed = nativeAdmissionCheck(failed.name, false, { stats: { ...failed.stats,
    agentErrors: [describeNativeError(Object.assign(new Error('body IO failure'), { code: 'EPERM' }))] } });
  assert.equal(classifyProbe({ code: 1 }, { sourceHead, passed: false, checks: [ioFailed] }, sourceHead), 'infrastructure-error');
  const success = nativeAdmissionCheck('normal-role', true, { stats: { prepare: 1 } });
  assert.equal(success.error, undefined);
  assert.equal(classifyProbe({ code: 0 }, { sourceHead, passed: true, checks: [success] }, sourceHead), 'passed');
});

test('real Node assertion wrappers retain nested actual/cause IO provenance', async () => {
  const sourceHead = 'tgz-sha256:' + hash;
  const io = Object.assign(new Error('native fixture IO denied'), { code: 'EPERM' });
  let wrapped;
  try { await assert.rejects(Promise.reject(io), { code: 'TEAM_ADDRESS_LAYER_OCCUPIED' }); }
  catch (error) { wrapped = error; }
  assert.equal(wrapped.code, 'ERR_ASSERTION'); assert.equal(wrapped.actual.code, 'EPERM');
  for (const error of [wrapped, Object.assign(new Error('outer assertion'), { code: 'ERR_ASSERTION', cause: io }),
    Object.assign(new AggregateError([io], 'aggregate assertion'), { code: 'ERR_ASSERTION' })]) {
    const described = describeNativeError(error);
    const receipt = { sourceHead, passed: false, checks: [{ name: 'native failure', passed: false, error: described }] };
    assert.equal(classifyProbe({ code: 1 }, receipt, sourceHead), 'infrastructure-error');
    const c = caseFor(), raw = verified(c);
    assert.equal(normalizeResult(c, { ...raw, status: 'incompatible', stage: 'native', failureProof: {
      stage: 'native', suite: 'addressing', sourceHead: raw.contract.sourceHead,
      receiptSha256: hash, harnessSha256: hash, assertions: [described],
    } }).status, 'infrastructure-error');
  }
});

test('Host environment inherits neither GitHub credentials, model keys nor operator startup options', () => {
  const lab = resolve('isolated-test-home');
  const env = isolatedEnvironment(lab, resolve('official-resources'), process.platform, {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    HOME: '/operator', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret',
    NODE_OPTIONS: '--require /operator/preload.js', PATH: '/operator/bin',
  });
  assert.equal(env.HOME, join(lab, 'home'));
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.ok(!env.PATH.includes('/operator'));
});

test('planning consumes public prereleases and official feeds, without writing or automatically trusting an archive', async () => {
  const release = { tag_name: 'dsh-v0.2.2-rc.5', draft: false };
  const native = { tree: [{ type: 'blob', path: 'packages/agent/subagent/src/index.ts', sha }] };
  const api = async path => {
    if (path.startsWith('repos/owner/repo/issues')) return [];
    if (path.startsWith('repos/owner/repo/releases')) return [{ tag_name: 'v0.5.0-rc.7', draft: false,
      assets: [{ name: 'plugin.tgz', digest: 'sha256:' + hash,
        browser_download_url: 'https://github.com/owner/repo/releases/download/v0.5.0-rc.7/plugin.tgz' }] }];
    if (path.startsWith('repos/owner/repo/commits/')) return { sha };
    if (path.includes('/releases?')) return [release];
    if (path.includes('/commits/')) return { sha: BASELINE.commit };
    if (path.includes('/git/trees/')) return native;
    throw new Error('Unexpected API write or endpoint: ' + path);
  };
  const plan = await makePlan({ api, repo: 'owner/repo', feedReader: async target => ({
    ...parseFeed(feed, 'mac-arm64'), target,
  }) });
  assert.equal(plan.cases.length, 4);
  assert.deepEqual(plan.cases.filter(c => !c.control).map(c => c.target), ['mac-arm64', 'win-x64']);
  assert.deepEqual(plan.cases.filter(c => c.control).map(c => c.target), ['mac-arm64', 'win-x64']);
  assert.equal(plan.plugin.tag, 'v0.5.0-rc.7');
  assert.ok(plan.cases.every(c => /^[a-f0-9]{64}$/.test(c.validation)));
  assert.equal(plan.cases[0].source.changed.length, 0);
  assert.equal(plan.cases[0].admission, undefined);
});

test('an old tag move is still observed after Desktop feeds advance; its attested installer remains usable', async () => {
  const packageInfo = { kind: 'release', tag: 'v0.5.0-rc.7', commit: sha, repo: 'owner/repo',
    url: 'https://github.com/owner/repo/releases/download/v0.5.0-rc.7/plugin.tgz', sha256: hash };
  const previous = { version: '0.2.2-rc.5', observations: {} };
  const artifact = target => parseFeed(feed.replaceAll('mac-arm64', target)
    .replaceAll('.zip', target === 'win-x64' ? '.exe' : '.zip'), target);
  for (const target of ['mac-arm64', 'win-x64']) previous.observations[target] = {
    fingerprint: 'previous', status: 'verified', commit: BASELINE.commit, plugin: packageInfo, artifact: artifact(target),
  };
  const native = { tree: [{ type: 'blob', path: 'packages/agent/subagent/src/index.ts', sha }] };
  const api = async path => {
    if (path.startsWith('repos/owner/repo/issues')) return [{ user: { login: 'github-actions[bot]' }, body: renderIssue(previous) }];
    if (path.startsWith('repos/owner/repo/releases')) return [{ tag_name: packageInfo.tag, assets: [
      { name: 'plugin.tgz', digest: 'sha256:' + hash, browser_download_url: packageInfo.url }] }];
    if (path.startsWith('repos/owner/repo/commits/')) return { sha };
    if (path.includes('/releases?')) return [{ tag_name: 'dsh-v0.2.2-rc.5' }, { tag_name: 'dsh-v0.2.2-rc.6' }];
    if (path.includes('/commits/')) return { sha: 'c'.repeat(40) };
    if (path.includes('/git/trees/')) return native;
    throw new Error('Unexpected endpoint: ' + path);
  };
  const plan = await makePlan({ api, repo: 'owner/repo', feedReader: async target => ({
    ...artifact(target), version: '0.2.2-rc.6',
  }), headReader: async () => ({ etag: 'same' }) });
  const old = plan.cases.filter(c => !c.control && c.version === previous.version);
  assert.equal(old.length, 2);
  assert.equal(old[0].artifact.sha512, previous.observations['mac-arm64'].artifact.sha512);
  assert.equal(old[0].commit, 'c'.repeat(40));
});
