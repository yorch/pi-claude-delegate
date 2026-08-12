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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runClaude, DEFAULT_TIMEOUT_MS, type ClaudeResult } from "./run-claude.ts";
import { parseClaudeCommand } from "./command.ts";
import { loadTemplates, type DelegateTemplate } from "./templates.ts";
import { mapClaudeUsage } from "./usage.ts";
import { buildTranscript, collectActivityLog, formatToolUse } from "./activity.ts";
import type { ActivityEvent } from "./stream-parse.ts";

interface DelegateConfig {
	model?: string;
	timeoutMs: number;
	defaultMode: string;
	allowDangerous: boolean;
	/** Reveal Claude's thinking deltas in the live feed (default off). */
	inspectThinking: boolean;
}

interface DelegateOptions {
	task: string;
	mode?: string;
	scope?: string;
	model?: string;
	maxBudgetUsd?: number;
	allowDangerous?: boolean;
	sessionId?: string;
	onStream?: (text: string) => void;
	onActivity?: (ev: ActivityEvent) => void;
	signal?: AbortSignal;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function loadConfig(): DelegateConfig {
	const cfg: DelegateConfig = {
		timeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMode: "general",
		allowDangerous: false,
		inspectThinking: false,
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
	} catch {
		// invalid settings — fall back to defaults
	}
	return cfg;
}

function outputsDir(): string {
	return join(agentDir(), "claude-delegate", "outputs");
}

function saveOutput(mode: string, text: string): string {
	const dir = outputsDir();
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = join(dir, `${stamp}-${mode}.md`);
	writeFileSync(file, text, "utf8");
	return file;
}

function buildPrompt(template: DelegateTemplate, task: string, scopeText: string | null, cwd: string): string {
	const branch = "";
	let prompt = [
		`You are being delegated a subtask by the pi coding agent.`,
		`Working directory: ${cwd}${branch ? ` (branch ${branch})` : ""}`,
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

	// scope "diff" → compute the git diff ourselves (reliable, works in plan mode)
	let scopeText: string | null = opts.scope ?? null;
	if (opts.scope === "diff") {
		const diff = await pi.exec("git", ["diff", "HEAD"], { cwd: ctx.cwd });
		scopeText = diff.stdout
			? `Current git diff (working tree vs HEAD):\n${diff.stdout}`
			: "No git diff vs HEAD (working tree clean).";
	}

	const permissionMode = opts.allowDangerous ? "bypassPermissions" : template.permissionMode;
	const model = opts.model ?? template.model ?? config.model;
	const prompt = buildPrompt(template, opts.task, scopeText, ctx.cwd);

	const activityEvents: ActivityEvent[] = [];
	const result = await runClaude({
		prompt,
		cwd: ctx.cwd,
		permissionMode,
		model,
		maxBudgetUsd: opts.maxBudgetUsd ?? template.maxBudgetUsd,
		signal: opts.signal,
		timeoutMs: config.timeoutMs,
		resumeSessionId: opts.sessionId,
		onStream: opts.onStream,
		onActivity: (ev) => {
			activityEvents.push(ev);
			opts.onActivity?.(ev);
		},
	});

	if (result.isError && !result.result && !result.streamedText) {
		throw new Error("claude reported an error and produced no output");
	}

	// full transcript is always written — the record for post-hoc inspection
	const activityLog = collectActivityLog(activityEvents);
	const file = saveOutput(
		mode,
		buildTranscript({
			mode,
			permissionMode,
			model: model ?? null,
			cwd: ctx.cwd,
			sessionId: result.sessionId,
			resumed: Boolean(opts.sessionId),
			numTurns: result.numTurns,
			totalCostUsd: result.totalCostUsd,
			isError: result.isError,
			stopReason: result.stopReason,
			activityLog,
			output: result.result || result.streamedText,
		}),
	);

	return {
		content: result.result || result.streamedText || "(empty result)",
		details: {
			mode,
			permissionMode,
			model: model ?? null,
			numTurns: result.numTurns,
			totalCostUsd: result.totalCostUsd,
			sessionId: result.sessionId,
			stopReason: result.stopReason,
			permissionDenials: result.permissionDenials,
			isError: result.isError,
			resumed: Boolean(opts.sessionId),
			file,
		},
		result,
		activityLog,
	};
}

function summarize(content: string, max = 30_000): { text: string; truncated: boolean } {
	if (content.length <= max) return { text: content, truncated: false };
	return { text: `${content.slice(0, max)}\n…[truncated — full output saved to file]`, truncated: true };
}

export default function (pi: ExtensionAPI) {
	// ── Tool ─────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "claude_delegate",
		label: "Claude Delegate",
		description:
			"Delegate a task to Claude Code (headless) and return its report. Use for code reviews, detailed plans, security audits, docs, or implementation the user wants Claude to own. Modes come from templates (review, plan, implement, security-audit, docs, general, or custom).",
		promptSnippet: "Delegate a subtask to Claude Code (reviews, plans, audits, docs, implementation)",
		promptGuidelines: [
			"Use claude_delegate when the user asks for a code review, a detailed plan, a security audit, or wants work delegated to Claude Code.",
			"Pass a focused task string — include the intent and any constraints. Use scope: \"diff\" to review the current git diff, a path list to restrict, or omit for the whole repo.",
			"Prefer mode \"review\"/\"plan\"/\"security-audit\" (read-only) unless the user asked for changes — then use \"implement\".",
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

			return {
				content: [{ type: "text", text: `${head}${body}${footer}` }],
				details,
				usage: result.usage ? mapClaudeUsage({ ...result.usage, totalCostUsd: result.totalCostUsd }) : undefined,
			};
		},
	});

