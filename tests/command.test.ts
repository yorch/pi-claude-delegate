import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCommand } from "../extensions/command.ts";

const MODES = new Set(["review", "plan", "implement", "security-audit", "docs", "general"]);

test("bare mode name as first word", () => {
	assert.deepEqual(parseClaudeCommand("review the auth flow", MODES), {
		task: "the auth flow",
		mode: "review",
	});
});

test("bare mode alone yields empty task", () => {
	const r = parseClaudeCommand("review", MODES);
	assert.equal(r.mode, "review");
	assert.equal(r.task, "");
});

test("explicit --mode wins over first word", () => {
	assert.equal(parseClaudeCommand("--mode=plan write a plan", MODES).mode, "plan");
	assert.equal(parseClaudeCommand("--mode=plan review", MODES).mode, "plan");
});

test("non-mode first word stays in the task", () => {
	const r = parseClaudeCommand("help me fix a bug", MODES);
	assert.equal(r.mode, undefined);
	assert.equal(r.task, "help me fix a bug");
});

test("flags parse with defaults", () => {
	assert.deepEqual(parseClaudeCommand("--mode=security-audit --scope=auth/ --model=opus --budget=3 audit it", MODES), {
		task: "audit it",
		mode: "security-audit",
		model: "opus",
		scope: "auth/",
		budget: 3,
	});
});

test("empty input", () => {
	assert.deepEqual(parseClaudeCommand("", MODES), { task: "" });
});
