# Task372: F4 inner workspace race

Runtime source: `6073588732da168f58cdd2b466bd97f210b7f15d`. The TGZ SHA is in MANIFEST.json.

The pinned native delegation tool awaits `preflightChildLlmRoute` inside `tools.execute`, after the legacy driver prechecks. Its manager inherits the current parent directory only afterward. The one/pair `subagent/start` listeners now validate both live parent and child directories through one fail-closed helper. Mismatch or lookup failure blocks the child, interrupts it and waits for its exact end. Metadata/prepare calls may already occur; the enforced boundary is zero provider streams. The child Session may already exist and remains traceable.

Six old-code counterexamples fail and pass after repair: internal-preflight directory changes, a wrong child directory, and directory-service errors in both entries. Full local Mac tests: 461 passed, 0 skipped, 0 failed.

The physical probe is shipped as `scripts/probe-native-inner-workspace.mjs`. It runs the official Web profile, Standard preset, native tool/manager, actual model-selection Settings and working-directory owner. The fixture injects a directory change only when the real native tool calls the metadata resolver; the captured stack records that exact site. The old TGZ control enters one provider stream in the changed directory and fails. The repaired TGZ runs both entries on rc.5 and alpha.2: each child is interrupted and ended with zero provider streams. All profile data is removed. Models and metadata transport are local controls, with no account or paid-provider calls.

Mac rc.5 and alpha.2 each rerun the prior seven complete suites plus this eighth two-case probe. The extra legacy probe is Mac-only because those file-bound entries explicitly reject Windows. Windows retains its seven native suites and must be verified independently.

F1-F3 were already closed by the independent review of the prior source. Their code and the earlier six workspace counterexamples remain intact. The archive-integrity receipt uses real one-byte data at the raw-read boundary and does not claim a tampered signed App launch.

The raw JSON and logs are byte-identical copies with SHA256 hashes. A later evidence-only commit adds this excluded directory without changing any of the 70 TGZ files; package continuity must be checked.
