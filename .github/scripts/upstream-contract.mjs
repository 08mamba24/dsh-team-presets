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

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const errorRecord = value => record(value) && text(value.message)
  && (value.code === undefined || text(value.code)) && (value.name === undefined || text(value.name));
export const isFailureAssertion = value => errorRecord(value) && (text(value.code) || text(value.name));

function inspectReceipt(receipt) {
  const errors = receipt.errors === undefined ? [] : receipt.errors;
  const checks = receipt.checks === undefined ? [] : receipt.checks;
  if (!Array.isArray(errors) || !errors.every(errorRecord) || !Array.isArray(checks)) return;
  const diagnostics = [...errors], assertions = errors.filter(isFailureAssertion);
  for (const check of checks) {
    if (!record(check) || !text(check.name) || typeof check.passed !== 'boolean') return;
    if (check.passed) continue;
    if (check.errors !== undefined && !Array.isArray(check.errors)) return;
    const nested = [...(check.error === undefined ? [] : [check.error]), ...(check.errors ?? [])];
    if (!nested.length || !nested.every(errorRecord)) return;
    diagnostics.push(...nested);
    assertions.push(...nested.map(error => ({ ...error, name: error.name ?? check.name })));
  }
  return { diagnostics, assertions: assertions.map(error => ({ message: error.message.slice(0, 1000),
    ...(error.name ? { name: error.name.slice(0, 128) } : {}), ...(error.code ? { code: error.code.slice(0, 128) } : {}) })) };
}

export const failureAssertions = receipt => record(receipt) ? inspectReceipt(receipt)?.assertions : undefined;

// Exit codes and generic transport messages cannot establish a product failure.
export function classifyProbe(outcome, receipt, expectedSource) {
  if (!outcome || outcome.timedOut || outcome.signal || !Number.isInteger(outcome.code)
    || receipt?.sourceHead !== expectedSource || typeof receipt.passed !== 'boolean'
    || receipt.setupError !== undefined
    || receipt.isolatedDataRemoved === false || receipt.isolatedProfileRemoved === false) return 'infrastructure-error';
  const inspected = inspectReceipt(receipt);
  if (!inspected) return 'infrastructure-error';
  const io = /^(?:EACCES|EPERM|EBUSY|ENOSPC|EIO|ENOENT|ECONNRESET|ETIMEDOUT|ABORT_ERR)$/;
  if (inspected.diagnostics.some(error => io.test(error.code ?? '') || /cleanup|timed?\s*out/i.test(error.message))) return 'infrastructure-error';
  if (receipt.passed) return outcome.code === 0 && !inspected.diagnostics.length ? 'passed' : 'infrastructure-error';
  return inspected.assertions.length ? 'incompatible' : 'infrastructure-error';
}
