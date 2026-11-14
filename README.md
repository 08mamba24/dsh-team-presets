# Native role presets and team launcher (rc.2)

[中文安装与使用说明](README.zh-CN.md)

Version 0.4.0-rc.1 is a distribution candidate adding an offline `dsh-team-prepare` command and an inert launcher as the generic bundle's default entry. It is not covered by the earlier 0.3.2 artifact verdict. The new setup validates an explicitly supplied existing Session/workspace and template, then prepares a local bound installation package without starting Harness, editing a profile or calling a model. See the Chinese setup guide for the installation sequence and current review status.

Version 0.1.2 passed its first real one-child run and restoration in independent acceptance764. Version 0.2.3 passed the real two-model native Team workflow and restoration in independent acceptance991. Launcher 0.3.2 passed independent code/config review1149 and bounded live acceptance1183, against production commit `3bc81fbc34f0522cf0d126e4c92732d1fba8375b`. The original default entry, `./team` and `./launcher` remain separate.

Launcher acceptance covered first creation of a Flash implementer and Pro reviewer with distinct client routes, persistent role prompts and role-specific native tools; both initial turns settled. Repeating launch reported a conflict without creating or waking another member. Explicit restore and official normal uninstall restored the prior environment. Positive reuse, another paid continuation turn, cold recovery, complex business work and all partial-failure recovery paths were not live-accepted. See [acceptance scope](docs/ACCEPTANCE.md) for the verdict and evidence boundary.

## Distribution and setup status (2026-11-15)

