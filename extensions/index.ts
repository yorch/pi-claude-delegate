/**
 * pi-claude-delegate — deprecated shim.
 * Re-exports pi-harness-delegate's claude harness.
 * Install pi-harness-delegate instead: pi install npm:pi-harness-delegate
 */

// eslint-disable-next-line no-console
console.warn(
  '[pi-claude-delegate] deprecated — use pi-harness-delegate (pi install npm:pi-harness-delegate). See https://github.com/yorch/pi-harness-delegate#migration',
);

// Re-export the full harness delegate — existing claude_delegate tool and /claude command
// continue to work via the compatibility aliases in pi-harness-delegate.
// This keeps pi-claude-delegate as a thin wrapper so already-installed users are not broken.
import delegate from 'pi-harness-delegate/extensions/index.ts';

export default delegate;
