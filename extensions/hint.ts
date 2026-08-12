/**
 * Delegation-intent detection for user input.
 *
 * Gated entirely by `autoDelegateHints` — when off, user input is never
 * touched and nothing nudges the agent toward this tool (the tool still
 * exists in the available-tools list, so the agent may still choose it).
 * When on:
 *   - Explicit markers: `@claude`, "…with claude", "delegate … to claude"
 *     (marker stripped, hint appended)
 *   - Keyword phrasing: imperative review/plan/audit/docs (hint appended)
 *
 * Never hints when the text already names the tool or the /claude command.
 */

export interface HintConfig {
	/** Master switch — false = no hinting at all. */
	autoDelegateHints: boolean;
}

const EXPLICIT_MARKER_RE =
	/(?:^|\s)@claude\b|(?:\b(with|via|using)\s+claude\b)|(?:\bdelegate\b[\s\S]*\bclaude\b)/i;

const KEYWORD_RE = /^\s*(review|plan|audit|security\s*audit|document|implement|write\s+tests?)\b/i;

const HINT_TEXT =
	"[claude-delegate] The user wants this delegated to Claude Code. " +
	"Call the claude_delegate tool with a fitting mode (review, plan, security-audit, docs, implement, …) " +
	"rather than doing the work yourself. Only skip it if delegation is clearly inappropriate.";

/** Returns the hint to append, or null when the input needs no hint. */
export function delegationHint(text: string, cfg: HintConfig): string | null {
	if (!cfg.autoDelegateHints) return null;

	// already explicit about the tool or command — nothing to add
	if (/\bclaude_delegate\b|\/claude\b/.test(text)) return null;

	if (EXPLICIT_MARKER_RE.test(text)) return HINT_TEXT;

	if (KEYWORD_RE.test(text)) return HINT_TEXT;

	return null;
}

/** Remove the `@claude` prefix marker from the text before sending. */
export function stripMarker(text: string): string {
	return text.replace(/(?:^|\s)@claude\b/g, " ").replace(/\s{2,}/g, " ").trim();
}
