import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTranscript, collectActivityLog, formatToolUse } from "../extensions/activity.ts";

test("formatToolUse prefers description", () => {
	assert.equal(formatToolUse("Bash", { command: "ls", description: "List files" }), "Bash: List files");
	assert.equal(formatToolUse("Read", { file_path: "auth/login.ts" }), "Read: auth/login.ts");
	assert.equal(formatToolUse("Grep", { pattern: "TODO" }), "Grep: TODO");
	assert.equal(formatToolUse("Bash", { command: "git status" }), "Bash: git status");
	assert.equal(formatToolUse("Unknown", { a: 1 }), "Unknown");
});

test("formatToolUse truncates long commands", () => {
	const long = "echo " + "x".repeat(200);
	const out = formatToolUse("Bash", { command: long });
	assert.ok(out.length <= 100, `length ${out.length}`);
	assert.ok(out.endsWith("…"));
});

test("collectActivityLog pairs tool calls with results", () => {
	const log = collectActivityLog([
		{ kind: "tool_start", name: "Bash" },
		{ kind: "tool_input", name: "Bash", input: { command: "ls" } },
		{ kind: "tool_result", isError: false },
		{ kind: "tool_input", name: "Grep", input: { pattern: "x" } },
		{ kind: "tool_result", isError: true },
	]);
	assert.deepEqual(log, ["▶ Bash: ls  ✓", "▶ Grep: x  ✗ error"]);
});

test("buildTranscript includes metadata, activity and output", () => {
	const t = buildTranscript({
		mode: "review",
		permissionMode: "plan",
		model: "sonnet",
		cwd: "/repo",
		sessionId: "sess-1",
		resumed: true,
		numTurns: 2,
		totalCostUsd: 0.1234,
		isError: false,
		stopReason: "end_turn",
		activityLog: ["▶ Read: a.ts  ✓"],
		output: "findings…",
	});
	assert.ok(t.startsWith("# Delegated Claude run — review"));
	assert.ok(t.includes("permission: plan"));
	assert.ok(t.includes("session: sess-1 (resumed)"));
	assert.ok(t.includes("cost: $0.1234"));
	assert.ok(t.includes("▶ Read: a.ts  ✓"));
	assert.ok(t.includes("findings…"));
});
