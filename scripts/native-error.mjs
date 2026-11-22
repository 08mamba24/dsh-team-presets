export function describeNativeError(error) {
  const provenance = [], seen = new WeakSet();
  let incomplete = false, visited = 0;
  function visit(value, depth) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    if (depth > 8 || visited >= 64 || provenance.length >= 32) { incomplete = true; return; }
    seen.add(value); visited++;
    if (value !== error && typeof value.code === 'string' && value.code.trim()) {
      provenance.push({ code: value.code, message: String(value.message ?? value.code).slice(0, 1000) });
    }
    visit(value.actual, depth + 1); visit(value.cause, depth + 1);
    for (const list of [value.errors, value.provenance]) if (Array.isArray(list)) {
      if (list.length > 32) incomplete = true;
      for (const nested of list.slice(0, 32)) visit(nested, depth + 1);
    }
    if (value.provenanceIncomplete) incomplete = true;
  }
  visit(error, 0);
  return { code: error?.code ?? null, message: error?.message ?? String(error), stack: error?.stack,
    ...(typeof error?.name === 'string' ? { name: error.name } : {}),
    ...(provenance.length ? { provenance } : {}), ...(incomplete ? { provenanceIncomplete: true } : {}) };
}
