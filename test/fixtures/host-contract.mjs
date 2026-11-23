import { bindHostContext, createHostAdapter } from '../../src/host-adapter.js';

const rc5 = createHostAdapter({ version: '0.2.2-rc.5' });

/** Internal drivers are tested behind the same explicit contract binding as native entries. */
export function bindRc5Fixture(ctx) {
  bindHostContext(ctx, rc5);
  return ctx;
}
