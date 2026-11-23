import { parseTeamConfig } from './src/team-config.js';
import { nativeTeamFromHost } from './src/team-host.js';
import { applyTeam } from './src/team-driver.js';
import { bindHostContext } from './src/host-adapter.js';

// A separate public entry keeps the accepted one-child command unchanged.
export const name = 'native-team-live-pair';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams', 'workingDirectory'];
export async function apply(ctx, config) {
  parseTeamConfig(config);
  const { nativeSubagent, controlEntry, adapter } = await nativeTeamFromHost();
  bindHostContext(ctx, adapter);
  return applyTeam(ctx, config, nativeSubagent, controlEntry);
}
