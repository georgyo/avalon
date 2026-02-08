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
- `cd firebase/functions && npm run lint` - Lint Firebase functions

### Testing
- `yarn test` - Run E2E flow test (Playwright, headless)
- `yarn test:browser` - Run E2E browser test (Playwright, headed)
- Tests are in `tests/e2e-flow.mjs` and `tests/e2e-browser.mjs`
- Tests use Playwright to simulate a full multiplayer game flow against a running server

### Firebase Deployment
- `firebase deploy` - Deploy Firebase functions
- `firebase emulators:start --only functions` - Run Firebase functions locally

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

This is a **multiplayer Avalon card game** with four main components:

### Common (`/common/`)
- Shared game logic workspace package (`@avalon/common`)
- TypeScript source (`avalonlib.ts`), compiled to CJS in `dist/` via `tsc`
- Used by both server and Firebase functions
- Exports TypeScript types via sub-path exports
- Run `yarn build:common` after editing (automatic in `yarn build`)

### Client (`/client/`)
- Vue 3.5 SPA with Vuetify 3 UI framework
- TypeScript source files in `client/src/`
- Real-time game state via Firebase Firestore listeners
- REST API calls to Express server for game actions
- Build tool: Vite 7, dev proxy to `https://avalon.onl/api`

### Server (`/server/`)
- Express.js REST API server (TypeScript)
- Handles game logic validation and state mutations
- Writes to Firebase Firestore database
- Main files: `server.ts` (entry), `avalon-server.ts` (game logic), `types.ts` (interfaces)
- Uses `tsx` for development and production runtime
- Bundled to single file via esbuild for production (`dist-server/server.js`)

### Firebase (`/firebase/`)
- Firestore database for game state storage
- Cloud Functions for post-game statistics computation
- Authentication and real-time data sync

## Game Logic Structure

**Core Components:**
- **Lobbies** - Player gathering spaces with admin controls
- **Games** - Active game sessions with missions and voting
- **Roles** - Secret character assignments (Merlin, Morgana, etc.)
- **Missions** - 5 missions requiring team proposals and votes

**State Flow:**
1. Players join lobbies via client
2. Game actions sent to Express API endpoints
3. Server validates and updates Firestore
4. Clients receive real-time updates via Firestore listeners
5. Firebase Functions compute stats after game completion

**Key Files:**
- `common/avalonlib.ts` - Core game logic (roles, rules) - shared by server and Firebase
- `client/src/avalon-api-rest.ts` - API client wrapper
- `client/src/components/Game*.vue` - Game interface components
- `client/src/types.ts` - TypeScript type definitions
- `firebase/functions/common/stats.js` - Post-game statistics computation

## Workspace Structure

This is a Yarn 4 workspace with four packages:
- `@avalon/common` - Shared game logic library (TypeScript, compiled to CJS)
- `@avalon/client` - Frontend application (Vue 3 + Vite)
- `@avalon/server` - Backend API (Express.js + TypeScript)
- `functions` - Firebase Cloud Functions

Always use workspace commands from the root directory for consistent dependency management.

## Tech Stack

- **Frontend:** Vue 3.5, Vuetify 3, Vite 7, TypeScript
- **Backend:** Node.js 20, Express 4, Firebase Admin SDK
- **Database:** Firebase Firestore (real-time)
- **Testing:** Playwright (E2E)
- **Build:** Yarn 4 workspaces, esbuild (server bundling), Nix (reproducible builds)
- **Deployment:** Google App Engine (server), Firebase (functions + hosting)
- **Linting:** ESLint 9 with TypeScript and Vue plugins
