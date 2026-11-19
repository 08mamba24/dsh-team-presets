import { parseLauncherConfig } from './src/launcher-config.js';
import { nativeTeamFromHost } from './src/team-host.js';
import { applyLauncher } from './src/launcher-driver.js';

export const name = 'native-team-launcher';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams', 'workingDirectory'];
export async function apply(ctx, raw) {
  const config = parseLauncherConfig(raw);
  if (!config) return applyLauncher(ctx, {}, undefined, undefined);
  const { nativeSubagent, controlEntry } = await nativeTeamFromHost();
  return applyLauncher(ctx, config, nativeSubagent, controlEntry);
}
