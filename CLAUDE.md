# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `yarn dev` - Start client development server (from client/ directory)
- `yarn workspace @avalon/server serve` - Start server with nodemon (from root)
- `yarn start` - Start production server (from root)
- `yarn build:common` - Compile common/ TypeScript to dist/ (runs automatically in build/bundle)
- `yarn build` - Build common + client for production (from root)
- `yarn bundle:server` - Build common + bundle server to single file with esbuild (from root)

### Linting
- `yarn workspace @avalon/client lint` - Lint client code
- `yarn workspace @avalon/server lint` - Lint server code

### Testing
- `yarn test` - Run E2E flow test (Playwright, headless)
- `yarn test:browser` - Run E2E browser test (Playwright, headed)
- Tests are in `tests/e2e-flow.mjs` and `tests/e2e-browser.mjs`
- Tests use Playwright to simulate a full multiplayer game flow against a running server

### Server Deployment
- `gcloud app deploy` - Deploy server to Google App Engine

### Nix Build
- `nix build` - Build the Nix package (bundled server + client assets)
- `nix build .#container` - Build a Docker container image
- `nix develop` - Enter development shell with Node.js 20
- The Nix build runs `yarn build` + `yarn bundle:server`, then installs only the bundled output (~17MB vs ~763MB unbundled)

### Admin Functions
- `yarn admin` or `node server/admin.js` - Run administrative functions

## Architecture

This is a **multiplayer Avalon card game** with three main components:

### Common (`/common/`)
- Shared game logic workspace package (`@avalon/common`)
- TypeScript source (`avalonlib.ts`), compiled to CJS in `dist/` via `tsc`
- Used by the server
- Exports TypeScript types via sub-path exports
- Run `yarn build:common` after editing (automatic in `yarn build`)

### Client (`/client/`)
- Vue 3.5 SPA with Vuetify 3 UI framework
- TypeScript source files in `client/src/`
- Real-time game state via SurrealDB live queries
- REST API calls to Express server for game actions
- SurrealDB record-based authentication (anonymous + email/password)
- Build tool: Vite 7, dev proxy to `https://avalon.onl/api`

### Server (`/server/`)
- Express.js REST API server (TypeScript)
- Handles game logic validation and state mutations
- Reads/writes SurrealDB database
- Main files: `server.ts` (entry), `avalon-server.ts` (game logic), `types.ts` (interfaces)
- `surrealdb.ts` - Database connection module
- `stats.ts` - Post-game statistics computation
- `schema.surql` - Database schema definition
- Uses `tsx` for development and production runtime
- Bundled to single file via esbuild for production (`dist-server/server.js`)

## Database (SurrealDB)

The application uses SurrealDB Cloud as its database:
- **URL**: Configured via `SURREAL_URL` env var
- **Auth**: Server connects with root credentials; clients use record-based auth
- **Schema**: Defined in `server/schema.surql`

### Tables
- `user` - Player accounts with stats
- `lobby` - Game lobbies with player lists and game state
- `secret_state` - Hidden game state (roles, votes)
- `player_role` - Per-player role assignments (visible only to owner)
- `game_log` - Completed game records
- `stats` - Global game statistics

### Environment Variables
- `SURREAL_URL` - SurrealDB connection URL
- `SURREAL_NS` - Namespace (default: `avalon`)
- `SURREAL_DB` - Database (default: `avalon`)
- `SURREAL_USER` - Admin username
- `SURREAL_PASS` - Admin password

## Game Logic Structure

**Core Components:**
- **Lobbies** - Player gathering spaces with admin controls
- **Games** - Active game sessions with missions and voting
- **Roles** - Secret character assignments (Merlin, Morgana, etc.)
- **Missions** - 5 missions requiring team proposals and votes

**State Flow:**
1. Players join lobbies via client
2. Game actions sent to Express API endpoints
3. Server validates and updates SurrealDB
4. Clients receive real-time updates via SurrealDB live queries
5. Stats computed inline on game completion

**Key Files:**
- `common/avalonlib.ts` - Core game logic (roles, rules)
- `client/src/avalon-api-rest.ts` - API client wrapper
- `client/src/auth.ts` - SurrealDB record authentication
- `client/src/surrealdb.ts` - Client database connection
- `client/src/components/Game*.vue` - Game interface components
- `client/src/types.ts` - TypeScript type definitions
- `server/stats.ts` - Post-game statistics computation

## Workspace Structure

This is a Yarn 4 workspace with three packages:
- `@avalon/common` - Shared game logic library (TypeScript, compiled to CJS)
- `@avalon/client` - Frontend application (Vue 3 + Vite)
- `@avalon/server` - Backend API (Express.js + TypeScript)

Always use workspace commands from the root directory for consistent dependency management.

## Tech Stack

- **Frontend:** Vue 3.5, Vuetify 3, Vite 7, TypeScript
- **Backend:** Node.js 20, Express 4, SurrealDB SDK
- **Database:** SurrealDB Cloud (real-time via live queries)
- **Testing:** Playwright (E2E)
- **Build:** Yarn 4 workspaces, esbuild (server bundling), Nix (reproducible builds)
- **Deployment:** Google App Engine (server)
- **Linting:** ESLint 9 with TypeScript and Vue plugins
