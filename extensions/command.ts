/**
 * Pure parser for the `/claude` command: `--key=value` flags, with a bare
 * template name as the first word selecting the mode.
 */

export interface ClaudeCommandArgs {
	task: string;
	mode?: string;
	model?: string;
	scope?: string;
	budget?: number;
	/** Resume an existing delegated session (--resume=<id>). */
	sessionId?: string;
}

export function parseClaudeCommand(raw: string, knownModes: ReadonlySet<string>): ClaudeCommandArgs {
	const flags: Record<string, string> = {};
	const rest = raw.replace(/--([a-zA-Z-]+)=(\S+)/g, (_m, k: string, v: string) => {
		flags[k] = v;
		return "";
	});

	let mode = flags.mode;
	let task = rest.trim();
	if (!mode) {
		const [first, ...restWords] = task.split(/\s+/);
		if (first && knownModes.has(first)) {
			mode = first;
			task = restWords.join(" ").trim();
		}
	}

	const out: ClaudeCommandArgs = { task };
	if (mode) out.mode = mode;
	if (flags.model) out.model = flags.model;
	if (flags.scope) out.scope = flags.scope;
	if (flags.budget !== undefined) out.budget = Number(flags.budget);
	if (flags.resume) out.sessionId = flags.resume;
	return out;
}
