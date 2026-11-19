import { nativeTeamFromHost } from './src/team-host.js';
import { applyCurrentLauncher } from './src/launcher-current.js';

export const name = 'native-current-team';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams', 'workingDirectory'];

export async function apply(ctx, raw) {
  const { nativeSubagent, controlEntry } = await nativeTeamFromHost();
  return applyCurrentLauncher(ctx, raw, nativeSubagent, controlEntry);
}
