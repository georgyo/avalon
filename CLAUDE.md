# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `yarn dev` - Start client development server (from client/ directory)
- `yarn build:common` - Compile common/ TypeScript to dist/ (runs automatically in build/bundle)
- `yarn build` - Build common + client for production (from root)

### Linting
- `yarn workspace @avalon/client lint` - Lint client code

### Testing
- `yarn test` - Run E2E flow test (Playwright, headless)
- `yarn test:browser` - Run E2E browser test (Playwright, headed)
- `yarn test:game` - Run full multiplayer game E2E test (Playwright, headless)
- Tests are in `tests/e2e-flow.mjs`, `tests/e2e-browser.mjs`, and `tests/e2e-full-game.mjs`
- Tests use Playwright to simulate a full multiplayer game flow

### Nix Build
- `nix build` - Build the Nix package
- `nix build .#container` - Build a Docker container image
- `nix develop` - Enter development shell with Node.js 20

### SurrealDB Schema
- Schema is defined in `surreal/schema.surql`
- Apply via HTTP: `curl -X POST 'https://surreal.fu.io/sql' -u user:pass -H 'Surreal-NS: avalon' -H 'Surreal-DB: avalon' --data-binary @surreal/schema.surql`
- Namespace: `avalon`, Database: `avalon`

## Architecture

This is a **multiplayer Avalon card game** with three main components:

### Common (`/common/`)
- Shared game logic workspace package (`@avalon/common`)
- TypeScript source (`avalonlib.ts`), compiled to CJS in `dist/` via `tsc`
- Exports role definitions, game size rules, and TypeScript types
- Run `yarn build:common` after editing (automatic in `yarn build`)

### Client (`/client/`)
- Vue 3.5 SPA with Vuetify 3 UI framework
- TypeScript source files in `client/src/`
- Connects directly to SurrealDB via WebSocket (no backend server needed)
- Real-time game state via SurrealDB LIVE SELECT with polling fallback
- Game actions via SurrealDB DEFINE API endpoints (`db.api().post()`)
- Anonymous auth via SurrealDB record access (signup creates a user record)
- Build tool: Vite 8
- Uses `markRaw()` to prevent Vue proxy from breaking SurrealDB SDK private fields
- Uses `jsonify()` to convert SurrealDB types (RecordId) to plain objects for Vue reactivity

### SurrealDB (`/surreal/`)
- `schema.surql` defines the complete backend: tables, fields, functions, and API endpoints
- Replaces the previous Express server + Firebase stack
- 6 tables: `user`, `lobby`, `player_role`, `secret_state`, `game_log`, `global_stats`
- 5 helper functions: `fn::assign_roles`, `fn::make_missions`, `fn::end_game`, `fn::proposal_template`, `fn::array_set`
- 11 API endpoints: login, createLobby, joinLobby, leaveLobby, kickPlayer, startGame, cancelGame, proposeTeam, voteTeam, doMission, assassinate
- DEFINE API THEN blocks run as the record user (not system), so table permissions must allow CUD for authenticated users
- `secret_state` SELECT is restricted to users in the matching lobby

## Game Logic Structure

**Core Components:**
- **Lobbies** - Player gathering spaces with admin controls
- **Games** - Active game sessions with missions and voting
- **Roles** - Secret character assignments (Merlin, Morgana, etc.)
- **Missions** - 5 missions requiring team proposals and votes

**State Flow:**
1. Players sign up anonymously via SurrealDB record access
2. Players join lobbies via client (calls DEFINE API endpoints)
3. API endpoints validate and update SurrealDB tables
4. Clients receive real-time updates via LIVE SELECT + polling
5. Stats computed inline at game end within the API endpoint

**Key Files:**
- `common/avalonlib.ts` - Core game logic (roles, rules)
- `surreal/schema.surql` - Complete backend schema and API endpoints
- `client/src/avalon.ts` - Main game engine (SurrealDB connection, live queries, game state)
- `client/src/avalon-api-surreal.ts` - API client wrapper (calls SurrealDB DEFINE API endpoints)
- `client/src/surreal-config.ts` - SurrealDB connection configuration
- `client/src/components/Game*.vue` - Game interface components
- `client/src/types.ts` - TypeScript type definitions

## Workspace Structure

This is a Yarn 4 workspace with four packages:
- `@avalon/common` - Shared game logic library (TypeScript, compiled to CJS)
- `@avalon/client` - Frontend application (Vue 3 + Vite)
- `@avalon/server` - Legacy Express server (to be removed)
- `functions` - Legacy Firebase Cloud Functions (to be removed)

Always use workspace commands from the root directory for consistent dependency management.

## Tech Stack

- **Frontend:** Vue 3.5, Vuetify 3, Vite 8, TypeScript
- **Backend:** SurrealDB with DEFINE API (no separate server)
- **Database:** SurrealDB (real-time via LIVE SELECT)
- **Auth:** SurrealDB anonymous record access
- **Testing:** Playwright (E2E)
- **Build:** Yarn 4 workspaces, Nix (reproducible builds)
- **Linting:** ESLint 10 with TypeScript and Vue plugins
