/** A false admission predicate is an explicit business assertion, not setup failure. */
export function nativeAdmissionCheck(name, passed, evidence = {}) {
  return { ...evidence, name, passed: Boolean(passed), ...(!passed ? { error: {
    code: 'NATIVE_ADMISSION_ASSERTION_FAILED', name, message: `Native admission condition failed: ${name}`,
  } } : {}) };
}
