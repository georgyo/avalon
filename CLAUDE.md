# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `yarn dev` - Start client development server (from client/ directory)
- `yarn build:common` - Compile common/ TypeScript to dist/ (runs automatically in build)
- `yarn build` - Build common + client for production (from root)
- `yarn apply-schema` - Apply SurrealDB schema (requires .env with credentials)

### Linting
- `yarn workspace @avalon/client lint` - Lint client code

### Testing
- `yarn test` - Run E2E flow test (Playwright, headless)
- `yarn test:browser` - Run E2E browser test (Playwright, headed)
- `yarn test:game` - Run full game E2E test (Playwright)
- Tests are in `tests/e2e-flow.mjs`, `tests/e2e-browser.mjs`, and `tests/e2e-full-game.mjs`
- Tests use Playwright to simulate a full multiplayer game flow (client + SurrealDB only, no Express server)

### Nix Build
- `nix build` - Build the Nix package (client assets + schema)
- `nix build .#container` - Build a Docker container image
- `nix develop` - Enter development shell with Node.js 20

### Admin Functions
- `yarn admin` - Run administrative functions

## Architecture

This is a **multiplayer Avalon card game** with a serverless architecture. All game logic runs as SurrealDB `DEFINE FUNCTION` statements, exposed as HTTP REST endpoints via `DEFINE API` and called from the client via `fetch()`.

### Common (`/common/`)
- Shared game logic workspace package (`@avalon/common`)
- TypeScript source (`avalonlib.ts`), compiled to CJS in `dist/` via `tsc`
- Role definitions used by both client display and SurrealDB functions
- Run `yarn build:common` after editing (automatic in `yarn build`)

### Client (`/client/`)
- Vue 3.5 SPA with Vuetify 3 UI framework
- TypeScript source files in `client/src/`
- Real-time game state via SurrealDB live queries
- Game actions via HTTP REST endpoints (`DEFINE API`) — no Express server
- SurrealDB record-based authentication (anonymous + email/password)
- Build tool: Vite 7

### Server (`/server/`)
- No longer an Express server — contains only schema and admin tools
- `schema.surql` - Complete database schema with game logic as `DEFINE FUNCTION` + `DEFINE API` endpoints
- `apply-schema.mjs` - Script to apply schema to SurrealDB
- `admin.ts` - Administrative functions (export logs, cleanup, recompute stats)

## Database (SurrealDB)

The application uses SurrealDB Cloud as its database. Game logic runs inside `DEFINE FUNCTION` statements, exposed as HTTP REST endpoints via `DEFINE API` in the schema.

- **URL**: Configured via `SURREAL_URL` env var
- **Auth**: Clients use record-based auth; admin tools use root credentials
- **Schema**: Defined in `server/schema.surql`
- **Security**: Write permissions are FULL (functions run as caller); SELECT permissions are restrictive. Clients should be prevented from arbitrary queries via `--deny-arbitrary-query`.

### Tables
- `user` - Player accounts with stats (SELECT: own record only)
- `lobby` - Game lobbies with player lists and game state (SELECT: members only)
- `secret_state` - Hidden game state: roles, votes (SELECT: FULL — relies on deny-arbitrary-query)
- `player_role` - Per-player role assignments (SELECT: own record only)
- `game_log` - Completed game records (SELECT: FULL)
- `stats` - Global game statistics (SELECT: FULL)

### Game Functions (called by clients via HTTP `DEFINE API` endpoints)
- `fn::login` - Update lastActive, clean stale lobby refs
- `fn::create_lobby` - Create a new lobby with random 3-char ID
- `fn::join_lobby` - Join an existing lobby
- `fn::leave_lobby` - Leave lobby, cancel active game, admin handoff
- `fn::kick_player` - Admin kicks a player
- `fn::start_game` - Assign roles, create missions, start game
- `fn::cancel_game` - Cancel active game
- `fn::propose_team` - Propose a team for a mission
- `fn::vote_team` - Vote on a team proposal
- `fn::do_mission` - Vote success/fail on a mission
- `fn::assassinate` - Assassinate a player (assassin only)

### Helper Functions (called by game functions)
- `fn::roles` - Returns ROLES array (mirrors common/avalonlib.ts)
- `fn::num_evil` - Evil count per player count
- `fn::validate_name` - Name validation
- `fn::make_missions` - Mission setup with team sizes
- `fn::proposal_template` - Next proposal (round-robin proposer)
- `fn::assign_roles` - Shuffle players, assign roles, compute visibility
- `fn::end_game` - End game: cleanup, create log, update stats
- `fn::compute_and_combine_stats` - Update global and per-user stats

### Environment Variables
- `SURREAL_URL` - SurrealDB connection URL
- `SURREAL_NS` - Namespace (default: `avalon`)
- `SURREAL_DB` - Database (default: `avalon`)
- `SURREAL_USER` - Admin username (for schema apply and admin tools)
- `SURREAL_PASS` - Admin password

## Game Logic Structure

**Core Components:**
- **Lobbies** - Player gathering spaces with admin controls
- **Games** - Active game sessions with missions and voting
- **Roles** - Secret character assignments (Merlin, Morgana, etc.)
- **Missions** - 5 missions requiring team proposals and votes

**State Flow:**
1. Players join lobbies via client
2. Game actions call SurrealDB `DEFINE API` endpoints via HTTP `fetch()`
3. Functions validate and update database records transactionally
4. Clients receive real-time updates via SurrealDB live queries
5. Stats computed inline on game completion (inside `fn::end_game`)

**Key Files:**
- `server/schema.surql` - All game logic as SurrealDB functions
- `common/avalonlib.ts` - Role definitions (duplicated in `fn::roles()`)
- `client/src/avalon-api-rest.ts` - Client API wrapper using HTTP `fetch()` to `DEFINE API` endpoints
- `client/src/avalon.ts` - Game state management and lobby subscriptions
- `client/src/auth.ts` - SurrealDB record authentication
- `client/src/surrealdb.ts` - Client database connection
- `client/src/components/Game*.vue` - Game interface components
- `client/src/types.ts` - TypeScript type definitions

## Workspace Structure

This is a Yarn 4 workspace with three packages:
- `@avalon/common` - Shared game logic library (TypeScript, compiled to CJS)
- `@avalon/client` - Frontend application (Vue 3 + Vite)
- `@avalon/server` - Schema and admin tools (no longer an Express server)

Always use workspace commands from the root directory for consistent dependency management.

## Tech Stack

- **Frontend:** Vue 3.5, Vuetify 3, Vite 7, TypeScript
- **Backend:** SurrealDB Cloud (DEFINE FUNCTION + DEFINE API for all game logic)
- **Database:** SurrealDB Cloud (real-time via live queries)
- **Testing:** Playwright (E2E)
- **Build:** Yarn 4 workspaces, Nix (reproducible builds)
- **Linting:** ESLint 9 with TypeScript and Vue plugins
