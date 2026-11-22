import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, selectReleases, sourceDelta, fingerprint, shouldProbe, normalizeResult,
  publishVersion, makePlan, BASELINE } from '../.github/scripts/upstream-compat.mjs';
import { isolatedEnvironment } from '../.github/scripts/accept-upstream-host.mjs';

const sha = 'a'.repeat(40), hash = 'b'.repeat(64);
const feed = `version: 0.2.2-rc.5\npath: >-\n  https://download.deepseek.com/dsh-desk/bin/mac-arm64/stable/deepseek-harness-0.2.2-rc.5-mac-arm64.zip\nsha512: >-\n  ${Buffer.alloc(64, 7).toString('base64')}\n`;
const observation = { version: '0.2.2-rc.5', tag: 'dsh-v0.2.2-rc.5', commit: sha,
  target: 'mac-arm64', artifact: { url: 'https://download.deepseek.com/dsh-desk/bin/mac-arm64/a.zip', sha512: 'digest', etag: 'v1' },
  plugin: { kind: 'release', commit: sha, sha256: hash }, source: { changed: [] } };

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
  assert.equal(normalizeResult(c, { fingerprint: c.fingerprint, target: c.target,
    version: c.version, status: 'needs-review', archiveSha256: hash }).status, 'needs-review');
  assert.equal(normalizeResult(c, undefined).status, 'infrastructure-error');
  assert.equal(normalizeResult(c, { ...c, status: 'verified' }).status, 'infrastructure-error');
  assert.equal(normalizeResult(c, { ...c, fingerprint: 'forged', status: 'verified',
    admission: 'reviewed', suites: [{ passed: true }] }).status, 'infrastructure-error');
  assert.equal(normalizeResult(c, { ...c, status: 'incompatible', stage: 'native',
    admission: 'reviewed' }).status, 'incompatible');
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
  const report = status => ({ version: observation.version, observations: {
    'mac-arm64': { fingerprint: 'x', status }, 'win-x64': { fingerprint: 'y', status },
  } });
  const first = await publishVersion(api, 'owner/repo', report('verified'), issues);
  assert.equal(first.state, 'closed');
  await publishVersion(api, 'owner/repo', report('verified'), issues);
  assert.equal(creates, 1);
  const changed = await publishVersion(api, 'owner/repo', report('needs-review'), issues);
  assert.equal(changed.number, first.number);
  assert.equal(changed.state, 'open');
  await assert.rejects(() => publishVersion(api, 'owner/repo', report('verified'),
    [{ title: '[upstream-compat] Harness ' + observation.version, user: { login: 'github-actions[bot]' }, body: 'corrupt' }]), /verifiable/);
});

test('a verified platform requires all six suites, CLI installation, reviewed admission and successful cleanup', () => {
  const c = { ...observation, fingerprint: fingerprint(observation) };
  const raw = { fingerprint: c.fingerprint, target: c.target, version: c.version, status: 'verified',
    archiveSha256: hash, admission: 'reviewed', isolatedDataRemoved: true, install: { passed: true },
    suites: Array.from({ length: 6 }, (_, n) => ({ name: String(n), passed: true, checks: 5 })) };
  assert.equal(normalizeResult(c, raw).status, 'verified');
  for (const invalid of [{ ...raw, isolatedDataRemoved: false }, { ...raw, admission: 'unreviewed' },
    { ...raw, suites: raw.suites.slice(1) }, { ...raw, install: { passed: false } }]) {
    assert.equal(normalizeResult(c, invalid).status, 'infrastructure-error');
  }
  assert.equal(normalizeResult({ ...c, source: { changed: ['native.ts'] } }, raw).status, 'needs-review');
});

test('Host environment inherits neither GitHub credentials, model keys nor operator startup options', () => {
  const env = isolatedEnvironment('/private/lab', '/official/resources', 'darwin', {
    HOME: '/operator', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'secret',
    NODE_OPTIONS: '--require /operator/preload.js', PATH: '/operator/bin',
  });
  assert.equal(env.HOME, '/private/lab/home');
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
  assert.equal(plan.cases.length, 2);
  assert.deepEqual(plan.cases.map(c => c.target), ['mac-arm64', 'win-x64']);
  assert.equal(plan.plugin.tag, 'v0.5.0-rc.7');
  assert.equal(plan.cases[0].source.changed.length, 0);
  assert.equal(plan.cases[0].admission, undefined);
});
