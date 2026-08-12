/** Pure parser for Claude Code's `stream-json` output lines. */

export interface StreamedUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
}

export interface StreamedResult {
	result: string;
	isError: boolean;
	numTurns: number;
	totalCostUsd: number;
	sessionId: string | null;
	stopReason: string | null;
	permissionDenials: unknown[];
	usage: StreamedUsage | null;
}

/** Structured events describing what the delegated Claude is doing. */
export type ActivityEvent =
	| { kind: "tool_start"; name: string }
	| { kind: "tool_input"; name: string; input: Record<string, unknown> }
	| { kind: "tool_result"; isError: boolean }
	| { kind: "thinking"; chars: number };

export interface StreamParseOutcome {
	/** Accumulated text from content_block_delta / text_delta events. */
	streamedText: string;
	/** The final `result` line, if seen. */
	result: StreamedResult | null;
	/** Tool/thinking activity observed on this line. */
	activities: ActivityEvent[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Feed JSONL lines from `claude -p --output-format stream-json --verbose`.
 * Returns live-streamed text, tool/thinking activity, and the final result.
 */
export function parseStreamLines(lines: Iterable<string>): StreamParseOutcome {
	let streamedText = "";
	let result: StreamedResult | null = null;
	const activities: ActivityEvent[] = [];

	for (const line of lines) {
		let o: unknown;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(o)) continue;

		if (o.type === "stream_event" && isRecord(o.event)) {
			const ev = o.event;
			const delta = isRecord(ev.delta) ? ev.delta : undefined;

			if (ev.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
				streamedText += delta.text;
			} else if (
				ev.type === "content_block_delta" &&
				delta?.type === "thinking_delta" &&
				typeof delta.thinking === "string"
			) {
				activities.push({ kind: "thinking", chars: delta.thinking.length });
			} else if (ev.type === "content_block_start" && isRecord(ev.content_block)) {
				const cb = ev.content_block;
				if (cb.type === "tool_use" && typeof cb.name === "string") {
					activities.push({ kind: "tool_start", name: cb.name });
				}
			}
		} else if (o.type === "assistant" && isRecord(o.message)) {
			// full tool_use blocks carry the complete input
			for (const block of Array.isArray(o.message.content) ? o.message.content : []) {
				if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
					activities.push({
						kind: "tool_input",
						name: block.name,
						input: isRecord(block.input) ? block.input : {},
					});
				}
			}
		} else if (o.type === "user" && isRecord(o.message)) {
			for (const block of Array.isArray(o.message.content) ? o.message.content : []) {
				if (isRecord(block) && block.type === "tool_result") {
					activities.push({ kind: "tool_result", isError: block.is_error === true });
				}
			}
		} else if (o.type === "result") {
			const u = isRecord(o.usage) ? o.usage : null;
			result = {
				result: typeof o.result === "string" ? o.result : streamedText,
				isError: o.is_error === true,
				numTurns: typeof o.num_turns === "number" ? o.num_turns : 0,
				totalCostUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : 0,
				sessionId: typeof o.session_id === "string" ? o.session_id : null,
				stopReason: typeof o.stop_reason === "string" ? o.stop_reason : null,
				permissionDenials: Array.isArray(o.permission_denials) ? o.permission_denials : [],
				usage: u
					? {
							inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
							outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
							cacheCreationInputTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
							cacheReadInputTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
						}
					: null,
			};
		}
	}

	return { streamedText, result, activities };
}