	// ── Command ──────────────────────────────────────────────────────────────
	pi.registerCommand("claude", {
			description:
				"Delegate a task to Claude Code. Usage: /claude [--mode=review|plan|implement|security-audit|docs|general] [--model=sonnet] [--scope=diff|paths] [--resume=<session-id>] <prompt> — or use a mode name as the first word: /claude review <prompt>",
		handler: async (args, ctx) => {
			const parsed = parseClaudeCommand(args, new Set(loadTemplates(ctx.cwd).keys()));
			const { task, mode } = parsed;

			if (!task) {
				if (mode) {
					ctx.ui.notify?.(`/claude ${mode} <what to do> — give a prompt for the "${mode}" mode`, "warning");
				} else {
					ctx.ui.notify?.("Usage: /claude [--mode=…] [--model=…] [--scope=…] <prompt>", "warning");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.setStatus("claude-delegate", ctx.ui.theme.fg("accent", "●") + ctx.ui.theme.fg("dim", ` claude ${mode ?? ""} running…`));
			}

			try {
				const { content, details } = await delegate(pi, ctx, {
					task,
					mode: parsed.mode,
					scope: parsed.scope,
					model: parsed.model,
					maxBudgetUsd: parsed.budget,
					sessionId: parsed.sessionId,
				});

				const summary = summarize(content);
				const file = (details.file as string) ?? null;
				const sessionId = (details.sessionId as string) ?? null;
				const resumeHint = sessionId ? ` · resume: /claude --resume=${sessionId} <prompt>` : "";

				if (ctx.hasUI) {
					ctx.ui.setStatus("claude-delegate", undefined);
					ctx.ui.notify(
						`claude ${details.mode} done — ${(details.numTurns as number) ?? 0} turn(s), $${((details.totalCostUsd as number) ?? 0).toFixed(3)}${resumeHint}` +
							` · transcript: ${file}`,
						"info",
					);
				} else {
					process.stdout.write(`${summary.text}\n`);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) {
					ctx.ui.setStatus("claude-delegate", undefined);
					ctx.ui.notify(`claude delegate failed: ${message}`, "error");
				} else {
					process.stderr.write(`${message}\n`);
				}
			}
		},
	});
}
