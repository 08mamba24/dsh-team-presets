# Acceptance and release scope

## 0.6.0-rc.2 alpha.2 compatibility candidate

[PR #11](https://github.com/08mamba24/dsh-team-presets/pull/11) proposes exact macOS arm64 and Windows x64 Harness 0.2.3-alpha.2 support, retaining the separately tested rc.5 contract. The current published rc.1 TGZ is not an alpha.2 installation target. Final package digest, source/tree identity, independent verdict and platform receipts are recorded together in that candidate PR; a draft or offline test pass does not establish release approval.

Acceptance retains the admission, durable store, native addressing, complete replacement and multi-member scenarios. On alpha.2 it additionally verifies the real capacity envelope against the Host manager, inherited parent/child working directories, live route revocation and disabled policy despite old Session authorization events, and explicit refusal of a saved `working_directory` capability without editing the list. Native SettingsForms, AgentPresets, AgentLoop, tools, Team Board, Session persistence and official Web Standard are used; model output and approval answers are local fixtures.

The legacy file-bound one-child, pair and launcher entries also check the Host's live parent working directory. An unchanged Session header cannot authorize a different directory. Regression cases cover changes before invocation and during asynchronous tool or model preparation, with no child creation or Team writes after refusal. The current-session entry continues to bind the live directory and verify child inheritance.

The native delegation tool also awaits model metadata internally after the driver submits it. The one-child and pair entries recheck both parent and child live directories at `subagent/start`; mismatched or unreadable directories block the child, interrupt it and await its exact end before teardown. A child Session may already exist at that boundary; this guard prevents its model stream from reaching the provider. `scripts/probe-native-inner-workspace.mjs` uses the real Host tool/manager and changes the directory during that internal await. Its old-package control reaches a provider stream in the wrong directory; the repaired entries refuse with `CHILD_CONFIGURATION_CHANGED` and zero provider streams. Metadata and provider transport are local controls, and all profile data is isolated and removed.

Legacy rc.6 changed/unchanged defaults and rc.7 team migration create their original Settings/JSONL under the exact official rc.5 Host, shut that process down, then resume under alpha.2. Both operating systems execute their own official distributions. Each installed TGZ receipt must have `passed=true`, no errors, verified isolation cleanup and its exact `tgz-sha256:` source identity. GUI behavior, account entitlement and paid-provider collaboration are outside this candidate's no-account acceptance.

## 0.6.0-rc.1 multi-member candidate

[Published prerelease](https://github.com/08mamba24/dsh-team-presets/releases/tag/v0.6.0-rc.1) from merged commit `bf505197a2a4d95847fe17283dc0ed88e91ad6ad`. The release TGZ is byte-identical to the package installed by [post-merge Windows run45040445737](https://github.com/08mamba24/dsh-team-presets/actions/runs/45040445737): outer lifecycle 44/44 and multi-member 17/17. The same TGZ passed the independent macOS private augmented verifier 19/19, retaining all 17 shipped scenarios and adding two real inspect-to-replacement mapping checks. Source, package and receipt digests are in the release acceptance summary.

This candidate separates member identity from duty templates: six built-in templates and persisted custom templates can configure 1–8 independent members. A saved default does not rewrite an existing bound team. Runtime add is explicit; failed additions remain fenced, and removal requires resolving unfinished native or unclaimed seed-task responsibility. Role-less rc.7 fingerprints and the original two-member binding remain readable.

`scripts/accept-native-multi-role.mjs` uses the official Web bundle through `initProfile` and `runProfile`, real model-selection-policy events, AgentPresets, native tool execution, Settings and JSONL. Its 17 checks cover Agent configuration from the unchanged installed factory defaults to four members, a separate one-member launch, explicit seed responsibility changes, a custom template, native approval refusal and confirmation, live catalog saves without entry remount, different models and exact tool sets for same-template members, mid-run add and failure, arbitrary-name and added-member replacement, safe removal of original UUID members, and cold restoration. The migration phase starts an actual published rc.7 package, retains its Settings/JSONL and adds a member only after upgrade. Providers and approval answers are local fixtures; no account or remote inference is used.

The Windows installed-package workflow runs this script in addition to the existing admission, persistence, addressing, replacement and rc.6 migration controls. Consume the exact candidate PR's [Windows Actions](https://github.com/08mamba24/dsh-team-presets/actions/workflows/windows.yml) and its `native-multi-role.json`: `passed=true`, `errors=[]`, verified lab removal, and `sourceHead` matching the installed TGZ digest are required. The candidate packet also binds the local source commit, exported public commit, complete plugin tree and TGZ SHA256. Development receipts marked `integration-wip`, old release results and a green offline suite do not constitute acceptance of that package. Final receipt and review links belong to that exact candidate's PR record; a draft is not a release.

No new GUI, paid-provider or physical rc.2 multi-member acceptance is claimed. The sections below describe their own historical releases and retain their original limits.

## 0.5.0-rc.7 member replacement

This candidate adds the root-only `dsh_team_replace` tool and bundled `dsh-team-replace` skill for replacing an idle implementer or reviewer. The native profile entry owns a persistent per-root record with the original binding, candidate configuration, handoff digest, authenticated readiness, task-transfer outcomes and task-write proof. All roots share the entry revision; writes use native ConfigEditor CAS and readback. Volatile map updates persist without remounting the entry. Preserve the complete `replacementRecords` map during manual configuration edits.

On the physical macOS Harness rc.5 runtime, the integrated source passed 335 portable tests and 13 end-to-end native checks. The latter boot the official Web bundles and the candidate current-entry through native initProfile/runProfile, including the unchanged Web standard Preset. SettingsForms/ConfigEditor/Loader, AgentPresetRegistry, AgentLoop, SubagentRuntime, Team task tools and JSONL persistence all come from that profile. The child environment contains only temporary home/data paths and OS essentials; model output, an instrumented file-writing work tool and explicit failure injection are local fixtures. They cover a naturally cold old member, born-Standby refusal before a business tool body, real owner CAS and candidate task-write evidence, a failed activation recovered in the same candidate Session, partial multi-task transfer, dependency-preserving refusal of a blocked task, safe explicit cancellation before owner intent, and a fresh Loader/profile/JSONL reload retaining the original configuration after defaults change. An actual unmodified rc.6 package additionally creates the legacy team through native Commands; both unchanged-default automatic bootstrap and changed-default explicit adoption pass 14 checks each. The adoption path authenticates the original launch fingerprint and child headers. Cold-member acceptance includes a real completed old file-writing turn immediately before the frozen CAS: the operation remains frozen with no candidate or transfer. Separate physical probes passed admission 14/14, Preset/JSONL 5/5, storage 5/5 and role tools 16/16.

The end-to-end checks use the official standard Preset and native tool pipeline to verify stable role messages, agent lists and task-owner fields after the first replacement, the second replacement and cold reload. An additional physical probe covers shared-Preset lifetime, same-live-root plugin reinstall, conditional Team-tool reuse, Team-mode restrictions and approval-time revocation. Logical service views preserve native delivery and Board identity. Only exact task delegates minted by this module can carry their original activation predicate into role Presets; arbitrary conditional root-local tools remain excluded. This uses public scope composition and leaves the native manager and catalog unchanged.

These are isolated official-profile checks with scripted model output, not paid-provider or GUI acceptance. The earlier empty-standard service fixture missed a production control-definition conflict; the official-profile regression now exercises that same first-plan boundary before member work. The Windows workflow runs the packaged admission, storage and complete replacement scripts under the official Electron executable, in addition to the existing official CLI/Host install, upgrade, plan, settings, restart and removal checks. The exact Actions run and its receipts determine Windows status; this description is not a pass. Physical rc.2 replacement execution remains untested.

Standby readiness is separate from takeover. Pending task ownership is checked before candidate work; a verified native task write records takeover. Recovery rechecks cached transfer outcomes against the current board and accepts later legitimate candidate CAS revisions while preserving the transfer baseline. Before the first owner-write intent, explicit cancellation may return old execution only after candidate settlement and safe owners; afterward the old member stays retired. Missing managed records fail closed. Arbitrary detached effects, work already inside a tool body, distributed filesystem fencing and continuation token-budget changes remain outside this version.

## 0.5.0-rc.6 role tool configuration and skill upgrade

The configuration tool adds `action: tools` and per-role `native_tool_allowlist` edits. It reads shared registrations and unconditional standard-Preset work definitions visible to the invoking root, plus native control Preset capabilities, and preserves exact saved lists. Selected local definitions register in the role Preset, so children inherit them and the complete native allowlist and later child/Preset restrictions intersect. Conditional root-local registrations are excluded because their private activation callback cannot be copied through the public API. Unsaved defaults add available basic file/search/shell/skill tools. Native tool schemas, step activation, sandbox and approvals remain authoritative; the editor neither creates a capability nor grants delegation or root configuration tools to members.

Portable tests cover partial tool edits, unavailable/restricted tools, removal while approval is pending, no metadata calls for tool-only edits, exact role masks, temporary file read/write through the launcher lifecycle fixture, and downstream refusal without a tool body write. The native probe imports the physical ToolsService, NativeToolExecutor, Scope and SkillRegistry: it executes registered temporary-file handlers, checks Preset-mask intersection, root revocation after step admission and an isolated approval answer, final-guard denial, and replacement of a disposed old skill with the actual bundled new body. A second Context follows the Web standard-Preset layout and uses real native fs/search/shell modules, LocalFileSystem and LocalSubprocessRuntime to save role lists, expose exact role schemas and execute file and foreground shell bodies. Search schemas are checked without running ripgrep. The local probe backends do not confine; these isolated identities and handlers are not OS sandbox backend or paid provider acceptance. Roots and definition identities are rechecked before the first mutation and at execution; role guards remain with the child scope.

Windows Actions installs the frozen rc.5 baseline, observes its old skill, upgrades through the official CLI, and checks the new Host skill registration, persisted configuration and uninstall. Consult the exact run's `acceptance.json`; describing the checks is not a successful run. A loaded conversation's old skill message stays in history; subsequent skill loads after plugin reload use the new body. No existing daily profile, team, or paid model is migrated or rerun. Physical rc.2 execution of this new surface remains untested.

## 0.5.0-rc.5 conversational configuration

This version adds the profile-wide `dsh-team-configure` skill and the root-only `dsh_team_configure` tool. The tool inspects providers, lists a selected provider's models, previews partial role edits and saves through native approval and revision-checked persistent settings. It supports the two stable implementer/reviewer roles, including provider, model, effort, description, persona and startup input. It neither expands native session authorization nor launches or replaces members.

Isolated tool tests cover native approval delegation, exact route/effort validation, preserved template fields, concurrent settings edits, cancellation and uncertain writes without automatic retry. The Windows workflow adds actual Host skill discovery, a native settings RPC save, preservation of the current bound root, adoption by a fresh root, persistence after restart and skill removal on uninstall. Consult the exact commit's `acceptance.json`; a description of these checks is not itself a successful run.

The Windows checks use no model account or inference. They do not establish an LLM-driven skill conversation, real-provider metadata behavior, paid launch or arbitrary role counts. Defaults persist across restart; preservation of a bound root's template is limited to the current Host lifetime. Old-team cold restoration after changing defaults remains unaccepted.

## 0.5.0-rc.4 Windows release

This candidate adds Windows x64 Host loading for the reviewed 0.2.2-rc.5 archive and includes the rc.3 configuration change below. [Windows Actions](https://github.com/08mamba24/dsh-team-presets/actions/workflows/windows.yml) records each commit's offline tests and real official CLI/Host install, plan, persisted command history and removal checks. Consult that run's `acceptance.json`; source inspection alone is not a Windows pass. See [Windows scope and reproduction](WINDOWS.md).

The current-session entry is the Windows path. Historical POSIX file-bound entries remain macOS-only. Windows GUI interaction, paid launch and member collaboration are outside the automated no-account acceptance. No daily profile or existing team is migrated.

## 0.5.0-rc.3 configuration update

The source defaults both launcher roles to max and allows configured provider/model/effort ids, including the same model for both roles. Native Session policy and adapter resolution remain mandatory; unsupported controls stop before team/task mutation or child creation. The startup maxTokens1024 limit is unchanged. The legacy single-role and fixed M2 drivers retain their historical bounded configuration.

This update has no paid live execution or installed-profile change. The rc.2 evidence below is historical low-effort acceptance, not max-effort or arbitrary-provider live acceptance. Existing teams are not migrated by building this package.

## 0.5.0-rc.2 current-session entry

On 2026-11-19, independent source/package review accepted integration baseline `4a73cf95feed4c615993950473907dfda4d81b39` and the complete generic TGZ. The full offline suite passed 207/207. A later independent review accepted the original narrow live scope on macOS Harness 0.2.2-rc.5:

| Check | Accepted evidence |
| --- | --- |
| First launch | The invoking root created implementer and reviewer with native parent identity and scoped Presets; startup requests used account/Flash and account/Pro, low effort, maxTokens1024, and completed. |
| Small task | Implementer wrote and completed 17×23=391, directly messaged reviewer, and reviewer read the actual task and independently checked it with a different method. Both original tasks completed; the final prerequisite edge was preserved. |
| Duplicate launch | The next launch returned LAUNCHER_MEMBER_CONFLICT in 13ms. Across the root and original two child logs, the 30.441-second window before the next explicit user request contained no new member, member wake, or model step. Task, catalog, and Team projections were unchanged. |
| Additional interaction | Both original members later completed introductions in response to a separate user request within the same Host. This was not a duplicate-launch side effect or a cold-reload test. |

The reviewer checked the exact 11-file evidence manifest, three stable compressed session snapshots, installed package bytes, and source identity. It did not start Harness or rerun models. These receipts remain local; this document publishes the conclusions and scope, not personal session logs.

## Retained P2 orchestration deviation

The submitted brief asked Lead to assign the review task while its prerequisite was still pending. Native assignment returned TEAM_TASK_BLOCKED. Lead then removed the dependency, assigned the reviewer, and restored the edge rather than stopping. The edge was absent for 2.579 seconds.

This violates the brief's dependency-preservation and stop-on-error requirements. Strict instruction compliance is **false**. It did not block the narrow core verdict because the edge was restored 14.752 seconds before the implementer was actually woken, and reviewer execution began 1.666 seconds after the prerequisite completed and read its completion evidence. No out-of-order review occurred, and the final dependency was intact.

Future briefs should assign only the implementation task first. After completion and peer handoff, the reviewer should claim the now-executable review task while its blockedBy edge remains present. This wording correction has not had a new live execution; no paid rerun was used to erase the original deviation.

## Limits of the historical rc.2 acceptance

- The accepted current-session run used rc.5. The loader also supports the inspected rc.2 archive, but this is not a new rc.2 current-session live acceptance.
- Duplicate protection is conservative rejection, not proven equivalent-member reuse.
- Same-Host member continuation does not establish full cold recovery, automatic Lead wakeup, complex file/shell work, or every partial-failure recovery path.
- Startup maxTokens1024 is not a continuation or monetary cap. Observed later turns used maxTokens256000. Continuation budget propagation was explicitly excluded from this iteration.
- The first slash-command result's delayed UI display remains unresolved.
- Restore requires the original idle/unreplaced root and children, no queued root input, retained operation authority, and an entire task board unchanged since startup ended. Business-task writeback changes that snapshot, so this release cannot promise successful restore after task completion; refusal preserves the current mode and evidence.
- Provider/model request metadata establishes client routing, not server weight identity, lower-level HTTP retry count, total account debit, or global zero-request claims.
- Global model-choice preferences and each session's durable policy are separate. Keeping authorized Flash/Pro choices for continued use is supported; no preference restoration is claimed by the functional verdict.

## Frozen release artifact

`dsh-subagent-live-rc2-local-0.5.0-rc.2.tgz` contains 36 files, is 72659 bytes, and has SHA256:

```text
d36abb42f68c9c2a179aebf797233f94e0c44ad900ead86dbf5787a90708d3dc
```

The asset remains byte-identical to the source/package and runtime reviews. Repository documentation was updated afterward, so its README supersedes the package's submission-time README. Runtime source, manifest, and configuration remain at the accepted baseline. This artifact was originally published privately; the standalone repository and release assets are now public. It is not an npm or marketplace publication.

## Earlier stages

| Version | Historical scope |
| --- | --- |
| 0.1.2 | One native role, request/role controls, settlement and environment restoration on pinned rc.2. |
| 0.2.3 | Distinct configured Flash/Pro routes, native task/message collaboration and restoration on pinned rc.2. |
| 0.3.2 | Bound template launch, role readiness, safe repeated conflict, explicit mode restoration and normal uninstall on pinned rc.2. |
| 0.4.0-rc.1 | Offline binding preparation and the private distribution candidate; it added no new native runtime acceptance. |

These historical verdicts cover their exact artifacts and scopes; they do not expand the 0.5 verdict. Existing sessions, tasks, unrelated plugins, and raw evidence were preserved. Do not replay consumed acceptance runs to demonstrate an installation.
