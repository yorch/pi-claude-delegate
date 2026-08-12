# AGENTS.md

Guidance for AI coding agents working in this repository.

`@yorch/pi-claude-delegate` is a [pi coding agent](https://github.com/badlogic/pi-mono)
extension that delegates work to the `claude` CLI (Claude Code headless). It
ships as an npm package (`pi-package` keyword), installable with
`pi install npm:@yorch/pi-claude-delegate`.

> `CLAUDE.md` is a symlink to `AGENTS.md` — keep them in sync.

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `extensions/` (strict, `allowImportingTsExtensions`) |
| `npm test` | `node --experimental-strip-types --test tests/**/*.test.ts` (14 tests, node:test) |
| `npm publish --access public` | Publish to npm (scoped → the flag is mandatory) |
| `pi -e <path> -p "…" --no-tools` | Load the local package as a temporary extension; smoke-tests manifest + factory |

CI runs typecheck + tests on every push (`.github/workflows/ci.yml`).

## Architecture

- `extensions/index.ts` — entry. Registers the `claude_delegate` tool and the
  `/claude` command, reads `claudeDelegate` config from `~/.pi/agent/settings.json`,
  builds prompts, saves long outputs. The `delegate()` helper is the shared
  engine for tool + command.
- `extensions/run-claude.ts` — subprocess runner. Spawns
  `claude -p --output-format stream-json --verbose --include-partial-messages
  --no-session-persistence --permission-mode <mode>`, parses JSONL lines via
  `stream-parse.ts`, calls `onStream` for live text deltas, resolves with the
  final `result` line. `--verbose` is **required** for stream-json — do not drop it.
- `extensions/stream-parse.ts` — pure JSONL parser (text deltas + result
  extraction). Unit-tested; keep it free of IO.
- `extensions/templates.ts` — template discovery + frontmatter parsing.
  Built-ins ship in `templates/*.md`; users add custom templates in
  `~/.pi/agent/claude-delegate/templates/` (global) and
  `<cwd>/.pi/claude-delegate/templates/` (project). Later sources override
  earlier on name collision. `permissionMode` must be one of the six Claude
  `--permission-mode` values; anything else falls back to `acceptEdits`.
- `extensions/usage.ts` — maps Claude usage/cost to pi's `Usage` so delegated
  runs show in pi's footer token/cost stats. `cacheCreationInputTokens` folds
  into `input`.

## Conventions

- **Tabs**, single quotes, 120-col lines.
- TypeScript strict; explicit types on exported functions.
- Relative imports **must include `.ts`** (`./stream-parse.ts`) — jiti + `allowImportingTsExtensions`.
- **Templates live as .md files with frontmatter**, never as code strings.
  Frontmatter keys: `name, description, permissionMode, model, maxBudgetUsd, skill`.
- **Never default to `bypassPermissions`.** The only path is an explicit
  `allowDangerous: true` on a call. `review`/`plan`/`security-audit` templates
  must stay `permissionMode: plan` (read-only).
- Guard UI calls (`ctx.ui.*`) with `ctx.hasUI` — the `/claude` command already
  does; keep it that way. Tools run in all modes.
- Scope `"diff"` is resolved in-process via `git diff HEAD` (reliable in plan
  mode); don't rely on Claude running git.

## Release process

1. Edit → `npm run typecheck && npm test`.
2. Bump `version` in `package.json` by hand.
3. Commit + push.
4. `npm publish --access public`.
5. `pi update --extensions` on installed machines.

Load-test a change: `pi -e <repo path> -p "Reply with exactly: OK" --no-tools`.
The engine can be exercised without pi:
`node --experimental-strip-types --input-type=module -e "import {runClaude} from './extensions/run-claude.ts'; …"`.

## Gotchas

- **npm name-similarity guard** forced the scoped name `@yorch/pi-claude-delegate`. Don't rename.
- **Scoped npm packages default to private** → always `--access public`.
- **npm CLI auth needs a fresh OTP per publish session**; `npm whoami` succeeding is not enough.
- **Registry metadata lags ~2 min after publish** — tarball is live, `npm view` may 404. Wait.
- **`stream-json` requires `--verbose`** or claude exits 1 with a usage error.
- **`--no-session-persistence`** keeps delegated runs from littering session files; prompt caching (cache_read tokens) still works.
- Peer deps are `"*"` (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) — pi bundles them; never add to `dependencies`.
- The tarball (`files`) ships `extensions/`, `templates/`, `README.md`, `LICENSE` — tests stay in the repo.

## Scope notes

- Do not add a second delegation backend — the design is one runner, pluggable templates.
- Templates are the extension point; prefer adding a template over adding code.
- Claude Code's repo skills (`.claude/skills/`) work automatically via `cwd`; only pin via `skill:` frontmatter when a task demands one.
