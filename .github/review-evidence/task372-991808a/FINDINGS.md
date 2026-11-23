# Task372: review 561 repairs

Runtime source: `991808aa268c3b42a949d3d405d4404fc642ccc0`.
Candidate TGZ SHA256: `1b2e35d751899590f337870d5a0b6bd0462004f91fa152e9b3d8f13e433f99e9`.

## F1: native module provenance

`nativeHostFromApp` now checks both resolved and canonical paths for runtime, CLI, native subagent and Cordis metadata/entries against the pinned archive before reading or importing them. Same-version packages outside that archive and an escaping canonical Cordis path are refused. Native subagent name/version and Cordis name/version are checked. The official alpha.2 archive contains Cordis `4.2.0-alpha.1`; its version is independent of the Harness version. The physical resolved-path receipt records both paths and versions.

The old fixture admitted temporary external module paths. The corrected fixture models archive-contained paths for positive cases, redirects only test module loading to owned temporary files, and explicitly tests external paths as failures. It never reads an installed App. The runtime has no path override or test bypass.

## F2: service replacement

Both logical service views check current identity before and after forwarded synchronous calls and when forwarded promises settle. Captured methods retain their native receiver but lose authority after service replacement. Custom `resolveName`, `listDescendants` and `namesOf` paths recheck too. The native-control bridge checks after `next()`, including `wait_agent` and missing-agent errors, and restores logical arguments in `finally`.

Regression cases cover `capacityOf`, `sendMessage`, `wait`, `resolveName` and `listDescendants`, including service replacement while promises are pending. The same forwarding mechanism protects generic AgentTeams methods. No fallback layers were added.

## F3: compatibility-check target

The read-only CLI requires `--app-executable` on every platform. It validates that executable's expected layout and inspects its neighboring archive; there is no default `/Applications` target. The relocated-archive test checks the actual CLI output. Both READMEs and the compatibility guide show explicit target selection.

## Validation scope

The original 16 selected checks produced 15 failures on the previous code; the relocated CLI case already passed. The repaired source passes these checks plus canonical-path, Cordis-version and deferred-service-race cases. Full local macOS regression: 455 tests, 455 passed, 0 skipped, 0 failed. The six workspace counterexamples from the previous repair remain included.

The attached Mac JSON files and unit log are copies of the original local receipts. The manifest records their SHA256 digests. This directory is excluded from the npm payload through the package's explicit `files` list. A later commit that only publishes these receipts does not change the tested TGZ; payload comparison must establish that continuity.

Acceptance uses isolated profiles and scripted providers. It does not establish GUI behavior, paid-provider collaboration or executable signature verification. The archive mutation receipt states its raw-I/O fault-injection boundary explicitly.
