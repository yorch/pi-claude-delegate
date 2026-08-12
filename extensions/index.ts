/**
 * pi-claude-delegate — delegate work to Claude Code from the pi coding agent.
 *
 * Registers:
 *   - `claude_delegate` tool: the pi agent calls it when a task suits Claude
 *     (reviews, plans, implementation, audits, docs — or any custom template).
 *   - `/claude` command: manual delegation.
 *
 * Templates (modes) ship in ../templates; users add custom ones in
 *   ~/.pi/agent/claude-delegate/templates/  (global)
 *   .pi/claude-delegate/templates/          (project)
 *
 * Config (optional), in ~/.pi/agent/settings.json:
 *   { "claudeDelegate": { "model": "sonnet", "timeoutMs": 600000,
 *                          "defaultMode": "general", "allowDangerous": false } }
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	matchesKey,
	SelectList,
	Text,
	truncateToWidth,
	type Component,
	type OverlayHandle,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { runClaude, DEFAULT_TIMEOUT_MS, type ClaudeResult } from "./run-claude.ts";
import { parseClaudeCommand, resolveDefaults } from "./command.ts";
import { delegationHint, stripMarker } from "./hint.ts";
import { progressWindow, type FeedEntry } from "./progress.ts";
import { loadTemplates, type DelegateTemplate } from "./templates.ts";
import { mapClaudeUsage } from "./usage.ts";
import {
	buildReportContent,
	buildTranscript,
	collectActivityLog,
	formatMetrics,
	formatToolUse,
	parseTranscriptMeta,
	pruneOutputs,
	safeSegmentName,
} from "./activity.ts";
import type { ActivityEvent } from "./stream-parse.ts";

interface DelegateConfig {
	model?: string;
	timeoutMs: number;
	defaultMode: string;
	allowDangerous: boolean;
	/** Reveal Claude's thinking deltas in the live feed (default off). */
	inspectThinking: boolean;
	/** Global default spend cap in USD (overridable per call / per template). */
	maxBudgetUsd?: number;
	/** Hint on imperative review/plan/audit phrasing (explicit markers always work). */
	autoDelegateHints: boolean;
	/** Model aliases: template `model` values are resolved through this map. */
	modelAliases: Record<string, string>;
	/** Max overlapping delegated runs (0 = unlimited). */
	maxConcurrent: number;
	/** Max transcript files kept in the outputs dir (0 = no pruning). */
	maxTranscripts: number;
}

interface DelegateOptions {
	task: string;
	mode?: string;
	scope?: string;
	model?: string;
	maxBudgetUsd?: number;
	allowDangerous?: boolean;
	sessionId?: string;
	/** GitHub PR number/URL (scope "pr" or --pr=). */
	pr?: string;
	onStream?: (text: string) => void;
	onActivity?: (ev: ActivityEvent) => void;
	signal?: AbortSignal;
}

// concurrency guard: overlapping delegated runs (module-scoped so both the tool and /claude obey it)
let activeRuns = 0;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function loadConfig(): DelegateConfig {
	const cfg: DelegateConfig = {
		timeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMode: "general",
		allowDangerous: false,
		inspectThinking: false,
		autoDelegateHints: false,
		modelAliases: { economy: "haiku", balanced: "sonnet", max: "opus" },
		maxConcurrent: 1,
		maxTranscripts: 100,
	};
	try {
		const file = join(agentDir(), "settings.json");
		if (!existsSync(file)) return cfg;
		const settings = JSON.parse(readFileSync(file, "utf8")) as { claudeDelegate?: Partial<DelegateConfig> };
		const c = settings.claudeDelegate ?? {};
		if (typeof c.model === "string") cfg.model = c.model;
		if (typeof c.timeoutMs === "number" && c.timeoutMs > 0) cfg.timeoutMs = c.timeoutMs;
		if (typeof c.defaultMode === "string") cfg.defaultMode = c.defaultMode;
		if (typeof c.allowDangerous === "boolean") cfg.allowDangerous = c.allowDangerous;
		if (typeof c.inspectThinking === "boolean") cfg.inspectThinking = c.inspectThinking;
		if (typeof c.maxBudgetUsd === "number" && c.maxBudgetUsd > 0) cfg.maxBudgetUsd = c.maxBudgetUsd;
		if (typeof c.autoDelegateHints === "boolean") cfg.autoDelegateHints = c.autoDelegateHints;
		if (c.modelAliases && typeof c.modelAliases === "object") {
			for (const [k, v] of Object.entries(c.modelAliases)) {
				if (typeof v === "string" && v) cfg.modelAliases[k] = v;
			}
		}
		if (typeof c.maxConcurrent === "number" && c.maxConcurrent >= 0) cfg.maxConcurrent = c.maxConcurrent;
		if (typeof c.maxTranscripts === "number" && c.maxTranscripts >= 0) cfg.maxTranscripts = c.maxTranscripts;
	} catch {
		// invalid settings — fall back to defaults
	}
	return cfg;
}

