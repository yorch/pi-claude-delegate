# Contributing

Development and release notes for `@yorch/pi-claude-delegate`.

> **Deprecated — new work goes to `pi-harness-delegate`.** This repo receives toolchain updates (Bun/Node 26/Biome/changesets) for compatibility.

## Prerequisites

- Node.js 26
- Bun 1.3.14 (`curl -fsSL https://bun.sh/install | bash`)
- `npm` account with access to the `@yorch` scope (for local first publish; CI uses OIDC)
- [pi coding agent](https://github.com/badlogic/pi-mono) installed (for local load-testing)
- `claude` CLI on PATH (for live engine tests)

## Setup

```bash
bun install
```

## Checks

```bash
bun run lint        # biome check .
bun run typecheck   # tsc --noEmit
bun test            # bun:test, 14 tests
bun run verify      # lint + typecheck + test (CI and release gate)
```

CI runs all of the above on every push and pull request (`.github/workflows/ci.yml`). PRs that touch the package must include a changeset (`bunx changeset`).

## Project layout

```text
biome.json             # Biome config: 2 spaces, 120 cols, single quotes
.changeset/            # changesets config + release notes
  config.json
  README.md
scripts/
  check-packables.mjs  # guard: refuses 0.0.0 or empty tarball (checks extensions/ + templates/)
extensions/            # the pi extension
  index.ts             # entry: tool + /claude command
  run-claude.ts        # spawns `claude`, streams JSONL, resolves the result
  stream-parse.ts      # pure JSONL parser (unit-tested)
  templates.ts         # frontmatter parsing + template discovery
  usage.ts             # Claude usage/cost → pi Usage
templates/             # built-in modes: review, plan, implement, security-audit, docs, general
tests/                 # unit tests (bun:test)
docs/                  # GitHub Pages landing page (served from main /docs)
package.json           # pi package manifest (pi.extensions, pi.image, pi-package keyword)
.github/workflows/
  ci.yml               # verify + changeset status
  release.yml          # OIDC publish + tag + GitHub Release + dist-tag check
```

## Releasing a new version

Releases are changesets-driven with OIDC trusted publishing (see `repo-release-process.md`).

```bash
# 1. Create a changeset in your PR
bunx changeset
#   pick patch/minor/major, write notes for CHANGELOG.md (for the upgrader)
#   commit .changeset/*.md

# 2. PR checks must pass: verify + changeset status

# 3. Merge PR to main → Release workflow opens/updates
#    PR `chore: version packages` (version bump + CHANGELOG.md)

# 4. Review version numbers (last cheap checkpoint), merge Version Packages PR
#    → Release workflow runs `bun run verify` → `bun run release` publishes
#      to npm via OIDC (no token), creates tag vX.Y.Z + GitHub Release,
#      verifies `latest` dist-tag

# 5. Update the installed copy on machines that already have it
pi update --extensions
```

Conventions: Conventional Commits for PR titles, every PR touching the package needs a changeset (`bunx changeset add --empty` for no-user-visible changes). **Note:** `package.json:files` includes `README.md`, so even README-only PRs need a changeset — use `bun install` + `./node_modules/.bin/changeset add --empty` for docs-only.

### Testing without pi

The engine runs standalone:

```bash
bun --input-type=module -e "
import { runClaude } from './extensions/run-claude.ts';
const r = await runClaude({ prompt: 'Say hi', cwd: process.cwd(), permissionMode: 'plan', model: 'sonnet' });
console.log(r.result);
"
```

Load-test in pi:

```bash
pi -e /path/to/pi-claude-delegate -p "Reply with exactly: OK" --no-tools
```

## Release guard rails

- `scripts/check-packables.mjs` refuses `0.0.0` and empty tarball (checks `extensions/` and `templates/`).
- `release.yml` is pinned by SHA (`changesets/action@8488615a623b1b9c987934bb89eae8af6a946ac1 # v2.1.1`), `id-token: write` for OIDC, `--target $GITHUB_SHA` for tags, and polls `latest` dist-tag.

## License

MIT — see `LICENSE`.
