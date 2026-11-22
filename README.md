# Native role presets and team launcher

Create a team of 1-8 named members in the current DeepSeek Harness root session — the bundled example ships an implementer and a reviewer — each with its own model route, persistent role prompt, and work tool list, optionally seeded from built-in or custom role templates.

**Current source: 0.6.0-rc.1** (candidate for independent review; not released — the last published package remains 0.5.0-rc.7). Installation provides the profile-wide `dsh-team-configure` skill: configure each role's provider, model, effort, prompts and tool list in an Agent conversation without editing YAML. Effort defaults to `max` and is validated by the configured native adapter. This update has no paid model execution; historical rc.2 macOS low-effort evidence does not establish arbitrary-model execution for this version. See [acceptance and limits](docs/ACCEPTANCE.md).

[中文安装与使用说明](README.zh-CN.md)

**Multi-role candidate.** Default teams now configure 1-8 independent members: edit an existing name, add a new member with explicit provider/model/effort, or remove one, all through the same inspect→preview→apply revision+fingerprint gate and native approval. Six built-in role templates (architect, implementer, reviewer, tester, researcher, designer) carry duty prompts and tool suggestions; custom templates persist with the default template and are replaced as a whole table under the same CAS. Future-default seed tasks follow the same whole-table rule through `seedTasks`: to remove a member who is still a seed owner, reassign or clear that ownership in the same saved change (omitted `owner` clears it, `seedTasks: []` means no seeds); without explicit adjustment the save is refused and no seed is silently deleted. Already-launched teams' real tasks are unaffected and stay on native task tools and replacement. A template ID is not a member identity — several members may share one template while keeping separate models, prompts and tool lists. Templates never contain provider/model and grant no authorization. Saved members and explicit tool lists stay exact; only a brand-new built-in-template member without a provided tool list receives suggestions intersected with the current root catalog, shown in preview. Role-less legacy templates keep their fingerprints byte-for-byte and rc.7 teams remain readable. The native scripted-provider acceptance covers installed factory configuration, one- and four-member launches, explicit membership changes and rc.7 migration. Match each candidate TGZ to its exact platform receipts in [acceptance and limits](docs/ACCEPTANCE.md); a draft PR is not a release.

Windows x64 support targets the reviewed Harness 0.2.2-rc.5 archive and the current-session `/dsh-team` entry. See [Windows installation and CI scope](docs/WINDOWS.md). The historical file-bound entries remain macOS-only.

## Install and launch

Build from this package directory:

```sh
npm pack
```

Install `dsh-subagent-live-rc2-local-0.6.0-rc.1.tgz` through the native plugin manager. Building does not update the installed copy. Installation registers the current-session command, configuration tool and skill for roots in that profile; no per-project skill copy, Session ID or offline binding step is needed. Existing bound installations need a migration that preserves their original component and role Presets; do not replace one blindly with the generic package. The old rc.2-only 0.5.0-rc.1 sidecar is not an installation target for Harness rc.5.

