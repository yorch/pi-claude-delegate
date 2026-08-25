# AGENTS.md

Guidance for AI coding agents working in this repository.

`@yorch/pi-claude-delegate` is a [pi coding agent](https://github.com/badlogic/pi-mono)
extension that delegates work to the `claude` CLI (Claude Code headless). It
ships as an npm package (`pi-package` keyword), installable with
`pi install npm:@yorch/pi-claude-delegate`.

> **Deprecated — use `pi-harness-delegate` for new work.** This repo is kept for compatibility and receives toolchain updates (Bun/Node 26/Biome/changesets) but new features go to `pi-harness-delegate`.

> `CLAUDE.md` is a symlink to `AGENTS.md` — keep them in sync.

## Commands

| Command | What it does |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit` over `extensions/` (strict, `allowImportingTsExtensions`) |
| `bun test` | `bun test` (14 tests, bun:test — node:test compatible) |
| `bun run lint` | `biome check .` (2 spaces, 120 cols, single quotes) |
| `bun run lint:fix` | `biome check --write .` |
| `bun run verify` | `lint && typecheck && test` — CI and release gate |
| `bun changeset` | Create a changeset `.md` (commit it); `--empty` for docs/CI-only |
| `bun run version-packages` | Changesets bump + CHANGELOG (run by release workflow) |
| `bun run release` | `bun run verify && node scripts/check-packables.mjs && changeset publish` (OIDC) |
| `pi -e <path> -p "…" --no-tools` | Load the local package as a temporary extension; smoke-tests manifest + factory |

CI (`.github/workflows/ci.yml`) runs `verify` + `check-packables` + changeset presence on every push/PR. Release (`.github/workflows/release.yml`) is changesets + OIDC trusted publishing — no npm token.

## Architecture

- `extensions/index.ts` — entry. Registers the `claude_delegate` tool and the
  `/claude` command, reads `claudeDelegate` config from `~/.pi/agent/settings.json`,
  builds prompts, writes full transcripts, renders the live inspection feed.
  The `delegate()` helper is the shared engine for tool + command.
- `extensions/run-claude.ts` — subprocess runner. Spawns
  `claude -p --output-format stream-json --verbose --include-partial-messages
  --no-session-persistence --permission-mode <mode>`, parses JSONL lines via
  `stream-parse.ts`, calls `onStream` for live text deltas, resolves with the
  final `result` line. `--verbose` is **required** for stream-json — do not drop it.
- `extensions/stream-parse.ts` — pure JSONL parser (text deltas + result
  extraction). Unit-tested; keep it free of IO.
- `extensions/templates.ts` — template discovery + frontmatter parsing.
- `extensions/activity.ts` — live-feed formatters (`formatToolUse`), transcript builder.
- `extensions/command.ts` — pure parser for `/claude` (`--flags` + first-word mode + `--pr`).
- `extensions/progress.ts` — the progress-window overlay (spinner, double-ESC
  cancel, `m` minimize, `dangerous` banner).
- Subcommand UIs live in `extensions/index.ts`: `/claude list` (modes picker),
  `/claude history` (SelectList + scrollable transcript viewer + resume).
- Config surface: `modelAliases` (economy/balanced/max), `maxConcurrent`
  (module-scoped `activeRuns` guard), `maxTranscripts` (`pruneOutputs`).
- ROADMAP.md is the working/tracking doc — keep it in sync.
  Built-ins ship in `templates/*.md`; users add custom templates in
  `~/.pi/agent/claude-delegate/templates/` (global) and
  `<cwd>/.pi/claude-delegate/templates/` (project). Later sources override
  earlier on name collision. `permissionMode` must be one of the six Claude
  `--permission-mode` values; anything else falls back to `acceptEdits`.
- `extensions/usage.ts` — maps Claude usage/cost to pi's `Usage` so delegated
  runs show in pi's footer token/cost stats. `cacheCreationInputTokens` folds
  into `input`.
- Metrics: every run records cost, token breakdown, context % (prompt tokens ÷
  `modelUsage.contextWindow`), canonical model, duration, TTFT — in `details`
  and the transcript. Spend cap resolution: call param → template → config
  `maxBudgetUsd`.

## Conventions

- **2 spaces**, single quotes, 120-col lines — enforced by Biome (`biome.json`: 2 spaces, 120, singleQuote, trailing all). Run `bun run lint:fix` if a diff looks unformatted.
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

## Release process (changesets + OIDC)

Changesets + OIDC trusted publishing. No manual `version` bump, no `npm publish`.

1. Edit code → `bun run verify`.
2. `bun changeset` (or `bun changeset --empty` for docs/CI) → commit `.changeset/*.md`. **Important:** `package.json:files` includes `README.md` (and `templates/`), so even README/docs-only PRs are considered a package change — `ci: Changeset present` (`changeset status --since=origin/main`) will fail without a changeset. For docs-only that should not bump the version, run after `bun install`:

   ```bash
   bun install
   ./node_modules/.bin/changeset add --empty   # creates .changeset/*.md with ---/--- (no bump)
   git add .changeset/*.md && git commit
   ```

   This satisfies CI with `Packages to be bumped:` empty.
3. PR → CI checks `changeset status --since=origin/main`.
4. Merge to `main` → Release workflow opens/updates `chore: version packages` PR (bumps `package.json` + `CHANGELOG.md`).
5. Review version numbers → Merge Version Packages PR → Release workflow runs `bun run verify && node scripts/check-packables.mjs && changeset publish`, creates tag `vX.Y.Z` pinned to `$GITHUB_SHA` + one GitHub Release, verifies `latest` dist-tag.
6. On machines with the package installed: `pi update --extensions`.

Load-test a local change: `pi -e <repo path> -p "Reply with exactly: OK" --no-tools`. Engine can be exercised without pi: `bun --input-type=module -e "import {runClaude} from './extensions/run-claude.ts'; …"`.

Load-test the release guard: `node scripts/check-packables.mjs` — must pass; fails on `0.0.0` or empty `extensions/`/`templates/`.

## Gotchas

- **npm name-similarity guard** forced the scoped name `@yorch/pi-claude-delegate`. Don't rename.
- **Scoped npm packages default to private** → always `--access public` on first publish (OIDC handles it after).
- **Registry metadata lags ~2 min after publish** — tarball is live, `npm view` may 404. Wait.
- **`stream-json` requires `--verbose`** or claude exits 1 with a usage error.
- **`--no-session-persistence`** keeps delegated runs from littering session files; prompt caching (cache_read tokens) still works.
- Peer deps are `"*"` (`pi-ai`, `pi-coding-agent`, `pi-tui`, `typebox`) — pi bundles them; never add to `dependencies`.
- The tarball (`files`) ships `extensions/`, `templates/`, `README.md`, `LICENSE` — tests stay in the repo.
- **Bun for dev, npm for publish.** CI/release use `bun install`/`bun run` everywhere, but `bun run release` calls `changeset publish` which runs `npm publish --provenance` via npm (OIDC). No npm token in repo — `id-token: write` mints it.

## Scope notes

- Do not add a second delegation backend — the design is one runner, pluggable templates.
- Templates are the extension point; prefer adding a template over adding code.
- Claude Code's repo skills (`.claude/skills/`) work automatically via `cwd`; only pin via `skill:` frontmatter when a task demands one.
