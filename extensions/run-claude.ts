/**
 * Claude Code headless runner. Uses `claude -p --output-format stream-json
 * --verbose` and parses the JSONL stream so text deltas and tool activity
 * surface live while the final `result` line carries output, usage and cost.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type ActivityEvent, parseStreamLines, type StreamedResult } from './stream-parse.ts';

export interface RunClaudeOptions {
  prompt: string;
  cwd: string;
  permissionMode: string;
  model?: string;
  maxBudgetUsd?: number;
  addDirs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Resume an existing delegated session headlessly. */
  resumeSessionId?: string;
  onStream?: (text: string) => void;
  onActivity?: (ev: ActivityEvent) => void;
}

export interface ClaudeResult extends StreamedResult {
  streamedText: string;
}

export const DEFAULT_TIMEOUT_MS = 600_000;

export function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--verbose', // required for stream-json
      '--include-partial-messages',
      '--permission-mode',
      opts.permissionMode,
    ];
    // resume needs the persisted session; otherwise keep runs clean
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    } else {
      args.push('--no-session-persistence');
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    }
    for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);

    const proc = spawn('claude', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let streamedText = '';
    let result: ClaudeResult | null = null;
    let stderr = '';
    let settled = false;

    const finish = (r: ClaudeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', line => {
      const parsed = parseStreamLines([line]);
      if (parsed.streamedText) {
        streamedText += parsed.streamedText;
        opts.onStream?.(parsed.streamedText);
      }
      for (const activity of parsed.activities) opts.onActivity?.(activity);
      if (parsed.result && !result) {
        result = { ...parsed.result, streamedText };
      }
    });

    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('close', code => {
      if (result) {
        finish(result);
      } else if (code !== 0) {
        fail(new Error(stderr.trim() || `claude exited with code ${code}`));
      } else {
        fail(new Error('claude finished without emitting a result'));
      }
    });
    proc.on('error', err => {
      fail(new Error(`failed to start claude: ${err.message}`));
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      fail(new Error(`claude timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    opts.signal?.addEventListener(
      'abort',
      () => {
        proc.kill('SIGKILL');
        fail(new Error('cancelled'));
      },
      { once: true },
    );
  });
}