The user authorized creation of [08mamba24/dsh-team-presets](https://github.com/08mamba24/dsh-team-presets), a private staging repository. No production GitHub Release or plugin-catalog download has been issued. The package remains `private: true`; no npm publication is intended.

- The 0.4.0-rc.1 generic bundle registers the launcher with empty, inert configuration. Installing it does not bind a Session or create members. The original one-child and pair exports remain available; older generic bundles selected the one-child entry.
- The accepted bound TGZ targets one exact test Session and workspace. Its bindings cannot be reused as setup for another user's Session.
- Launcher setup requires the pinned macOS Harness 0.2.2-rc.2 App and archive checksum, an existing root whose native Session policy permits both model routes, an explicit launcher configuration, and owned mode0600 template and marker files. The plugin does not create those files or grant native model authorization.
- The new preparation path and package still need delta review and their own evidence before release. Any future runtime operation needs a fresh shared maintenance window. Only the generic package may be distributed; generated bound packages and their configuration remain local.

The archived 0.3.2 acceptance TGZ and receipts remain unchanged. This README now records the later verdict; repacking this working tree would produce a different artifact and would not inherit the archived TGZ's checksum or acceptance.

## Accepted launcher (0.3.2; bounded first version)

The exported `./launcher` entry registers `/dsh-team-launcher`. It loads a pinned, owned `.dsh-team-template.json` from the configured workspace. Each role has an explicit provider/model, a one-time startup `prompt`, a persistent `persona_prompt` kept as literal text, and its own `native_tool_allowlist`. The first version supports the two names `implementer` and `reviewer`, low effort and maxTokens1024. The available capability names are the four native Team/message tools already verified on the pinned App. File and shell tools are outside this template's current capability set.

| Command | Behavior |
| --- | --- |
| `plan` | Reads the native catalog and observable live fields; creates and wakes no member. |
| `launch` | Creates both roles only when the complete native catalog shows both names absent. Seeds optional native tasks and waits for the initial turns to settle. |
| `restore` | Restores the previous Team mode only with confirmed child settlement, no active replacement and an unchanged full raw board. Sessions and tasks remain. |

Existing members with unknown or changed configuration produce a conflict with their IDs and the unverified fields. The pinned public API cannot narrowly read a current persona section, so this launcher does **not** automatically reuse an existing member or resend its startup prompt. It reports a conflict with zero new members and zero extra wakes. A template fingerprint or matching Preset ID is not substituted for current persona evidence. Anonymous foreign members and valid foreign descendants remain untouched.

Role Presets use the original App's native control module and remain registered after startup, so native member continuation can use the role configuration while the plugin stays installed. Optional seed tasks may remain pending or in progress after startup; launching the team does not require finishing a business task. Startup task writes are limited to the new tasks assigned to that role, with native revisions and native approval retained.

The stream and task guards apply to the initial launch operation. They drain before removal; they do not quarantine the root for the plugin's lifetime. Later native continuation uses the configured role capabilities and native policy. Successful launch keeps Team mode enabled for that work. The explicit `restore` command checks its cleanup authority before restoring the prior mode; concurrent or uncertain state is reported without a compensating write. Timeout, cancellation and unload close new startup admission before interrupting only the exact new children, and retain the guard until their actual operations settle.

Cleanup compares the entire native Team projection, including deleted records, the next task number and metadata. Only confirmed writes by this operation advance its expected state. Startup messages require the exact peer to remain active before and after native approval. A later native message-body race is tracked and drained rather than treated as a successful startup. The pinned native manager disposes and unregisters a local Agent before publishing its final end event, so confirmed settlement can normally leave no live registry entry. That absence is cleanup evidence only; it proves no current persona or route. Startup hooks and their drain barrier share one native effect group so ordinary unload retains the hooks until drain completes.

Configuration binds an existing root/workspace, a template SHA256, timeout and per-role startup stream limits. The separate `.dsh-team-launcher.json` marker and template must already exist as owned regular files, mode0600; this module never creates them or edits native policy, daily model defaults or the Host allowlist. Template metadata grants no authorization or budget. All runtime installation and validation still require the actual delta review and a fresh shared maintenance window.

Both generic and bound `cordis.patch.yml` files must contain a top-level array of loader patch entries. The official installer validates this shape before activation; a composition-only check cannot replace that entry check. A rejected installation consumes that attempt and must be reconciled before any newly reviewed attempt.

## Accepted pair workflow (0.2.3)

The accepted pair entry used two role-specific AgentPresets and the original native subagent executor. Its one approved 0.2.3 invocation completed implementation/review tasks and a native peer handoff, then restored Team mode and the profile through official uninstall. It does not add a task store. The consumed validation scope must not be replayed. Earlier 0.2.1 and 0.2.2 failures, including their tasks and partial Session, remain in the receipts. `/dsh-team-live run-pair` is distinct from the one-child and launcher commands.

The planned client routes are `deepseek-account/deepseek-flash` and `deepseek-account/deepseek-v4-pro`, both listed by the authenticated native UI. The official-provider Pro entry is labelled as a Flash alias and is excluded. Native resolution and the new root's real durable policy must still accept both routes; a menu listing does not prove provider execution or server weights.

Tool-driven collaboration needs several model steps. The candidate therefore limits the implementer to six ordinary stream admissions and the reviewer to five, each with low effort and maxTokens1024. These are request/output ceilings, not a total-token or monetary cap. Auxiliary requests, causal mismatches, changed routes and unexpected tools are refused. No automatic retry is added.

The actual child tool set is limited to `team_task_get`, `team_task_update`, `send_message` and `wait_agent`. Child-scoped `tools/pre-execute` checks reserve a call once and continue through the remaining native policy. The public monotonic `tools.guard` checks its operation, board and task prerequisites again after native approval, before dispatch; it cannot grant permission or override native deny/ask. Native task CAS remains the write authority; this is not an atomic board lock across arbitrary middleware waits. No task store or messaging implementation replaces the native services. Task-list access, deletion and lead messages are refused.

Restoration independently compares confirmed task state, including after invalid model output. Concurrent board/mode/ownership changes and uncertain persistence stop further Team-mode writes and report the remaining state for reconciliation. Timeout, cancellation, unloading and terminal failure synchronously close both roles' future stream admission before attempting interruption. Existing requests and the exact child lifecycles still drain under retained guards; settled children and their tasks remain as evidence.

The native task-board read service requires Team mode to be enabled. Before enabling it, the driver copies the public raw Team projection's task state, excluding deleted records. It compares that baseline with normalized native task views after the enable flush, so a concurrent task change during the await is detected rather than adopted as the baseline. Raw projection state is never mutated.

The custom role Presets need the original App's native subagent-control module for messaging and waiting; they do not automatically inherit the standard Preset. The pair entry resolves that module's public export under the existing App archive and version checks, and declares it in each Preset with `interrupt:false`. Native Preset mounting settles the declared tree before the role restricts capabilities. The prepared request must still expose only the same four approved tools. No external dependency or Host setting is added.

Delegation failures retain the existing top-level error code and report which native batch checks failed, together with restricted native error identity and known safe classifications. Arbitrary error text, tool content, stack traces and prompts are omitted. The missing control definitions are a statically reproduced defect; the generic 0.2.2 receipt did not preserve its original startup exception, so it cannot establish that exception retrospectively.

The accepted M1 root is not reused for pair authorization. The only identified native preparation path is a temporary change to `subagent-model-selection-settings` through the native UI's revision-checked preference save, creation of a fresh test root in the existing Harness, readback of its real policy event, and immediate restoration of the previous Host preference. This is a separate proposed configuration delta, not permission inherited from M1 approval. Missing policy, concurrent edits, pending/restart-required states or unsettled children stop further changes. Daily model defaults remain unchanged. See `native-team-m2-candidate-755/CANDIDATE.json` under the acceptance-receipt root for the proposed configuration boundary.

## One-child entry

The default entry is the separate one-child driver. It does not change the existing zero-inference Team plugin or become a reusable team launcher merely because a pair entry exists.

The one-child execution candidate uses an `insert` entry and must bind an exact owned Session, canonical workspace, marker, runTag, member name, AgentPreset, persona nonce and route. Its only execution command is the recognized native descriptor `/dsh-subagent-live run-one`; do not submit an unknown/unconfigured command to test installation. No model call occurs at plugin load. The 0.4.0-rc.1 generic bundle selects the separate inert launcher export instead.

## Native path

The driver resolves public `@deepseek-ai/dsh-tool-subagent` package exports from the original App's packaged Host root, verifies its process path, rc.2 and the reviewed app.asar SHA256, and mounts that actual native tool module on **agent.ctx**, not the global profile context. The external profile does not have a base-bundle node_modules link; resolving through that assumed link would fail. This candidate deliberately targets the exact original App path. It imports public package exports, not private IPC or internal activation functions. No new runtime dependency is downloaded. It executes the tool through the native resolved tool set and executor, with explicit provider/model/effort and an allowlisted real AgentPreset. The tool retains its own native Session-policy preflight and managed subagent lifecycle.

The archive checksum reads the physical `app.asar` through Electron's built-in `original-fs`, after checking the Host process path. Public package metadata and module imports keep the normal ASAR-aware APIs. This follows [Electron's archive checksum guidance](https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file). The process-wide `noAsar` setting is not changed. Version 0.1.1 reached real installation but failed at activation before registering a command; it was removed through the official manager, restoring the four profile files and bundle order. Version 0.1.2 addresses that filesystem boundary and requires a new code/config review before activation.

