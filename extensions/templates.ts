import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type PermissionMode =
	| "plan"
	| "acceptEdits"
	| "bypassPermissions"
	| "dontAsk"
	| "auto"
	| "manual";

export interface DelegateTemplate {
	name: string;
	description: string;
	permissionMode: PermissionMode;
	model?: string;
	maxBudgetUsd?: number;
	/** A Claude Code skill (from the repo's .claude/skills) to pin. */
	skill?: string;
	prompt: string;
}

const PERMISSION_MODES = new Set<PermissionMode>([
	"plan",
	"acceptEdits",
	"bypassPermissions",
	"dontAsk",
	"auto",
	"manual",
]);

/** Parse a template file: frontmatter (`---\nkey: value\n---`) + markdown body. */
export function parseTemplate(text: string): DelegateTemplate | null {
	const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.trimStart());
	if (!m) return null;

	const meta: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}

	const name = meta.name?.trim();
	if (!name) return null;

	const permissionMode = PERMISSION_MODES.has(meta.permissionMode as PermissionMode)
		? (meta.permissionMode as PermissionMode)
		: "acceptEdits";

	const budget = meta.maxBudgetUsd ? Number(meta.maxBudgetUsd) : NaN;

	return {
		name,
		description: meta.description ?? "",
		permissionMode,
		model: meta.model || undefined,
		maxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
		skill: meta.skill || undefined,
		prompt: m[2].trim(),
	};
}

function loadDir(dir: string, out: Map<string, DelegateTemplate>): void {
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".md")) continue;
		try {
			const t = parseTemplate(readFileSync(join(dir, f), "utf8"));
			if (t) out.set(t.name, t);
		} catch {
			// skip unreadable files
		}
	}
}

/** Templates shipped with the package (extensions/../templates). */
export function builtinTemplatesDir(): string {
	return fileURLToPath(new URL("../templates/", import.meta.url));
}

/** User-global custom templates: ~/.pi/agent/claude-delegate/templates/. */
export function userTemplatesDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(dir, "claude-delegate", "templates");
}

/** Project-local custom templates: <cwd>/.pi/claude-delegate/templates/. */
export function projectTemplatesDir(cwd: string): string {
	return join(cwd, ".pi", "claude-delegate", "templates");
}

/** Built-ins < user-global < project-local (later wins on name collisions). */
export function loadTemplates(cwd: string): Map<string, DelegateTemplate> {
	const out = new Map<string, DelegateTemplate>();
	loadDir(builtinTemplatesDir(), out);
	loadDir(userTemplatesDir(), out);
	loadDir(projectTemplatesDir(cwd), out);
	return out;
}
