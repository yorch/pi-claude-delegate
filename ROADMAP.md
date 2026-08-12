# Working / Tracking Doc — pi-claude-delegate

Working document for planned and in-flight work. Statuses: `done` · `in progress` ·
`todo` · `future` (bigger items). Update statuses as work lands; keep it in sync
with the code and the release notes.

Legend: [H]=high value · [M]=medium · [F]=future

---

## 1. `/claude list` — discover modes
**Status:** done (0.5.0)

Show the available delegation modes (name, permission, model, description)
from all template sources. Implemented as a read-only picker component
(`ctx.ui.custom`, any key closes). Makes custom templates instantly
discoverable without reading docs.

**Design notes**
- Sources: built-ins + user-global + project templates (same merge as the runner).
- Rows: `name · permissionMode · model · description`; `defaultTask` marked with `↳`.
- Non-UI mode: print to stdout.

## 2. `/claude history` — browse past runs
**Status:** done (0.5.0)

Browse past delegated runs from the transcripts dir (newest first), open a
transcript in a scrollable viewer, or copy/resume its session.

**Design notes**
- Index = the outputs dir (`~/.pi/agent/claude-delegate/outputs/*.md`); parse the
  metadata header (mode, cost, session id, date) without loading the whole file.
- Picker: mode · date · $cost · session-id prefix.
- Actions: `enter` opens a scrollable viewer (↑/↓/ESC); `r` prints the resume
  command (`/claude --resume=<id> <prompt>`).
- Non-UI mode: print the index as text.

## 3. Partial transcript on cancel
**Status:** done (0.5.0)

A cancelled/timed-out run currently leaves nothing. On failure, save whatever
streamed so far as `<ts>-<mode>-partial.md` (with the metadata header), so the
user can recover partial work.

**Design notes**
- `delegate()` accumulates the full streamed text; on runClaude rejection with
  non-empty accumulation, writes a partial transcript then rethrows.
- Includes the activity log collected up to that point.

## 4. PR review (`scope: pr` / `/claude --pr=`)
**Status:** done (0.5.0)

Review a GitHub pull request: fetch its diff and inject it like the `diff`
scope.

**Design notes**
- Tool: `scope: "pr"` → current branch's PR diff via `gh pr diff`.
- Command: `--pr=<number|url>` → `gh pr diff <number>` (accepts URLs).
- Error clearly if `gh` is missing or the PR can't be resolved.
- Falls back to a sensible message in the scope text (never a hard crash).

## 5. Transcript retention
**Status:** done (0.5.0)

The outputs dir grows forever. Config `maxTranscripts` (default 100) prunes the
oldest runs after each save.

**Design notes**
- Applied after every successful save in `delegate()`.
- `maxTranscripts: 0` disables pruning. Only counts `*.md` (includes partials).

## 6. Concurrency guard
**Status:** done (0.5.0)

Prevent overlapping delegated runs (each costs money). Config `maxConcurrent`
(default 1); enforced centrally in `delegate()` so both the tool and the
command obey it.

**Design notes**
- Module-level active-run counter, decremented in `finally`.
- Excess callers get a clear error ("another claude run is already in
  progress").

## 7. `allowDangerous` warning in the window
**Status:** done (0.5.0)

When a mode runs with `bypassPermissions`, the progress window shows a red
warning banner (`⚠ bypassPermissions — unrestricted access`) instead of being
silent about it.

**Design notes**
- `progressWindow` accepts `dangerous`; banner line at the top, `error` color.
- The command resolves the template to detect `permissionMode ===
  "bypassPermissions"`.

## 8. Metrics: storage + display
**Status:** done (0.5.0)

Cost, tokens (input/output/cache), context % and duration are:
- **Stored** in the transcript header, tool-result `details`, and (via
  `usage`) pi's footer stats — per run.
- **Shown** in the completion notify (`· 62k tok · 6.2% ctx · 12s`) and the
  injected session report header.
- The progress window shows a live **elapsed** timer while running.

**Design notes**
- Cost/tokens/context are only known when claude reports the result (end of
  run); the window shows elapsed live instead.
- `details.usage` keeps the raw token breakdown for tooling.

## 9. Mode-specific model presets (economy/balanced/max)
**Status:** done (0.5.0)

Configurable model aliases so templates can request a *class* of model instead
of a literal:

```json
{ "claudeDelegate": { "modelAliases": { "economy": "haiku", "balanced": "sonnet", "max": "opus" } } }
```

Templates may use `model: economy` / `balanced` / `max` (or a literal).
Resolution: call param → template `model` → config `model`, each alias-resolved.

**Design notes**
- Aliases map is user-overridable; defaults as above.
- Unknown alias values pass through to the CLI verbatim (claude validates).

## 10. [F] Sandboxed runs (gondolin)
**Status:** todo (future)

Run delegated Claude inside pi's `gondolin` container for untrusted repos
(security audits of third-party code). Real power, real complexity — container
images, tool/permission mapping, output plumbing.

## 11. [F] Budgets / billing summaries
**Status:** todo (future)

Aggregate per-project or per-day spend from the transcripts index (cost
column), a `/claude spend` view.

## 12. [F] Multi-run parallel windows
**Status:** todo (future)

Allow N concurrent runs each with its own progress window (requires
`maxConcurrent > 1` + per-run overlay management; the current single
`activeOverlay` design assumes one).

---

## How to update this doc

- Flip a status to `done` with the version where it landed.
- Add new ideas with a number + `todo`; keep `future` for the heavy ones.
- Keep the design notes accurate — they're the memory of why things are built
  the way they are.
