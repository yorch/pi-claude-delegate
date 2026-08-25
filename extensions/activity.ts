import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityEvent } from './stream-parse.ts';

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Make a template/mode name safe for use in a filename. */
export function safeSegmentName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe.length > 0 ? safe : 'delegate';
}

export interface MetricsInput {
  numTurns: number;
  totalCostUsd: number;
  promptTokens: number;
  contextPercent: number | null;
  durationMs: number | null;
}

/** Compact run summary: `3 turn(s) · $0.54 · 62k tok · 6.2% ctx · 12s`. */
export function formatMetrics(m: MetricsInput): string {
  const parts: Array<string | null> = [
    `${m.numTurns} turn(s)`,
    `$${m.totalCostUsd.toFixed(3)}`,
    m.promptTokens > 0 ? `${Math.round(m.promptTokens / 1000)}k tok` : null,
    typeof m.contextPercent === 'number' ? `${m.contextPercent.toFixed(1)}% ctx` : null,
    typeof m.durationMs === 'number' && m.durationMs !== null ? `${(m.durationMs / 1000).toFixed(0)}s` : null,
  ];
  return parts.filter((p): p is string => Boolean(p)).join(' · ');
}

/** Parse the metadata header of a transcript file (without loading the whole body). */
export function parseTranscriptMeta(head: string): { mode: string; cost: number; sessionId: string | null } {
  let mode = 'delegate';
  let cost = 0;
  let sessionId: string | null = null;
  const mm = /^# Delegated Claude run — (.+)$/m.exec(head);
  if (mm) mode = mm[1];
  const cm = /\bcost: \$([\d.]+)/.exec(head);
  if (cm) cost = Number(cm[1]);
  const sm = /\bsession: ([0-9a-f-]+)/.exec(head);
  if (sm) sessionId = sm[1];
  return { mode, cost, sessionId };
}

/** Build the markdown report content injected into the session on the next turn. */
export function buildReportContent(opts: {
  mode: string;
  metrics: string;
  body: string;
  file?: string;
  sessionId?: string;
}): string {
  const header = `## claude ${opts.mode} (${opts.metrics})`;
  const foot: string[] = [];
  if (opts.file) foot.push(`transcript: ${opts.file}`);
  if (opts.sessionId) foot.push(`resume: \`/claude --resume=${opts.sessionId} <prompt>\``);
  return [header, '', opts.body, foot.length > 0 ? `\n_${foot.join(' · ')}_` : ''].join('\n');
}

/** Delete oldest transcript files beyond `maxCount` (0 = keep everything). */
export function pruneOutputs(dir: string, maxCount: number): void {
  if (maxCount <= 0) return;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const byMtime = files
    .filter(f => f.endsWith('.md'))
    .map(f => ({ f, mtime: statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of byMtime.slice(maxCount)) {
    try {
      rmSync(join(dir, f));
    } catch {
      // best-effort
    }
  }
}

/** Human-readable one-liner for a tool call (uses Claude's `description` when present). */
export function formatToolUse(name: string, input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description) {
    return `${name}: ${truncate(input.description, 90)}`;
  }
  if (typeof input.command === 'string') return `${name}: ${truncate(input.command.split('\n')[0], 90)}`;
  if (typeof input.file_path === 'string') return `${name}: ${input.file_path}`;
  if (typeof input.pattern === 'string') return `${name}: ${input.pattern}`;
  if (typeof input.url === 'string') return `${name}: ${input.url}`;
  const first = Object.values(input).find((v): v is string => typeof v === 'string' && v.length > 0);
  return first ? `${name}: ${truncate(first, 90)}` : name;
}

/** Compact per-line activity log for the transcript (tool_input + results only). */
export function collectActivityLog(events: ActivityEvent[]): string[] {
  const log: string[] = [];
  for (const ev of events) {
    if (ev.kind === 'tool_input') {
      log.push(`▶ ${formatToolUse(ev.name, ev.input)}`);
    } else if (ev.kind === 'tool_result') {
      const last = log.length - 1;
      if (last >= 0 && log[last].startsWith('▶')) {
        log[last] += ev.isError ? '  ✗ error' : '  ✓';
      }
    }
  }
  return log;
}

/** Full transcript written to the outputs dir: metadata + activity + output. */
export function buildTranscript(opts: {
  mode: string;
  permissionMode: string;
  model: string | null;
  cwd: string;
  sessionId: string | null;
  resumed: boolean;
  numTurns: number;
  totalCostUsd: number;
  isError: boolean;
  stopReason: string | null;
  durationMs: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  } | null;
  contextPercent: number | null;
  contextWindow: number | null;
  activityLog: string[];
  output: string;
}): string {
  const u = opts.usage;
  const tokens = u
    ? [
        `input ${u.inputTokens}`,
        `output ${u.outputTokens}`,
        `cache+${u.cacheCreationInputTokens}`,
        `cache ${u.cacheReadInputTokens}`,
      ].join(' · ')
    : null;
  const context =
    opts.contextPercent !== null && opts.contextWindow
      ? `${opts.contextPercent.toFixed(1)}% of ${opts.contextWindow.toLocaleString()} window`
      : null;
  const duration = opts.durationMs !== null ? `${(opts.durationMs / 1000).toFixed(1)}s` : null;

  return [
    `# Delegated Claude run — ${opts.mode}`,
    '',
    `- mode: ${opts.mode}`,
    `- permission: ${opts.permissionMode}`,
    `- model: ${opts.model ?? 'default'}`,
    `- cwd: ${opts.cwd}`,
    `- session: ${opts.sessionId ?? 'n/a'}${opts.resumed ? ' (resumed)' : ''}`,
    `- turns: ${opts.numTurns} · cost: $${opts.totalCostUsd.toFixed(4)} · isError: ${opts.isError}`,
    `- tokens: ${tokens ?? 'n/a'}`,
    `- context: ${context ?? 'n/a'}`,
    `- duration: ${duration ?? 'n/a'}`,
    `- stop reason: ${opts.stopReason ?? 'n/a'}`,
    '',
    '## Activity',
    opts.activityLog.length > 0 ? opts.activityLog.join('\n') : '(no tool activity)',
    '',
    '## Output',
    opts.output || '(empty)',
    '',
  ].join('\n');
}