The pinned rc.2 public `sessionProjections.stateOf(session, key)` reader is deprecated but still implemented. After awaiting the native tool mount (which registers its actual policy projection), the driver uses it to read the existing durable policy. It never appends a policy event, samples a global preference as Session authorization, or uses configured model defaults to evade explicit-selection checks. A missing/disallowed policy refuses before model metadata lookup or child creation.

The first candidate uses the already recorded `deepseek-account/deepseek-flash` route. The owned Session cache supports preparing that candidate; the handler must re-read the actual live Session projection. The candidate proposes **no allowlist or daily-default change**. A later distinct second model is outside this phase.

## Request and role controls

- A native `resolveCallConfig` preflight checks exact provider/model/low/maxTokens1024 before the delegation tool is invoked. Metadata resolution may perform I/O; it is not a successful inference receipt.
- The `subagent/start` publication supplies the exact child/run/root identity before its queued prompt begins. Only that child may enter one ordinary `llm/stream`, with the same four controls. Auxiliary, repeated, drifted and causally unattributed streams are rejected. Unrelated traffic keeps its original `next()`.
- The root is quarantined from model streaming for the plugin's configured lifetime, including idle periods. Do not use this owned test root for ordinary conversation while configured.
- The separately registered AgentPreset supplies the persona nonce through its scoped system-prompt section. The task prompt does not contain the nonce. Successful output must return that nonce, implementer identity and synthetic result 5.
- The role module uses `agent.ctx.tools.restrict({allow: []})`, then registers only a scope-local synthetic echo capability. Before the child runs, a serial native Agent-created hook resolves its actual tool set, executes the echo and asks the native executor to reject absent `bash`. The missing shell definition is checked before dispatch; no shell is executed.
- The driver consumes only the actual correlated `subagent/end`, validates output and usage, refuses a second execution attempt, and never automatically retries. Native sibling-name reservation remains authoritative across a module reload.

