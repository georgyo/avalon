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
This is a multiplayer Avalon card game. The codebase is a Yarn 4 monorepo with four workspace packages: `common/`, `client/`, `server/`, and `firebase/functions/`.

### Key Files to Know
- `common/avalonlib.js` - Core game logic (roles, rules, player counts)
- `server/avalon-server.js` - Server-side game state machine (~24KB, largest file)
- `server/server.js` - Express app entry point and route definitions
- `client/src/types.ts` - TypeScript type definitions for game state
- `client/src/avalon-api-rest.ts` - Client API wrapper (all server calls go through here)
- `client/src/components/Game*.vue` - Game UI components

### Common Pitfalls
- Use `yarn` commands, not `npm` - this is a Yarn 4 workspace
- Client dev server proxies `/api` to `https://avalon.onl` - change `client/vite.config.js` for local dev
- The `common/` package has both `.js` and `.ts` files - the JS files are the runtime, TS files provide types
- Firebase functions use their own `node_modules` - run `cd firebase/functions && npm install` separately
- Server lint is `eslint *.js` (only top-level JS files), client lint covers `src/`

### Verifying Changes
```bash
# Lint (run from root)
yarn workspace @avalon/client lint
yarn workspace @avalon/server lint

# Build
yarn build            # Client build
yarn bundle:server    # Server bundle

# Test (requires a running server)
yarn test             # E2E flow test
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