/**
 * Call a close callback once it becomes available (the overlay may still be
 * mounting when the run finishes), with a hard cap so we never spin forever.
 */
async function closeWhenMounted(getClose: () => (() => void) | null, capMs: number): Promise<void> {
	const close = getClose();
	if (close) {
		close();
		return;
	}
	await new Promise<void>((resolve) => {
		const start = Date.now();
		const timer = setInterval(() => {
			const fn = getClose();
			if (fn || Date.now() - start > capMs) {
				clearInterval(timer);
				fn?.();
				resolve();
			}
		}, 20);
	});
}

function outputsDir(): string {
	return join(agentDir(), "claude-delegate", "outputs");
}

// ── Subcommand UIs (/claude list, /claude history) ──────────────────────────

function formatTemplateRow(t: DelegateTemplate): string {
	const parts = [t.name, `[${t.permissionMode}]`, t.model ? `model=${t.model}` : "", t.defaultTask ? "↳ default task" : ""];
	return `${parts.filter(Boolean).join("  ")}  —  ${t.description}`;
}

async function showModes(ctx: ExtensionContext): Promise<void> {
	const rows = [...loadTemplates(ctx.cwd).values()].map(formatTemplateRow);
	if (!ctx.hasUI) {
		process.stdout.write(`${rows.join("\n")}\n`);
		return;
	}
	await ctx.ui.custom((tui, theme, _kb, done) => {
		let offset = 0;
		const height = 12;
		return {
			render(width: number): string[] {
				const header = theme.fg("accent", "claude delegate — modes (↑↓ scroll · any key to close)");
				const visible = rows.slice(offset, offset + height);
				return [header, ...visible.map((l) => theme.fg("muted", truncateToWidth(l, width)))];
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.up) && offset > 0) {
					offset--;
					tui.requestRender();
				} else if (matchesKey(data, Key.down) && offset < rows.length - 1) {
					offset++;
					tui.requestRender();
				} else {
					done(undefined);
				}
			},
			invalidate() {
				// stateless render
			},
		};
	});
}

interface HistoryEntry {
	file: string;
	mode: string;
	cost: number;
	sessionId: string | null;
	mtime: number;
}

function readHistory(dir: string): HistoryEntry[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".md") && !f.includes("-partial"))
			.map((f) => {
				const file = join(dir, f);
				let mode = "delegate";
				let cost = 0;
				let sessionId: string | null = null;
				try {
					const meta = parseTranscriptMeta(readFileSync(file, "utf8").slice(0, 2000));
					mode = meta.mode;
					cost = meta.cost;
					sessionId = meta.sessionId;
				} catch {
					// unreadable — keep defaults
				}
				return { file, mode, cost, sessionId, mtime: statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0 };
			})
			.sort((a, b) => b.mtime - a.mtime);
	} catch {
		return [];
	}
}

async function viewTranscript(ctx: ExtensionContext, entry: HistoryEntry): Promise<void> {
	if (!ctx.hasUI) {
		process.stdout.write(readFileSync(entry.file, "utf8"));
		return;
	}
	await ctx.ui.custom((tui, theme, _kb, done) => {
		const lines = readFileSync(entry.file, "utf8").split("\n");
		let offset = 0;
		const height = 12;
		return {
			render(width: number): string[] {
				const resume = entry.sessionId ? ` · r resume` : "";
				const header = theme.fg("accent", `${basename(entry.file)} (↑↓ scroll${resume} · esc close)`);
				const visible = lines.slice(offset, offset + height);
				return [header, ...visible.map((l) => theme.fg("muted", truncateToWidth(l, width)))];
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.down) && offset < lines.length - 1) {
					offset++;
					tui.requestRender();
				} else if (matchesKey(data, Key.up) && offset > 0) {
					offset--;
					tui.requestRender();
				} else if (matchesKey(data, Key.escape)) {
					done(undefined);
				} else if (entry.sessionId && data === "r") {
					ctx.ui.notify?.(`resume with: /claude --resume=${entry.sessionId} <prompt>`, "info");
				}
			},
			invalidate() {
				// stateless render
			},
		};
	});
}

