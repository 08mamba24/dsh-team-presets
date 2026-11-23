# Harness compatibility

The official release feed is [deepseek-ai/deepseek-harness releases](https://github.com/deepseek-ai/deepseek-harness/releases). Harness tags use the `dsh-v` prefix, for example [dsh-v0.2.2-rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5). A similarly named tag without that prefix can return 404.

## Reviewed Host matrix

| Harness / OS | Archive SHA256 | Evidence boundary |
| --- | --- | --- |
| 0.2.2-rc.2 / macOS | `1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d` | Historical bounded launcher acceptance; the current-session entry has separate evidence. |
| 0.2.2-rc.5 / macOS | `6f019878f523428f452957dbaad601c6468051df4093eda8af751ec65226f88e` | Source/loader checks plus independently accepted current-session install, first launch, small-task handoff, and duplicate protection; see [acceptance](ACCEPTANCE.md). |

| 0.2.2-rc.5 / Windows x64 | `5ec8acd9e72b93b6680c953c1be44a729fd3a5170e472e8025690a1713d20f69` | Official NSIS payload statically inspected; 85 relevant source files match the official tag. Windows Actions verifies installation, Host plan, persistence and removal; see [Windows scope](WINDOWS.md). |
| 0.2.3-alpha.2 / macOS arm64 | `55961db6dafe1091408409e57da60832e8330230355eaf4f325f3aab9f8ffc8d` | Proposed in the 0.6.0-rc.2 candidate; consume exact package receipts and independent review in [PR #11](https://github.com/08mamba24/dsh-team-presets/pull/11). |
| 0.2.3-alpha.2 / Windows x64 | `dbd860998178fb23fe5802704fa1cf919f5b6957e4b3cc2c1b778efdb61297ab` | Separate official Windows installer/Host and candidate-package acceptance; Mac results do not establish Windows compatibility. |

## Alpha.2 contract

The candidate targets [dsh-v0.2.3-alpha.2](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96), without accepting future versions. It uses the pinned Cordis `Context.root` symbol, live `subagentModelSelection.allowedRoutes()`, the native `{running, limit, agents}` result, and parent workspace inheritance without a model-supplied `cwd`. rc.5 retains its root, Session policy and list-array contracts. Unknown results, unavailable live authorization and missing saved tools are refused; saved allowlists are never silently trimmed.

Mac resources are derived only from the running `.../DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`, with canonical executable/bundle/archive paths. The archive digest and native package versions must match one OS-specific row. This verifies the exact layout and pinned `app.asar`, not the executable's cryptographic signature. No environment variable, CLI argument or risk exemption can bypass runtime admission.

Canonical path equality deliberately rejects symlink or alias installations. The alpha.2 candidate retains the rc.2 identity mapping through unit regression; it has not repeated physical rc.2 acceptance. The current physical regression targets are rc.5 and alpha.2.

Migration acceptance creates old Settings/JSONL under the separately pinned official rc.5 Host, closes it, and resumes the same isolated data under alpha.2. Old published plugins are not forced to run under alpha.2. The rc.5 regression remains a separate control. No daily profile or update channel is changed.

Version 0.5.0-rc.1 declared only rc.2 and its runtime also pinned the rc.2 archive and native module versions. The rc.5 installer therefore rejected it before activation. Version 0.5.0-rc.2 declares the two inspected versions explicitly. The loader matches one archive to its own native subagent and control versions; a supported version from the other archive does not satisfy that check.

On 2026-11-19 the inspected rc.5 App's 85 TypeScript source files across the 11 relevant native packages matched the official rc.5 Git blobs. Those same paths were unchanged from the official rc.2 tag. The inspected packages were subagent, its delegation and control tools, working-directory, agent-team and its tools, agent, agent-preset and its registry, plugin-manager, and cordis-host-runner. This supports reusing the existing API contracts; it does not establish real plugin activation or model execution. The [official tag comparison](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.2...dsh-v0.2.2-rc.5) supplies context. Complete Git trees were used for the source comparison because GitHub's compare response caps its file list at 300 entries.

## Check before installation or after an update

1. On macOS run `npm run check:compat -- --upstream`. On Windows supply the installed executable: `npm run check:compat -- --app-executable "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --upstream`. Check the physical archive, the package's `engines.dsh`, and the official latest release. `upstream.status=unavailable` means the release lookup was not verified. Without `--upstream`, the check performs no network query.
2. For a new archive or RC, inspect the bundled native source and official tag differences, then verify the affected loader and native API contracts. Update the explicit host matrix and package declaration together. Keep unknown archives and mixed native versions rejected.
3. Repack from the final source, verify its actual manifest and payload, obtain independent review of the delta, and re-read the current profile before choosing the complete package or a migration. Supply only that reviewed artifact's frozen path and SHA. Perform the accepted live test separately.

This command is an on-demand read-only check. Existing sessions and role Presets must be preserved when preparing a migration. A package reviewed for a previous App cannot be handed out as the current installation target without a fresh check.

The separate [upstream maintenance workflow](UPSTREAM-COMPATIBILITY.md) observes official releases and update feeds every 30 minutes, runs isolated platform canaries when inputs change, and maintains one compatibility Issue per upstream version. Unknown archives remain pending review; automated observation never broadens product admission.
