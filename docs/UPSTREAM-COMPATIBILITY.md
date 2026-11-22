# Upstream Harness maintenance

The [upstream compatibility workflow](../.github/workflows/upstream-compat.yml)
checks the official release list and Desktop update feeds every 30 minutes at
minutes 17 and 47 UTC. GitHub schedules can be delayed, and public repositories
with 60 days of inactivity can have schedules disabled. Check Actions when an
expected run is missing. A manual dispatch provides the same entry point.

## What is observed

The workflow includes RCs and full releases since the reviewed Harness
`0.2.2-rc.5` baseline. It resolves each tag to its actual commit, compares complete
native source trees against frozen commit
`9c2670d3bce5275e0d1610272958121af87787bb`, and reads these official feeds:

- `https://download.deepseek.com/dsh-desk/feeds/mac-arm64/stable-mac.yml`
- `https://download.deepseek.com/dsh-desk/feeds/win-x64/stable.yml`

GitHub releases currently have no installer assets. The feeds identify the exact
Desktop version, installer URL and SHA512. Downloaded bytes must match that
SHA512; receipts also retain installer and app.asar SHA256. Feed hashes and HTTP
object validators detect repackaging. This does not establish that an object
whose feed and HTTP validators both remain unchanged has retained its bytes.

The plugin defaults to the highest published SemVer release with a TGZ and
GitHub SHA256 digest, including prereleases. Its release tag resolves to an exact
commit and its downloaded digest is verified. New tags, tag moves, installer
changes and plugin releases invalidate deduplication. Unchanged terminal results
do not rerun; infrastructure failures retry after six hours. Manual `force`
repeats immediately. Once a feed has attested an installer, the version Issue
retains its URL and SHA512. After the feed advances, the original bytes can still
be revalidated for tag moves and new plugin builds; HTTP object changes trigger
another probe. A historical installer that was never observed remains unavailable;
URLs are never guessed.

## Platform verification

Disposable Windows x64 and macOS arm64 runners download and extract the official
Host. The Mac job refuses an existing `/Applications/DeepSeek Harness.app` and
owns removal of the App it creates. All Host subprocesses receive a temporary
HOME/profile/Session store, no account credentials and no GitHub token. No GUI or
paid provider is started.

Every available archive is inspected for the public native API exports used by
the plugin. An unknown archive is `needs-review`: the monitor does not change
`REVIEWED_HOSTS`, broaden `engines.dsh`, or run business work around admission.
With an already reviewed archive, the native CLI installs the exact TGZ, and six
native suites cover role admission, settings persistence, logical addressing,
official Web profile replacement, and actual rc.6 teams with changed and
unchanged defaults. The CLI then removes the plugin. Cleanup failure prevents a
verified receipt. Known-runtime Windows lifecycle regression remains in the
existing Windows acceptance workflow.

Each changed observation also runs both original reviewed rc.5 distributions as
regression controls. These installers have frozen SHA256 values and still must
pass the plugin's existing app.asar admission before business tests run. The Mac
DMG was read-only mounted to confirm its archive matches the original reviewed
`6f0198…` bytes; the Windows installer is the existing `013e28…` acceptance input.
Controls have separate receipts and cannot replace the current feed observation.
Both controls must verify the same plugin build before a version Issue can close.
Every successful receipt binds the planned upstream commit, plugin commit and
TGZ digest, installer digests, native API contract, installed name/version and
the six uniquely named suite receipts. The publisher checks these identities
again against one expected build for both platforms. Missing or inconsistent
proof cannot close an Issue. Timeouts, crashes, CLI/runner errors and failed
cleanup remain infrastructure failures; only source-bound API or business
assertions establish an incompatibility.
Failed checks retain the suite/stage, source digest, receipt digest and explicit
assertions. The publisher revalidates those assertions, including infrastructure
error codes. Admission-pending results still need the complete API contract,
artifact identities and cleanup; an unpublished official artifact has a separate
pending result without implying execution.

## Results and ownership

The metadata-only reporting job has `issues: write`; the Host jobs have only
repository read permission and do not inherit a repository credential. The
workflow serializes reporters. It maintains one bot-owned Issue per Harness
version, including closed Issues. The body contains the latest platform facts
and a machine marker; comments remain available for human discussion. Changes
reopen the same Issue. Only two complete verified platform receipts, with no
unreviewed upstream source commit, close it. Candidates that pass remain pending
until non-author review and published-byte verification. Missing artifacts, corrupt receipts,
missing jobs, failed downloads and unavailable source observations cannot be
reported as compatible. Observation failures use a separate monitor-health Issue.
The report distinguishes `verified`, `needs-review`, `incompatible`, and
`infrastructure-error`. A rejected unknown archive is not an API failure.

Actions artifacts preserve platform receipts and bounded logs for 90 days. The
version Issue retains the version, source commit, plugin identity, installer and
archive digests and run links without expiry. Artifact expiry does not erase
those compatibility facts. For a release, archive the detailed evidence beside
the installable TGZ and checksum as in the rc.7 release process.

## Candidate and release loop

1. Inspect the version Issue's native-source changes and API/installer evidence.
   Fix bindings in an isolated candidate branch; keep existing supported Hosts
   covered. Do not treat an automated source comparison as semantic approval.
2. Dispatch **Upstream Harness compatibility** on `main`, set `tag` to the exact
   upstream tag, `plugin_ref` to the candidate's full 40-character commit in this
   repository, and `force` to true. Empty `plugin_ref` tests the published TGZ.
   The candidate is packaged with lifecycle scripts disabled. It is never merged
   or released by the monitor.
3. Obtain non-author review of API changes, the proposed support-matrix and
   manifest update, and the exact upstream commit added to
   `REVIEWED_SOURCE_COMMITS` in `.github/scripts/upstream-compat.mjs`.
   This source attestation records the reviewed tag identity; it does not grant
   runtime admission. Merge only after appropriate candidate checks. The monitor
   does not auto-approve an archive or widen a version range.
4. Validate merged main, publish a new plugin TGZ, SHA256 and sanitized acceptance
   summary, then download and verify the release. Update the existing
   `data/plugins/08mamba24__dsh-team-presets.yml` tarball in
   `awesome-dsh-plugin/awesome-dsh-plugin` through a contributor PR. Upstream
   maintainers own that PR's merge. Verify the public catalog after it merges;
   source directory, CDN catalog and the native Discover index can sync at
   different times.
5. Dispatch again with empty `plugin_ref` to test the published bytes. Record the
   review/release/catalog links in the version Issue. Its platform report updates
   without creating another Issue for the same Harness version.

Only the default-branch workflow publishes Issues. Pull requests run the monitor
unit tests; feature pushes exercise planning and platform jobs but upload report
previews. The schedule becomes active after the workflow is merged into main.