The [historical v0.5.0-rc.2 prerelease](https://github.com/08mamba24/dsh-team-presets/releases/tag/v0.5.0-rc.2) retains its frozen, live-tested low-effort bytes. It does not contain the max-default change. This candidate is supplied through its reviewed source and exact CI package artifacts.

## Configure the team in a conversation

Ask the Agent, for example:

```text
Use dsh-team-configure to show the models configured for codeagent.
Set implementer to my chosen model with max effort, and reviewer to another with high effort.
Add “read the implementation evidence before verifying independently” to the reviewer's persona.
Save these team defaults.
```

The Agent reads actual provider/model IDs, previews the requested changes through the native adapter, then saves through native approval and persistent settings. Supply your real model choices, without pasting profiles or credentials. A request for advice alone stops at preview.

Each member supports its own duties, model, effort, persona, startup input and tool list, and may be seeded from a built-in or custom role template (`action: roles` lists both; `customTemplates` saves custom ones). “Global” means defaults within the installed profile, and does not modify existing teams. Use an unbound root as directed by the result; changes to native model authorization require saving the selection and creating a new root. The skill does not grant authorization or start members. See [models and prompts](docs/MODELS-AND-PROMPTS.md).

## Configure tools by role

For example: “Use dsh-team-configure. Give implementer file read/write, search and terminal tools; give reviewer read, search and collaboration tools.” The Agent queries the actual tool catalog, previews each role's additions/removals, then saves through native approval.

Unsaved defaults include basic file, search, shell and skill tools that are registered in the Host and visible to the invoking root, including unconditional standard-Preset definitions. Shell names follow the actual catalog, such as `bash` or `pwsh`. Saved templates and explicit lists stay exact. Installed MCP tools may also be selected. A brand-new member seeded from a built-in template without a provided tool list receives the template's suggestions intersected with the current root catalog, and the preview shows the resolved list. Visibility grants no filesystem or shell permission: native sandbox, approval and step-time activation still apply. A role with shell access is not guaranteed read-only.

The skill ships and registers with the plugin. After upgrading and reloading the plugin, subsequent skill loads use the new bundled body; no separate global copy is needed. Previously injected conversation messages remain intact, so load the skill again for new instructions. Model/prompt configuration requires rc.5; tool-list editing requires rc.6.

Enable native Agent model selection and allow both default routes:

| Role | Client route | Default effort |
| --- | --- | --- |
| implementer | `deepseek-account/deepseek-flash` | `max` |
| reviewer | `deepseek-account/deepseek-v4-pro` | `max` |

Create a new root session after saving the selection. Existing sessions keep their durable policy; changing a global preference does not retroactively authorize them. The plugin checks that native policy and never grants model permissions. An official-provider Pro entry labelled as routing to Flash is not a substitute for account/Pro. Client route evidence does not establish backend model weights or billing. Keep the selected routes if you intend to continue using them; reverting temporary preferences is a separate settings operation.

In the target root, run:

```text
/dsh-team plan
```

Check each role's create/conflict decision. Read model routes from the configured template and the working directory from the native session; plan does not output those values or verify model authorization. Launch performs the native policy and route-resolution admission checks. Planning makes no model call and creates or wakes no member. The initial binding uses the native effective working directory; changing that directory afterward refuses launch until you return to the planned directory.

Then run:

```text
/dsh-team launch
```

Launch invokes the models and creates every member declared in the template (the bundled example declares two) and each confirms readiness. Seed tasks remain pending until you assign work. Each root receives its own scoped role Presets, so one installation serves multiple roots.

A repeated launch with existing names can return `LAUNCHER_MEMBER_CONFLICT`. The accepted test retained the original members/tasks and created no member, wake, or model step during that command's observation window. This is conservative duplicate rejection; equivalent-member reuse has not been accepted.

Command results may appear in expandable command records. The first result's delayed display remains unresolved. Inspect the command record/trace before submitting a greeting or another launch as a diagnostic.

## Assign work and preserve dependencies

New unsaved defaults include available basic work tools; saved templates can be adjusted through the skill. The historical rc.2 live test used task-board and messaging tools only. Assign the executable implementation task first. The implementer writes evidence, completes it, then sends the reviewer the actual task IDs. The reviewer reads the completed prerequisite, keeps the dependency edge, claims the now-unblocked review task, independently verifies it, and writes the result. A rejected tool operation should stop the flow and be reported.

The live test completed `17 × 23 = 391`, direct peer handoff, and independent verification by another method. It also exposed a P2 orchestration deviation: after a blocked assignment, Lead briefly cleared and restored a dependency instead of stopping. Core collaboration passed; strict instruction compliance did not. The clarified workflow above has not had a separate live rerun.

## Replace an idle member

Use the bundled `dsh-team-replace` skill in the existing team's root conversation. For example:

```text
Use dsh-team-replace to inspect my current team. Replace implementer with my
chosen provider/model, max effort, the following persona and work prompt,
and these exact tools. Keep the task IDs, dependencies and completed progress.
Handoff facts: changed files, verified tests, unresolved effects and next action.
```

The Agent calls `dsh_team_replace` with `action: inspect` and selects the target member's row from `inspect.roles`. For `action: replace`, set `role=row.role` and `expectedOldChildId=row.currentChildId`; if the row is absent or `currentChildId` is `null`, stop and verify the current state. Supply provider, model, effort, personaPrompt, prompt, the complete tools list and progressFacts. Omitted effort defaults to `max`; actual native model policy and adapter resolution must accept the route. This changes only the current team's selected logical role. Use `dsh-team-configure` to change defaults for future teams.

The old member and its descendants must be quiet: no turn, tool, queued input or managed background job. A task may remain `in_progress`. A naturally unloaded member can be checked from the native catalog, its closed turn and durable inbox. Blocked tasks are refused before freezing; their dependencies remain intact.

The replacement record freezes old execution before spawning a candidate. Born in enforced Standby, the candidate can read only handoff tasks and send Lead the exact operation/handoff/config readiness ACK. Lead transfers unfinished tasks through native revision CAS, then permits work. Completed tasks, dependencies, progress and both Session histories remain. `activating` means work is permitted but takeover is still unproven; `active` follows a verified successful task write in the candidate's own native call/result history, or an explicit `not-required` result when no unfinished task remains. Readiness alone never proves takeover.

After replacement, Lead and teammates keep using each member's stable name in messages and task owner fields. Native tool results show the current logical member across repeated replacements and reload. Retired names and Session IDs are refused. While a replacement is unfinished, the affected member is temporarily unavailable; inspect or recover its operation. To change the roster of the live team itself, use `action: add` with a complete member configuration (route fields explicit; `role` there only records the duty source and resolves no fields) or `action: remove` with a stable name from inspect. Removal is refused while the member still owns unfinished responsibilities, including seed tasks not yet taken over by another member; once those are completed or reassigned, removal is allowed.

On timeout or a partial/uncertain transfer, inspect and `recover` the same operationId. Recovery rechecks current owners and status, restores the same candidate and continues its Session without spawning a duplicate. Explicit `cancel` is available before the first owner-write intent, including an unspawned frozen plan; old execution returns only after candidate settlement and safe task ownership are confirmed. After owner intent, use recovery; the old member stays retired.

For a legacy team, unchanged defaults can bootstrap only when its retained native launch fingerprint and child headers authenticate the original binding. If defaults changed, `REPLACEMENT_ORIGINAL_TEMPLATE_REQUIRED` requires `dsh_team_replace action: adopt` with the complete original template. The tool verifies it before registering managed Presets. Keep the original evidence if it cannot be recovered.

The native profile retains each root's original binding, complete candidate configuration and lifecycle record across reload. Preserve `replacementRecords` when editing configuration manually. New defaults do not alter retained teams. Native sandbox, approval and tool restrictions still apply. Replacement cannot undo effects already inside a tool body or arbitrary detached processes, and does not change continuation `maxTokens` behavior. The new path targets the reviewed Harness rc.5 runtime; see [acceptance scope](docs/ACCEPTANCE.md).

## Configure, restore, and upgrade

Use the conversational skill above; older installations need the new package to gain the added capabilities. There is no dedicated model-picker form. [Manual Windows configuration](docs/MODELS-AND-PROMPTS.md#windows-manual-configuration) remains available, with file locations and a complete patch. Neither configuration path requires rebuilding the package.

Saving defaults keeps existing bindings. From rc.7, teams launched with a retained replacement record reload their original template and scoped Presets before continuation; unbound roots read new defaults. Historical teams without that record need their original component and Presets preserved. A repeated launch is not a migration command.

The optional component `template` takes a complete object in the format of [examples/team-template.json](examples/team-template.json). That file is a base example; without an explicit template the current-session entry adds available work tools from the Host catalog. Configure the roles' routes, persona prompts, startup prompts, and native tool allowlists there. A member may also carry an optional `role` recording a built-in or saved custom template as its duty source; raw template members must still be complete — `role` resolves only when `dsh_team_configure` adds a new member, filling unspecified non-route fields. Role-less legacy templates keep their existing fingerprints. `timeoutMs` and per-role `maxStreams` bound startup; the default is one ordinary stream per role, configurable from 1 to 12. Native policy and tool permissions remain authoritative. See [changing models and prompts](docs/MODELS-AND-PROMPTS.md) for the exact fields.

The bundled template defaults to `reasoning_effort: "max"`; each member may select an effort id supported by its configured native model. Any members may share the same provider/model. Native `resolveCallConfig` rejects unsupported efforts or route-resolution failures before team mutation; no silent downgrade is applied. Native metadata validation does not prove that a remote endpoint will execute a model successfully. Startup still uses `maxTokens=1024`, a separate request limit rather than a lifetime, total-token, or monetary cap. The historical rc.2 later task and introduction turns used native continuation configuration with `maxTokens=256000`; this update does not change continuation token budgets.

```text
/dsh-team restore
```

Restore can return Team mode to its pre-launch value only while the original operation retains restoration authority, the root has no queued input, the original root and members are idle and unreplaced, and the entire task board is unchanged from the end of startup. Ordinary task writeback changes revisions, status, or descriptions and can cause RESTORE_BOARD_CONFLICT; child changes can refuse even earlier. A completed business task therefore does not imply that restore will succeed. On refusal, retain the current Team mode and evidence and stop automatic compensation; do not clear tasks, rewrite dependencies, or replay work to force restoration. The command preserves members and tasks.

After plugin/Host reload, retained rc.7 bindings register their original and candidate Presets automatically before continuation. This is separate from `/dsh-team restore`: startup rollback authority remains in memory and is not reconstructed by `plan`. Legacy binding adoption follows the verified-template procedure above. Cold continuation and selected recovery failures are covered by isolated native checks; positive member reuse, automatic Lead wakeup and arbitrary partial failures remain unverified. Use the official manager for uninstall after operations and members settle.

The explicit bound `/dsh-team-launcher` export and offline preparation CLI remain available. See [legacy bound installation](docs/LEGACY-BOUND-INSTALL.md).

After each Harness update, run this read-only check from the source package:

```sh
npm run check:compat -- --upstream
```

It checks the physical App archive, package declaration, and official release feed. Unknown archives/RCs require review. This is an on-demand check, not background monitoring; it installs nothing and makes no model call. See [the host matrix](docs/HOST-COMPATIBILITY.md).

Source validation needs Node.js 22+ and npm, with no additional npm runtime dependencies:

```sh
npm test
```

Offline tests do not replace live Host acceptance. Publish generic source/packages only; keep bound packages, profiles, credentials, raw sessions, and workspace markers local. See [third-party notices](THIRD_PARTY_NOTICES.md). The historical `rc2-local` package name remains unchanged.
