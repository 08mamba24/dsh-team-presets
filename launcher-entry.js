import { parseLauncherConfig } from './src/launcher-config.js';
import { nativeTeamFromHost } from './src/team-host.js';
import { applyLauncher } from './src/launcher-driver.js';
import { bindHostContext } from './src/host-adapter.js';

export const name = 'native-team-launcher';
export const inject = { required: ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams', 'workingDirectory'], optional: ['subagentModelSelection'] };
export async function apply(ctx, raw) {
  const config = parseLauncherConfig(raw);
  if (!config) return applyLauncher(ctx, {}, undefined, undefined);
  const { nativeSubagent, controlEntry, adapter } = await nativeTeamFromHost();
  bindHostContext(ctx, adapter);
  return applyLauncher(ctx, config, nativeSubagent, controlEntry);
}
