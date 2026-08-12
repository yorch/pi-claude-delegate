import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamLines } from "../extensions/stream-parse.ts";

test("extracts text deltas and the final result", () => {
	const lines = [
		JSON.stringify({ type: "system", subtype: "init" }),
		JSON.stringify({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
		}),
		JSON.stringify({
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
		}),
		JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
		JSON.stringify({
			type: "result",
			result: "Hello",
			num_turns: 1,
			total_cost_usd: 0.01,
			session_id: "abc",
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 3,
			},
		}),
	];

	const { streamedText, result } = parseStreamLines(lines);
	assert.equal(streamedText, "Hello");
	assert.ok(result);
	assert.equal(result!.result, "Hello");
	assert.equal(result!.totalCostUsd, 0.01);
	assert.equal(result!.usage!.inputTokens, 1);
});

test("handles malformed lines gracefully", () => {
	const { streamedText, result } = parseStreamLines(["not json", "", "{}", "null"]);
	assert.equal(streamedText, "");
	assert.equal(result, null);
});
