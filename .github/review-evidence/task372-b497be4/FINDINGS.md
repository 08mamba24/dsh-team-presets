# Task372: reviewer617 launcher parent-only workspace race

Runtime source: `b497be495dd57fcb4491d2bf0e81aade172206cb`. TGZ SHA256: `ace01850ae1341bb75135d0f42c6ffb13a73859080a29b05458937448143f60d` (70 files, 0.6.0-rc.2).

Independent review617 accepted the original four compatibility changes, capacityOf diagnosis, exact platform/package evidence and earlier F1-F3 and one/pair F4 repairs. The remaining P1 was launcher publication: the real Host captures the child directory before asynchronous preparation and creation. A live parent-only change can leave the child directory equal to config.workspace, allowing the old listener to pass before its later parent recheck.

The production delta imports the existing childWorkingDirectoryMatches helper and replaces the launcher's child-only comparison with that shared parent/child check. Both the bound and current-session entries use this listener. The existing block, interrupt and exact child/run/parent end drain remain the cleanup owner. No new store, policy source or lifecycle mechanism is added.

Two fixture counterexamples cover bound and current entry paths. They change only the parent after the native child directory snapshot and allow child execution before the tool reply returns. Both old-code cases reach one provider call and fail; both repaired cases refuse with CHILD_CONFIGURATION_CHANGED, zero calls and matching end identity. The unchanged child-directory refusal remains covered. Full final source unit tests: 466 passed, 0 skipped, 0 failed.

The portable native multi-role suite now includes the same current-session race. It delegates the real AgentManager.create with unchanged input after changing the real parent working directory, and delays only the real spawn tool's reply until the actual child end. This is explicit fault/scheduling injection at public service boundaries, not a Host source patch or fabricated lifecycle. RED-NATIVE-PARENT617-r2.json uses the previous 019c2342 TGZ on pinned alpha.2: one actual provider stream, unchanged captured child directory, changed parent directory, matching completed run. The repaired packed TGZ requires zero provider streams and a matching ended run on every platform. Child and parent quarantine denials are expected only within this refusal control; all other errors remain failures. The raw evidence preserves the injection stack and all identities.

The final Mac candidate reruns rc.5 eight suites and alpha.2 nine suites, including all prior one/pair workspace and live-policy controls. The multi-role suite increases by one case (rc.5 19, alpha.2 22). Windows runs that identical portable case inside each original seven-suite set plus its 44 lifecycle and 16 role-tool checks; final Windows raw artifacts must independently match this TGZ and final source tree.

The final Desktop IPC/session/shutdown and raw-I/O archive-integrity controls are also retained. Raw-I/O redirects an actual mutated file; it does not attest a tampered signed App launch. All profile data is isolated and removed, with scripted metadata/model transport and no account or paid-provider calls.

MANIFEST.json lists byte-identical raw copies and their SHA256. The later excluded evidence-only commit must preserve every payload file and the entire TGZ. Raw TAP whitespace is preserved as evidence. No merge, release, daily installation or update-channel change is included.
