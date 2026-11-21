# Acceptance and release scope

## 0.5.0-rc.6 role tool configuration and skill upgrade

The configuration tool adds `action: tools` and per-role `native_tool_allowlist` edits. It reads shared registrations and unconditional standard-Preset work definitions visible to the invoking root, plus native control Preset capabilities, and preserves exact saved lists. Conditional root-local registrations are excluded because their private activation callback cannot be copied through the public API. Unsaved defaults add available basic file/search/shell/skill tools. Native tool schemas, step activation, sandbox and approvals remain authoritative; the editor neither creates a capability nor grants delegation or root configuration tools to members.

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

## Limits and unsupported conclusions

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
