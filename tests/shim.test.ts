import assert from 'node:assert/strict';
import { test } from 'node:test';

test('shim re-exports pi-harness-delegate', async () => {
  const mod = await import('../extensions/index.ts');
  assert.ok(mod.default, 'shim should export default delegate');
  assert.equal(typeof mod.default, 'function');
});
