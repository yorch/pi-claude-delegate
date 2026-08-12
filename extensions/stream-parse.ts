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

export interface StreamParseOutcome {
	/** Accumulated text from content_block_delta / text_delta events. */
	streamedText: string;
	result: StreamedResult | null;
}

/**
 * Feed JSONL lines from `claude -p --output-format stream-json --verbose`.
 * Returns the live-streamed text and the final `result` line (if seen).
 */
export function parseStreamLines(lines: Iterable<string>): StreamParseOutcome {
	let streamedText = "";
	let result: StreamedResult | null = null;

	for (const line of lines) {
		let o: unknown;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (!o || typeof o !== "object") continue;
		const rec = o as Record<string, unknown>;

		if (rec.type === "stream_event") {
			const ev = (rec.event ?? {}) as Record<string, unknown>;
			if (
				ev.type === "content_block_delta" &&
				(ev.delta as Record<string, unknown> | undefined)?.type === "text_delta"
			) {
				const text = (ev.delta as Record<string, unknown>).text;
				if (typeof text === "string") streamedText += text;
			}
		} else if (rec.type === "result") {
			const u = (rec.usage ?? null) as Record<string, number> | null;
			result = {
				result: typeof rec.result === "string" ? rec.result : streamedText,
				isError: rec.is_error === true,
				numTurns: typeof rec.num_turns === "number" ? rec.num_turns : 0,
				totalCostUsd: typeof rec.total_cost_usd === "number" ? rec.total_cost_usd : 0,
				sessionId: typeof rec.session_id === "string" ? rec.session_id : null,
				stopReason: typeof rec.stop_reason === "string" ? rec.stop_reason : null,
				permissionDenials: Array.isArray(rec.permission_denials) ? rec.permission_denials : [],
				usage: u
					? {
							inputTokens: u.input_tokens ?? 0,
							outputTokens: u.output_tokens ?? 0,
							cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
							cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
						}
					: null,
			};
		}
	}

	return { streamedText, result };
}
