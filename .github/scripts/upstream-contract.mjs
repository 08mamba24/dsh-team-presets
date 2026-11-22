export const CONTRACT_EXPORTS = {
  cordis: ['Context'],
  'dsh-scope': ['createScope', 'scopeOf', 'scopeParentOf'],
  'dsh-tools': ['ToolsService', 'defineTool'],
  'dsh-agent': ['AgentRegistry'],
  'dsh-agent-preset-registry': ['AgentPresetRegistry'],
  'dsh-agent-loop': ['AgentLoop'],
  'dsh-tool-executor-native': ['NativeToolExecutor'],
  'dsh-app-boot': ['initProfile'],
};
export const SUITE_NAMES = ['admission', 'store', 'addressing', 'replacement', 'legacy-changed', 'legacy-unchanged'];

// A process exit is transport evidence, not a product-contract verdict. Native
// scripts must provide a source-bound receipt before a failure is called
// incompatibility; timeouts, signals, missing data and cleanup failures remain
// infrastructure failures even when some test output was produced.
export function classifyProbe(outcome, receipt, expectedSource) {
  if (!outcome || outcome.timedOut || outcome.signal || !Number.isInteger(outcome.code)
    || receipt?.sourceHead !== expectedSource || typeof receipt.passed !== 'boolean'
    || receipt.errors !== undefined && !Array.isArray(receipt.errors)
    || receipt.checks !== undefined && !Array.isArray(receipt.checks)
    || receipt.isolatedDataRemoved === false || receipt.isolatedProfileRemoved === false) return 'infrastructure-error';
  const io = /^(?:EACCES|EPERM|EBUSY|ENOSPC|EIO|ENOENT|ECONNRESET|ETIMEDOUT|ABORT_ERR)$/;
  const errors = [...receipt.errors ?? [], ...receipt.checks?.flatMap(check => [check.error, ...Array.isArray(check.errors) ? check.errors : []]) ?? []].filter(Boolean);
  if (errors.some(error => io.test(error.code ?? '') || /cleanup|timed?\s*out/i.test(error.message ?? ''))) return 'infrastructure-error';
  if (receipt.passed === true) return outcome.code === 0 ? 'passed' : 'infrastructure-error';
  return receipt.errors?.length || receipt.checks?.some(check => check.passed === false) ? 'incompatible' : 'infrastructure-error';
}
