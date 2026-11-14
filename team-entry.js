import { parseTeamConfig } from './src/team-config.js';
import { nativeTeamFromHost } from './src/team-host.js';
import { applyTeam } from './src/team-driver.js';

// A separate public entry keeps the accepted one-child command unchanged.
export const name = 'native-team-live-pair';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams'];
export async function apply(ctx, config) {
  parseTeamConfig(config);
  const { nativeSubagent, controlEntry } = await nativeTeamFromHost();
  return applyTeam(ctx, config, nativeSubagent, controlEntry);
}