async function showHistory(ctx: ExtensionContext, dir: string): Promise<void> {
	const entries = readHistory(dir);
	if (entries.length === 0) {
		ctx.ui.notify?.("No transcripts yet — run /claude <mode> <prompt> first", "info");
		return;
	}
	if (!ctx.hasUI) {
		for (const e of entries) {
			process.stdout.write(`${e.mode} · $${e.cost.toFixed(3)} · ${e.sessionId ?? "-"}\n`);
		}
		return;
	}
	const entry = await ctx.ui.custom((tui, theme, _kb, done) => {
		const items: SelectItem[] = entries.map((e) => ({
			value: e.file,
			label: `${e.mode} · $${e.cost.toFixed(3)} · ${new Date(e.mtime).toISOString().slice(0, 16)}`,
			description: e.sessionId ? `session ${e.sessionId.slice(0, 8)}…` : undefined,
		}));
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (s: string) => theme.fg("accent", s),
			selectedText: (s: string) => theme.fg("accent", s),
			description: (s: string) => theme.fg("dim", s),
			scrollInfo: (s: string) => theme.fg("dim", s),
			noMatch: (s: string) => theme.fg("warning", s),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		return {
			render: (w: number) => list.render(w),
			invalidate: () => list.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (entry) {
		const chosen = entries.find((e) => e.file === entry);
		if (chosen) await viewTranscript(ctx, chosen);
	}
}

function saveOutput(mode: string, text: string): string {
	const dir = outputsDir();
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = join(dir, `${stamp}-${safeSegmentName(mode)}.md`);
	writeFileSync(file, text, "utf8");
	return file;
}

function buildPrompt(template: DelegateTemplate, task: string, scopeText: string | null, cwd: string): string {
	let prompt = [
		`You are being delegated a subtask by the pi coding agent.`,
		`Working directory: ${cwd}`,
		`Mode: ${template.name}`,
		``,
		template.prompt,
	].join("\n");

	prompt += `\n\n# Task\n${task}`;
	if (scopeText) prompt += `\n\n# Scope\n${scopeText}`;
	if (template.skill) prompt += `\n\nUse the "${template.skill}" skill.`;
	return prompt;
}

/** Shared engine for the tool and the /claude command. */
async function delegate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: DelegateOptions,
): Promise<{
	content: string;
	details: Record<string, unknown>;
	result: ClaudeResult;
	activityLog: string[];
}> {
	const config = loadConfig();
	const templates = loadTemplates(ctx.cwd);
	const mode = opts.mode || config.defaultMode;
	const template = templates.get(mode);
	if (!template) {
		throw new Error(
			`unknown claude_delegate mode "${mode}". Available: ${[...templates.keys()].sort().join(", ")}`,
		);
	}
	// fall back to the template's default task when none was given
	const task = opts.task || template.defaultTask;
	if (!task) throw new Error(`claude_delegate mode "${mode}" requires a task`);

	// concurrency guard: cap overlapping delegated runs (each costs money)
	if (config.maxConcurrent > 0 && activeRuns >= config.maxConcurrent) {
		throw new Error("another claude run is already in progress");
	}
	activeRuns++;
	const release = () => {
		activeRuns--;
	};

	// scope "diff" → compute the git diff ourselves; "pr" → the current PR's diff
	let scopeText: string | null = opts.scope ?? null;
	if (opts.scope === "diff") {
		const diff = await pi.exec("git", ["diff", "HEAD"], { cwd: ctx.cwd });
		scopeText = diff.stdout
			? `Current git diff (working tree vs HEAD):\n${diff.stdout}`
			: "No git diff vs HEAD (working tree clean).";
	} else if (opts.scope === "pr" || opts.pr) {
		const target = opts.pr ?? "";
		const pr = await pi.exec("gh", target ? ["pr", "diff", target] : ["pr", "diff"], { cwd: ctx.cwd });
		scopeText = pr.stdout
			? `Pull request diff (${target || "current branch"}):\n${pr.stdout}`
			: `Could not resolve the PR diff${pr.stderr ? ` — ${pr.stderr.trim().slice(0, 300)}` : ""}.`;
	}

	const permissionMode = opts.allowDangerous ? "bypassPermissions" : template.permissionMode;
	const resolveModel = (m?: string) => (m ? (config.modelAliases[m] ?? m) : undefined);
	const model = resolveModel(opts.model) ?? resolveModel(template.model) ?? resolveModel(config.model);
	const prompt = buildPrompt(template, task, scopeText, ctx.cwd);

	const activityEvents: ActivityEvent[] = [];
	let streamedFull = "";
	const activityLog: string[] = [];
	let result: ClaudeResult;
	try {
		result = await runClaude({
			prompt,
			cwd: ctx.cwd,
			permissionMode,
			model,
			maxBudgetUsd: opts.maxBudgetUsd ?? template.maxBudgetUsd ?? config.maxBudgetUsd,
			signal: opts.signal,
			timeoutMs: config.timeoutMs,
			resumeSessionId: opts.sessionId,
			onStream: (t) => {
				streamedFull += t;
				opts.onStream?.(t);
			},
			onActivity: (ev) => {
				activityEvents.push(ev);
				opts.onActivity?.(ev);
			},
		});
	} catch (err) {
		release();
		// preserve partial work on cancel/timeout/error
		if (streamedFull.length > 0) {
			try {
				saveOutput(
					`${mode}-partial`,
					buildTranscript({
						mode: `${mode} (partial)`,
						permissionMode,
						model: model ?? null,
						cwd: ctx.cwd,
						sessionId: null,
						resumed: Boolean(opts.sessionId),
						numTurns: 0,
						totalCostUsd: 0,
						isError: true,
						stopReason: null,
						durationMs: null,
						usage: null,
						contextPercent: null,
						contextWindow: null,
						activityLog: collectActivityLog(activityEvents),
						output: streamedFull,
					}),
				);
			} catch {
				// best-effort
			}
		}
		throw err;
	}
	release();

	if (result.isError && !result.result && !result.streamedText) {
		throw new Error("claude reported an error and produced no output");
	}

	// full transcript is always written — the record for post-hoc inspection
	const actualModel = result.model ?? model ?? null;
	const promptTokens =
		result.usage === null
			? null
			: result.usage.inputTokens + result.usage.cacheCreationInputTokens + result.usage.cacheReadInputTokens;
	const contextPercent = promptTokens !== null && result.contextWindow ? (promptTokens / result.contextWindow) * 100 : null;

	const file = saveOutput(
		mode,
		buildTranscript({
			mode,
			permissionMode,
			model: actualModel,
			cwd: ctx.cwd,
			sessionId: result.sessionId,
			resumed: Boolean(opts.sessionId),
			numTurns: result.numTurns,
			totalCostUsd: result.totalCostUsd,
			isError: result.isError,
			stopReason: result.stopReason,
			durationMs: result.durationMs,
			usage: result.usage,
			contextPercent,
			contextWindow: result.contextWindow,
			activityLog,
			output: result.result || result.streamedText,
		}),
	);
	// retention: keep the outputs dir bounded
	pruneOutputs(outputsDir(), config.maxTranscripts);

	return {
		content: result.result || result.streamedText || "(empty result)",
		details: {
			mode,
			permissionMode,
			model: actualModel,
			numTurns: result.numTurns,
			totalCostUsd: result.totalCostUsd,
			sessionId: result.sessionId,
			stopReason: result.stopReason,
			permissionDenials: result.permissionDenials,
			isError: result.isError,
			resumed: Boolean(opts.sessionId),
			file,
			// metrics
			durationMs: result.durationMs,
			ttftMs: result.ttftMs,
			contextWindow: result.contextWindow,
			contextPercent,
			promptTokens,
			usage: result.usage,
		},
		result,
		activityLog,
	};
}

function summarize(content: string, max = 30_000): { text: string; truncated: boolean } {
	if (content.length <= max) return { text: content, truncated: false };
	return { text: `${content.slice(0, max)}\n…[truncated — full output saved to file]`, truncated: true };
}

/**
 * Append the delegated report as a custom message in the session history so
 * the main pi agent sees it on its next turn (and it persists in the session
 * file). Non-fatal on failure.
 */
/**
 * Queue the delegated report for injection into the agent's NEXT turn via
 * `before_agent_start`. (Appending to the session manager alone does NOT reach
 * the live agent — its in-memory message list is only rebuilt from the session
 * on compaction/tree ops. The hook path feeds the report through the agent's
 * own pipeline: it reaches the LLM and is persisted as a custom message.)
 */
interface PendingReport {
	content: string;
	details: Record<string, unknown>;
}

let pendingReport: PendingReport | null = null;

function injectReport(
	_ctx: ExtensionContext,
	opts: { mode: string; metrics: string; body: string; file?: string; sessionId?: string },
): void {
	pendingReport = {
		content: buildReportContent(opts),
		details: { mode: opts.mode, file: opts.file, sessionId: opts.sessionId, metrics: opts.metrics },
	};
}

export default function (pi: ExtensionAPI) {
	// state for the progress window: allow minimizing + re-showing while a run streams
	let activeRunId = 0;
	let activeOverlay: { show(): void; focus(): void; runId: number } | null = null;

	// ── Tool ─────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "claude_delegate",
		label: "Claude Delegate",
		description:
			"Delegate a task to Claude Code running headless in the repo and return its streamed report (cost, token usage, context %, session id). " +
			"`mode` selects a template: review, plan, implement, security-audit, docs, general, or a custom template name — it determines permissions (review/plan/security-audit are read-only; implement/docs/general auto-accept file edits). " +
			"`scope` restricts the work: \"diff\" for the current git diff, a path list, or omit for the whole repo. `sessionId` continues an earlier delegated session.",
		promptSnippet: "Delegate a subtask to Claude Code and return its report",
		promptGuidelines: [
			"claude_delegate runs Claude Code headless in the working directory and returns a streamed report with cost, token usage, and a session id for follow-ups.",
			"Pass a focused task string with intent and constraints. Use scope: \"diff\" for the current git diff, a path list to restrict, or omit for the whole repo.",
			"mode selects the template and its permission level: review/plan/security-audit are read-only; implement/docs/general auto-accept file edits. Custom template names also work.",
			"sessionId resumes a previous delegated session instead of starting fresh.",
			"Do not set allowDangerous unless the user explicitly asks for unrestricted access.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The task/intent to delegate. Be specific." }),
			mode: Type.Optional(
				Type.String({
					description:
						'Template/mode to run: review, plan, implement, security-audit, docs, general, or a custom template name. Defaults to config "defaultMode".',
				}),
			),
			scope: Type.Optional(
				Type.String({
					description:
						'Restrict the work: "diff" (current git diff), a comma/space-separated path list, or omit for the whole repo.',
				}),
			),
			model: Type.Optional(Type.String({ description: "Claude model (e.g. sonnet, opus). Defaults to template/config." })),
			maxBudgetUsd: Type.Optional(Type.Number({ description: "Hard spend cap in USD for the run." })),
			sessionId: Type.Optional(
				Type.String({
					description:
						"Resume an existing delegated Claude session (pass its session id from a previous run's details).",
				}),
			),
			allowDangerous: Type.Optional(
				Type.Boolean({
					description:
						"Escalate to bypassPermissions (all tools, no prompts). Only with explicit user approval.",
				}),
			),
		}),

		async execute(_toolCallId, params: {
			task: string;
			mode?: string;
			scope?: string;
			model?: string;
			maxBudgetUsd?: number;
			allowDangerous?: boolean;
			sessionId?: string;
		}, signal: AbortSignal | undefined, onUpdate, ctx: ExtensionContext) {
			const config = loadConfig();

			// live inspection feed: recent tool calls + thinking indicator + text tail
			const feed: string[] = [];
			let liveTail = "";
			let thinkingChars = 0;
			let lastPushAt = 0;
			const THROTTLE_MS = 250;

			const pushFeed = () => {
				const now = Date.now();
				if (now - lastPushAt < THROTTLE_MS) return;
				lastPushAt = now;
				const lines: string[] = [...feed.slice(-6)];
				if (thinkingChars > 0) {
					lines.push(config.inspectThinking ? `💭 thinking… (${thinkingChars} chars)` : "💭 thinking…");
				}
				if (liveTail) lines.push(`✍ ${liveTail}`);
				if (lines.length === 0) return;
				onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: { progress: 0.5 } });
			};

			const { content, details, result } = await delegate(pi, ctx, {
				task: params.task,
				mode: params.mode,
				scope: params.scope,
				model: params.model,
				maxBudgetUsd: params.maxBudgetUsd,
				allowDangerous: params.allowDangerous ?? config.allowDangerous,
				sessionId: params.sessionId,
				signal,
				onStream: (text) => {
					liveTail = (liveTail + text).slice(-400);
					pushFeed();
				},
				onActivity: (ev) => {
					if (ev.kind === "tool_input") {
						feed.push(`▶ ${formatToolUse(ev.name, ev.input)}`);
						if (feed.length > 40) feed.splice(0, feed.length - 40);
					} else if (ev.kind === "tool_result") {
						const last = feed.length - 1;
						if (last >= 0 && feed[last].startsWith("▶")) feed[last] += ev.isError ? " ✗" : " ✓";
					} else if (ev.kind === "thinking") {
						thinkingChars += ev.chars;
					}
					pushFeed();
				},
			});

			const summary = summarize(content);
			const resumed = details.resumed ? " · resumed" : "";
			const head = result.isError
				? "⚠ claude reported an error"
				: `claude ${details.mode} (${result.numTurns} turn(s), $${result.totalCostUsd.toFixed(3)})${resumed}`;
			const body = result.isError ? `\n${summary.text}` : `\n\n${summary.text}`;
			const footer =
				summary.truncated
					? `\nFull output: ${details.file}`
					: `\nTranscript: ${details.file}`;

			// markdown body for the custom renderer (what the LLM sees in `content` stays as-is)
			details.markdown = summary.text;

			return {
				content: [{ type: "text", text: `${head}${body}${footer}` }],
				details,
				usage: result.usage ? mapClaudeUsage({ ...result.usage, totalCostUsd: result.totalCostUsd }) : undefined,
			};
		},

		// ── Custom rendering ──────────────────────────────────────────────────
		renderCall(args, theme) {
			const params = args as { mode?: string; task?: string };
			const mode = params.mode ?? "general";
			const task = params.task ?? "";
			const taskStr = task ? ` — ${task.length > 60 ? `${task.slice(0, 59)}…` : task}` : "";
			return new Text(theme.fg("accent", `claude ${mode}`) + theme.fg("dim", taskStr), 1, 1, (s) =>
				theme.bg("toolPendingBg", s),
			);
		},

		renderResult(result, options, theme): Component {
			// while streaming, show the raw live feed (tool activity + text tail)
			if (options.isPartial) {
				const text = (result.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return new Text(text, 1, 1, (s) => theme.bg("toolPendingBg", s));
			}

			const details = (result.details ?? {}) as Record<string, unknown>;
			const mode = typeof details.mode === "string" ? details.mode : "delegate";
			const cost = typeof details.totalCostUsd === "number" ? details.totalCostUsd : 0;
			const turns = typeof details.numTurns === "number" ? details.numTurns : 0;
			const isError = details.isError === true;
			const resumed = details.resumed === true;
			const file = typeof details.file === "string" ? details.file : null;
			const sessionId = typeof details.sessionId === "string" ? details.sessionId : null;

			const container = new Container();
			container.addChild(
				new Text(
					theme.fg(isError ? "error" : "accent", `claude ${mode}`) +
						theme.fg("dim", ` · ${turns} turn(s) · `) +
						theme.fg("warning", `$${cost.toFixed(3)}`) +
						(resumed ? theme.fg("dim", " · resumed") : ""),
					1,
					1,
				),
			);

			const md = typeof details.markdown === "string" && details.markdown ? details.markdown : null;
			if (md) {
				container.addChild(new Markdown(md, 1, 1, getMarkdownTheme()));
			} else {
				const text = (result.content ?? [])
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				container.addChild(new Text(text, 1, 1));
			}

			const foot: string[] = [];
			if (file) foot.push(`Transcript: ${file}`);
			if (sessionId) foot.push(`Resume: /claude --resume=${sessionId} <prompt>`);
			if (foot.length > 0) container.addChild(new Text(theme.fg("dim", foot.join("   ")), 1, 1));

			return container;
		},
	});

	// ── Command ──────────────────────────────────────────────────────────────
	pi.registerCommand("claude", {
			description:
				"Delegate a task to Claude Code. Usage: /claude [--mode=review|plan|implement|security-audit|docs|general] [--model=sonnet] [--scope=diff|paths] [--resume=<session-id>] <prompt> — or use a mode name as the first word: /claude review <prompt>",
		handler: async (args, ctx) => {
			// subcommands
			const sub = args.trim();
			if (sub === "watch" || sub === "show") {
				if (activeOverlay) {
					activeOverlay.show();
					activeOverlay.focus();
				} else {
					ctx.ui.notify?.("No active claude run to show — start one with /claude <mode> <prompt>", "info");
				}
				return;
			}
			if (sub === "list") {
				await showModes(ctx);
				return;
			}
			if (sub === "history" || sub === "logs") {
				await showHistory(ctx, outputsDir());
				return;
			}

			const templates = loadTemplates(ctx.cwd);
			const parsed = parseClaudeCommand(args, new Set(templates.keys()));
			const resolved = resolveDefaults(parsed, templates);
			const template = parsed.mode ? templates.get(parsed.mode) : undefined;
			const dangerous =
				parsed.mode === "general"
					? false
					: (template?.permissionMode ?? "acceptEdits") === "bypassPermissions";

			if (!resolved) {
				if (parsed.mode) {
					ctx.ui.notify?.(`/claude ${parsed.mode} <what to do> — give a prompt for the "${parsed.mode}" mode`, "warning");
				} else {
					ctx.ui.notify?.("Usage: /claude [--mode=…] [--model=…] [--scope=…] <prompt>", "warning");
				}
				return;
			}
			const { mode } = parsed;

			// shared live state for the footer chip and the progress window
			const feed: FeedEntry[] = [];
			let thinkingChars = 0;
			let liveTail = "";
			let requestRender: (() => void) | null = null;
			const getEntries = (): FeedEntry[] => {
				const entries = [...feed.slice(-12)];
				if (thinkingChars > 0) entries.push({ kind: "thinking", text: "💭 thinking…" });
				if (liveTail) entries.push({ kind: "text", text: liveTail.slice(-200) });
				return entries;
			};

			let chipActivity = "";
			let chipLastPush = 0;
			const pushChip = () => {
				if (!ctx.hasUI) return;
				const now = Date.now();
				if (now - chipLastPush < 500) return;
				chipLastPush = now;
				const theme = ctx.ui.theme;
				const activity = chipActivity ? ` ${chipActivity}` : theme.fg("dim", " running…");
				ctx.ui.setStatus("claude-delegate", theme.fg("accent", "●") + theme.fg("dim", ` claude ${mode ?? "general"}`) + activity);
			};

			const onActivity = (ev: ActivityEvent) => {
				if (ev.kind === "tool_input") {
					chipActivity = `▶ ${formatToolUse(ev.name, ev.input)}`;
					feed.push({ kind: "tool", text: formatToolUse(ev.name, ev.input) });
					if (feed.length > 40) feed.splice(0, feed.length - 40);
				} else if (ev.kind === "tool_result") {
					if (chipActivity.startsWith("▶")) chipActivity += ev.isError ? " ✗" : " ✓";
					const last = feed.length - 1;
					if (last >= 0 && feed[last].kind === "tool") feed[last] = { ...feed[last], ok: ev.isError ? false : true };
				} else if (ev.kind === "thinking") {
					chipActivity = "💭 thinking…";
					thinkingChars += ev.chars;
				}
				pushChip();
				requestRender?.();
			};

			const ac = new AbortController();
			let cancelled = false;
			const runState: { error: Error | null } = { error: null };
			const runId = ++activeRunId;
			const clearActive = () => {
				if (activeOverlay?.runId === runId) activeOverlay = null;
			};

			// start the run now (not awaited) so the window can render while it streams
			const run = delegate(pi, ctx, {
				task: resolved.task,
				mode: parsed.mode,
				scope: resolved.scope,
				model: parsed.model,
				maxBudgetUsd: parsed.budget,
				sessionId: parsed.sessionId,
				pr: parsed.pr,
				signal: ac.signal,
				onStream: (t) => {
					liveTail = (liveTail + t).slice(-400);
					requestRender?.();
				},
				onActivity,
			}).catch((err: unknown) => {
				runState.error = err instanceof Error ? err : new Error(String(err));
				return null;
			});

			// progress window (overlay) while the run streams; ESC cancels, m minimizes
			let closeWindow: (() => void) | null = null;
			let result: Awaited<ReturnType<typeof delegate>> | null = null;
			if (ctx.hasUI) {
				let overlayHandle: OverlayHandle | null = null;
				const uiPromise = ctx.ui
					.custom(
						(tui, theme, _kb, done) => {
							requestRender = () => tui.requestRender();
							closeWindow = () => done(undefined);
							return progressWindow(tui, theme, {
								mode: mode ?? "general",
								model: parsed.model ?? template?.model ?? loadConfig().model,
								startedAt: Date.now(),
								getEntries,
								dangerous,
								onCancel: () => {
									cancelled = true;
									ac.abort();
								},
								onMinimize: () => {
									// hide the window, keep the delegation running in the background
									overlayHandle?.setHidden(true);
									overlayHandle?.unfocus();
								},
							});
						},
						{
							overlay: true,
							overlayOptions: { width: "70%", maxHeight: "60%", anchor: "top-center" },
							onHandle: (h) => {
								overlayHandle = h;
								activeOverlay = {
									show: () => h.setHidden(false),
									focus: () => h.focus(),
									runId,
								};
								h.focus();
							},
						},
					)
					.catch(() => {
						// window failed to open — footer chip still shows progress
					});

				result = await run;
				await closeWhenMounted(() => closeWindow, 2000);
				await uiPromise;
			} else {
				result = await run;
			}
			clearActive();

			if (cancelled || !result) {
				if (ctx.hasUI) ctx.ui.setStatus("claude-delegate", undefined);
				const message = runState.error ? runState.error.message : cancelled ? "cancelled" : "delegation failed";
				if (ctx.hasUI) {
					ctx.ui.notify(`claude delegate ${cancelled ? "cancelled" : "failed"}: ${message}`, cancelled ? "warning" : "error");
				} else {
					process.stderr.write(`${message}\n`);
				}
				return;
			}
			const { content, details } = result;

			const summary = summarize(content);
			const file = (details.file as string) ?? null;
			const sessionId = (details.sessionId as string) ?? null;
			const resumeHint = sessionId ? ` · resume: /claude --resume=${sessionId} <prompt>` : "";

			// metrics summary: turns · cost · tokens · context% · duration
			const usage = details.usage as
				| { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
				| undefined;
			const promptTokens = usage
				? (usage.inputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
				: 0;
			const metrics = formatMetrics({
				numTurns: (details.numTurns as number) ?? 0,
				totalCostUsd: (details.totalCostUsd as number) ?? 0,
				promptTokens,
				contextPercent: typeof details.contextPercent === "number" ? (details.contextPercent as number) : null,
				durationMs: typeof details.durationMs === "number" && details.durationMs !== null ? (details.durationMs as number) : null,
			});

			// inject the report into the session so the main agent consumes it
			// on its next turn (participates in LLM context; full text in the file)
			injectReport(ctx, {
				mode: details.mode as string,
				metrics,
				body: summary.text,
				file: file ?? undefined,
				sessionId: sessionId ?? undefined,
			});

			if (ctx.hasUI) {
				ctx.ui.setStatus("claude-delegate", undefined);
				ctx.ui.notify(
					`claude ${details.mode} done — ${metrics}${resumeHint}` + ` · transcript: ${file}`,
					"info",
				);
			} else {
				process.stdout.write(`${summary.text}\n`);
			}
		},
	});

	// ── Input hint ───────────────────────────────────────────────────────────
	// Explicit markers (@claude, "…with claude", "delegate … to claude") always
	// add a delegation hint; keyword phrasing only when autoDelegateHints is on.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const hint = delegationHint(event.text, { autoDelegateHints: loadConfig().autoDelegateHints });
		if (!hint) return { action: "continue" };
		return { action: "transform", text: `${stripMarker(event.text)}\n\n${hint}` };
	});

	// ── Report injection ─────────────────────────────────────────────────────
	// Deliver a pending claude report to the agent's next turn so the main
	// session actually sees the results (session-only appends never reach the
	// live agent's in-memory context). Injected once, then cleared.
	pi.on("before_agent_start", async () => {
		if (!pendingReport) return;
		const report = pendingReport;
		pendingReport = null;
		return {
			message: {
				customType: "claude-delegate",
				content: report.content,
				display: true,
				details: report.details,
			},
		};
	});
}
