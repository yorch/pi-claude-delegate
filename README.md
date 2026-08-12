# pi-claude-delegate

Delegate work to [Claude Code](https://github.com/anthropics/claude-code) from the [pi coding agent](https://github.com/badlogic/pi-mono): code reviews, detailed plans, implementation, security audits, docs — or your own custom templates.

Claude Code runs headless in your repo with a permission mode chosen per task. Results stream back live, and Claude's token/cost usage feeds into pi's footer stats.

## Install

```bash
pi install npm:@yorch/pi-claude-delegate
# or from git
pi install git:github.com/yorch/pi-claude-delegate
```

Requires the `claude` CLI on your PATH (`claude --version`). Restart pi (or `/reload`) to activate.

## Usage

The pi agent uses the `claude_delegate` tool automatically when you ask for e.g. *"review this diff"*, *"make a plan for …"*, or *"audit the auth code"*.

Manual delegation:

```bash
/claude review the new auth flow                     # mode from first word
/claude --mode=security-audit --scope=auth/ …       # or explicit --mode=
/claude --mode=implement implement caching …        # implement with edits
/claude plan the cache migration
```

Only the prompt is required. A **mode name as the first word** selects the
mode; every `--flag` is optional (mode defaults to `defaultMode`, model to
the template/config, scope to the whole repo).

Some modes have **default tasks** when the prompt is omitted:
`/claude review` reviews the current git diff (`scope: diff`),
`/claude security-audit` audits the repository. Modes without a default
(`plan`, `implement`, `docs`, `general`) print a hint asking for a prompt.

The `claude_delegate` tool takes: `task`, `mode`, `scope` (`"diff"` = current git diff, a path list, or omit for the whole repo), `model`, `maxBudgetUsd`, `allowDangerous`.

## Modes (templates)

| Mode | Permission | Model | Purpose |
| --- | --- | --- | --- |
| `review` | `plan` (read-only) | sonnet | Code review, cites `file:line`, prioritized findings |
| `plan` | `plan` (read-only) | sonnet | Detailed implementation plan with steps + risks |
| `implement` | `acceptEdits` | sonnet | Implements a task, runs checks, reports changes |
| `security-audit` | `plan` (read-only) | sonnet | Injection, auth, secrets, deserialization, supply chain |
| `docs` | `acceptEdits` | sonnet | Generate/update docs matching repo style |
| `general` | `acceptEdits` | config default | Any task |

Each mode is a markdown template. Built-ins ship in the package's `templates/` (read them, copy them). **Custom templates** are just files with frontmatter + instructions, dropped in:

- `~/.pi/agent/claude-delegate/templates/<name>.md` (global)
- `.pi/claude-delegate/templates/<name>.md` (project — loaded when the project is trusted)

```markdown
---
name: test-writer
description: Write unit tests for a scope. Writes files.
permissionMode: acceptEdits
model: sonnet
maxBudgetUsd: 3
---
You are a test engineer. Write focused unit tests matching the repo's
test framework and conventions. Run the suite and fix failures.
```

Any registered template name becomes a valid `mode` for the tool and `/claude --mode=<name>`.

**Skills:** delegated Claude runs with `cwd` = your repo, so `.claude/skills/` in the repo are automatically available. Pin one with `skill: <name>` in a template's frontmatter.

## How the main session consumes the output

- **Agent-driven (`claude_delegate` tool)** — the report is the tool result, so
  it flows straight into the agent's context. The agent summarizes it, answers
  follow-ups, and keeps working from it automatically.
- **Manual (`/claude` command)** — after the run, the report is appended to the
  session as a custom message: it appears in the conversation (themed) *and*
  participates in LLM context, so your next prompt is answered with the report
  already in hand. The full text is also in the transcript file. Nothing is
  consumed automatically only in non-interactive modes (print/rpc), where the
  report goes to stdout.

So the natural loop is: `/claude --mode=review <task>` → the report lands in the
chat → you ask "what should we fix first?" and the main agent answers from it.

## Inspecting what Claude is doing

- **Live activity feed** — while a delegation runs, the tool box streams what
  Claude is doing: `▶ Bash: List all tracked files in repo ✓`, `💭 thinking…`,
  and a tail of the answer as it forms. The `/claude` command opens a
  **framed progress window** with the same feed — a bordered
  modal showing `⠋ claude <mode> · <model> · ⏱ elapsed`, per-kind styling
  (accent tool calls with ✓/✗, dim thinking, streaming text), a red
  `⚠ bypassPermissions` banner when a mode runs unrestricted, and a hint row;
  `esc` twice
  cancels — first press arms, second confirms within 1.5s, so a stray tap
  never kills the run; `m` **minimizes** — the window hides while the run
  continues in the background, footer chip keeps updating; re-open with
  `/claude watch`) and mirrors it into the footer status chip.
