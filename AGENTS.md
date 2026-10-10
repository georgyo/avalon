# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Repo-Specific Context

### Project Overview
This is a multiplayer Avalon card game played **peer-to-peer**: browsers exchange signed,
content-addressed messages through GUN and run the same deterministic state machine; the server
is only an untrusted GUN relay plus a static host. The normative specification is
`docs/p2p-protocol.md`. The codebase is a Yarn 4 monorepo with three workspace packages:
`common/`, `client/` and `server/`.

### Key Files to Know
- `docs/p2p-protocol.md` - The protocol specification (the contract between packages)
- `common/avalonlib.ts` - Roles and rules tables
- `common/crypto/` - ristretto255 primitives, sigma proofs, shuffle, OT
- `common/protocol/` - Envelopes, rules, lobby reducer, game state machine, projections, `SeatDriver`
- `common/testing/` - In-memory transport and seeded simulations
- `client/src/p2p/` - P2P runtime (`P2PSession`, GUN transport, IndexedDB journal, worker pool)
- `client/src/avalon.ts` - The `AvalonGame` API the Vue components use
- `client/src/components/Game*.vue` - Game UI components
- `server/server.ts` - Express static host, `/api/relay-info` (incl. the public relays clients also dial, `server/peers.ts`, env `GUN_PUBLIC_PEERS`), `/healthz`, GUN relay on `/gun`
- `server/relay.ts` - Relay input filter and boot self-test

### Common Pitfalls
- Use `yarn` commands, not `npm` - this is a Yarn 4 workspace
- `@avalon/common` is source-only TypeScript (no build step); relative imports use `.ts` extensions
- Protocol code (`common/crypto`, `common/protocol`) must be deterministic: no `Date`,
  `Math.random`, `Intl` or floating point (enforced by ESLint; `driver.ts` gets `now()` injected)
- `server/gun-shim.ts` must be imported before `gun/sea` in every server entry point
- In node, `import 'gun'` makes every GUN instance a super peer that never dials out: node test
  clients need `super: false` (and `radisk: false, rfs: false, multicast: false, stats: false`)
- The relay must be a single instance with a persistent writable `GUN_DIR`
- After changing dependencies, run `nix run .#update-deps` (regenerates `missing-hashes.json` and
  the offline-cache hash in `default.nix`) and commit both.

### Verifying Changes
```bash
# Lint (run from root)
yarn lint
yarn workspace @avalon/server lint

# Unit tests (common, client P2P runtime, relay)
yarn test:unit

# Build
yarn build            # Client build
yarn bundle:server    # Relay bundle

# E2E (starts a throwaway relay + vite; PLAYERS=5,10 or 5..10 for the full-game sizes)
PLAYERS=5,10 yarn test:e2e
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/p2p-protocol.md.

<!-- END BEADS INTEGRATION -->
