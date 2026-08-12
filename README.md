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
the template/config, scope to the whole repo). `/claude review` alone prints
a hint for the review mode instead of running.

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

## Inspecting what Claude is doing

- **Live activity feed** — while a delegation runs, the tool box streams what
  Claude is doing: `▶ Bash: List all tracked files in repo ✓`, `💭 thinking…`,
  and a tail of the answer as it forms.
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
    "inspectThinking": false
  }
}
```

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
