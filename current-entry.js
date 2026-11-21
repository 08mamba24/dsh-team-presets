import { nativeTeamFromHost } from './src/team-host.js';
import { applyCurrentLauncher } from './src/launcher-current.js';
import { nativeConfigurationFromHost } from './src/configure-host.js';
import { applyTeamConfigurator } from './src/team-configure.js';
import { ROOT_SESSION_ID } from './src/replacement-store.js';
import { applyTeamReplacement } from './src/team-replace.js';
import { installRootAddressing } from './src/team-addressing.js';

const nativeConfiguration = await nativeConfigurationFromHost();
const { Schema } = nativeConfiguration;
export const Config = Schema.object({
  mode: Schema.string().default('current-session'),
  template: Schema.any().volatile(),
  replacementRecords: Schema.dict(Schema.any(), Schema.string().pattern(ROOT_SESSION_ID)).default({}).volatile(),
  timeoutMs: Schema.number().default(120000),
  maxStreams: Schema.object({ implementer: Schema.number().default(1), reviewer: Schema.number().default(1) })
    .default({ implementer: 1, reviewer: 1 }),
});

export const name = 'native-current-team';
export const inject = ['commands', 'tools', 'agents', 'llm', 'subagents', 'agentPresets', 'sessionProjections', 'agentTeams', 'workingDirectory', 'skills', 'settings', 'sandboxPolicy', 'sessionQuery', 'sessions'];

export async function apply(ctx, raw) {
  const { nativeSubagent, controlEntry } = await nativeTeamFromHost();
  const readTemplate = () => raw.template?.get();
  const launcher = await applyCurrentLauncher(ctx, { mode: raw.mode, template: readTemplate(),
    timeoutMs: raw.timeoutMs, maxStreams: raw.maxStreams }, nativeSubagent, controlEntry,
  { readTemplate, readRecords: () => raw.replacementRecords.get(),
    prepareRoot: agent => installRootAddressing(ctx, agent) });
  await applyTeamConfigurator(ctx, launcher, nativeConfiguration);
  await applyTeamReplacement(ctx, launcher, nativeConfiguration);
}