- **Formatted results** — completed delegations render with a custom tool box:
  a colored head line (mode · turns · cost), the report as syntax-highlighted
  markdown (theme-aware), and a transcript/resume footer.
- **Full transcript every run** — the complete output plus a tool-activity log
  and metadata is written to `~/.pi/agent/claude-delegate/outputs/` (never in
  your repo). The tool result always ends with the transcript path.
- **Resume a session** — every run records a session id. Continue headlessly:

  ```bash
  /claude --resume=<session-id> follow up on the review
  ```

  or interactively with `claude --resume <session-id>` in your terminal.

  Reveal Claude's thinking live with `"inspectThinking": true` in the
  `claudeDelegate` config (off by default).

## Config

All optional — in `~/.pi/agent/settings.json`:

```json
{
  "claudeDelegate": {
    "model": "sonnet",
    "timeoutMs": 600000,
    "defaultMode": "general",
    "allowDangerous": false,
    "inspectThinking": false,
    "maxBudgetUsd": 3,
    "autoDelegateHints": false,
    "modelAliases": { "economy": "haiku", "balanced": "sonnet", "max": "opus" },
    "maxConcurrent": 1,
    "maxTranscripts": 100
  }
}
```

`maxBudgetUsd` is a global default spend cap — per-call (`maxBudgetUsd` /
`--budget=`), per-template (frontmatter), then config, in that order.

- **`modelAliases`** — templates may use `model: economy|balanced|max` (or any
  alias you define) instead of a literal; resolution: call → template → config,
  each alias-resolved.
- **`maxConcurrent`** — cap on overlapping delegated runs (default 1; each run
  costs money).
- **`maxTranscripts`** — oldest transcripts pruned beyond this count
  (default 100; `0` disables).

### `autoDelegateHints` — inert by default

The extension never nudges the agent toward this tool unless you opt in. The
tool exists in the agent's tool list with a neutral description (it may still
be chosen on its own judgment), but:

- **`autoDelegateHints: false` (default)** — user input is never touched. No
  system-prompt bias, no hint injection. Delegation happens via the `/claude`
  command or when the agent chooses the tool itself.
- **`autoDelegateHints: true`** — the input hook recognizes delegation intent
  and appends a hint for the agent: explicit markers ("…with claude",
  "delegate … to claude", "via claude") and imperative review/plan/audit/docs
  phrasing. Already-explicit references to `claude_delegate` or `/claude` are
  never re-hinted.

  > **Marker caveat:** don't *start* a prompt with `@claude` — pi parses a
  > leading `@` as a file attachment. Use the phrase forms above, or `/claude`.

## Metrics recorded

Every run records, in the tool result details **and** the transcript:

| Metric | Source |
| --- | --- |
| Cost | `total_cost_usd` |
| Tokens: input / output / cache write / cache read | `usage` |
| Context consumed (% of window) | prompt tokens ÷ `modelUsage.contextWindow` |
| Actual model | `modelUsage` key (canonical id, alias resolved) |
| Context window / max output | `modelUsage` |
| Turns, duration, TTFT, stop reason, session id | result |

Token + cost also feed pi's `usage` on the tool result, so they show up in the
pi footer stats. `maxBudgetUsd` hard-caps spend at the CLI level.

## Security model

- `review` / `plan` / `security-audit` run with **`--permission-mode plan`** — read-only, can never edit.
- `implement` / `docs` / `general` run with **`acceptEdits`** — file edits auto-accepted, everything else still prompts.
- **`bypassPermissions`** is only reachable via `allowDangerous: true` on a call (never a default).
- Long outputs are truncated inline and saved to `~/.pi/agent/claude-delegate/outputs/` (never in your repo).

Review what the `claude` CLI is asked to do before granting it broad permissions — like any powerful tool, delegate only in directories you trust.

## Development

```bash
npm install
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release dev-loop. Agents working in this repo should read [AGENTS.md](AGENTS.md).

## Credits

Built on pi's extension API and Claude Code's headless mode (`claude -p --output-format stream-json --verbose`).

## License

MIT