The measured limit is one ordinary **hook admission**, max1024 output tokens. It is not a total-token or monetary cap. Lower-level HTTP retries, backend request count, account debit and server model/weight identity remain UNVERIFIED. No routing inference is made from the model describing itself.

## Parent notification and teardown

The native tool hardcodes parent delivery. Its settlement notice would wake a parent model. The driver holds the exact idle root in the official `runMaintenance` boundary while the child runs. After the native end publication, it permits only the expected message with `source.kind=subagent-settled` and matching `senderSessionId`. It removes that single notification through the public durable inbox API before releasing maintenance. This records inbox cancellation; it does not delete the parent log or child Session. Any other pending message fails the run and is preserved. Root `whenIdle()` is awaited afterward.

This notification handling is an explicit review item. It is not silently advertised as a read-only root operation. The first phase performs no Team task writes, message handoffs between members, Session deletion, raw activation, model-default save or policy mutation.

On timeout/cancel, only the correlated child is interrupted with native ancestor authority. The command can report `*_DRAINING_GUARD_RETAINED` while the operation continues draining. Unload stops command admission, waits for the exact native operation/child and root quiescence, then removes hooks and retires the preset. An uncooperative child holds cleanup; never force-remove the plugin, restart, or keep retrying. The test child Session and marker remain as evidence. Resuming that child after removing its temporary preset is not accepted by this phase.

Ownership checks perform asynchronous filesystem I/O. The handler rechecks unload and cancellation afterward, then claims its operation without another await. An unloading plugin cannot admit a new operation when an earlier check resumes. Already claimed operations also check cancellation after tool-set resolution. The pinned native interrupt API returns `void`; synchronous interrupt errors are recorded in the error receipt and never skip waiting for the correlated child end and operation drain.

## Applying and restoring the candidate

The separately reviewed bound TGZ contains only this package and its one new entry. Install it once through the official manager as the actual live driver; do not reinstall the existing generic Team smoke. Preserve the four profile files and bundle order immediately beforehand and coordinate the shared Desktop maintenance window with the compression thread. Any pending/restart-required/unsettled result stops further mutation.

Before the single call, create the separate `.dsh-subagent-live.json` marker exclusively, mode0600, with exact `purpose=dsh-subagent-live-one`, ownedSessionId and runTag. A conflicting marker stops execution. This does not replace the existing zero-inference marker.

After success or a settled failure, restoration addresses only this new bundle through the official manager. Keep the existing generic package and other bundles unchanged; do not restore an old whole profile over concurrent changes. Preserve receipts. Do not test restoration by prompting a paid model. The native scoped tool is already removed at operation settlement; removing the new bundle subsequently retires its role declaration and lifetime root quarantine.

## Tests and limits

Run `npm test`. The admission/gate tests exercise refusal before lookup/activation, exact dispatch controls, the one-request allowance and unrelated routing. Driver tests run the actual driver and role modules against synthetic Host services: successful completion/output/usage, policy and control refusal, unrelated inbox preservation, unload during ownership validation, cancellation during tool resolution, and a non-settling child that prevents guard disposal even if interrupt throws. The bundle test reads an actual TGZ and uses the provenance-pinned rc.2 composition functions to check first insertion and preservation of existing entries. It packs the generic package by default; set `DSH_LIVE_CANDIDATE_TGZ` and `DSH_LIVE_EXPECTED_CONFIG` to test a bound artifact against its independent binding JSON. These tests do not establish Desktop/HMR, native-tool activation, native persona injection, real provider or billing acceptance. The separate bounded live verdicts above apply only to their exact artifacts and scopes; an offline test run does not extend them.
