import { nativeTeamFromHost } from './src/team-host.js';
import { applyCurrentLauncher } from './src/launcher-current.js';
import { nativeConfigurationFromHost } from './src/configure-host.js';
import { applyTeamConfigurator } from './src/team-configure.js';

const nativeConfiguration = await nativeConfigurationFromHost();
const { Schema } = nativeConfiguration;
export const Config = Schema.object({
  mode: Schema.string().default('current-session'),
  template: Schema.any().volatile(),
  timeoutMs: Schema.number().default(120000),
  maxStreams: Schema.object({ implementer: Schema.number().default(1), reviewer: Schema.number().default(1) })
    .default({ implementer: 1, reviewer: 1 }),
});

export const name = 'native-current-team';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams', 'workingDirectory', 'skills', 'settings', 'sandboxPolicy'];

export async function apply(ctx, raw) {
  const { nativeSubagent, controlEntry } = await nativeTeamFromHost();
  const readTemplate = () => raw.template?.get();
  const launcher = await applyCurrentLauncher(ctx, { ...raw, template: readTemplate() }, nativeSubagent, controlEntry, { readTemplate });
  await applyTeamConfigurator(ctx, launcher, nativeConfiguration);
}
