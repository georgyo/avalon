# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `yarn start` - Start the relay (GUN relay + `/api/relay-info` + static host) with tsx on :8001
- `yarn workspace @avalon/server serve` - Same, with auto-reload
- `yarn workspace @avalon/client dev` - Start the Vite dev server (proxies `/gun` and `/api` to 127.0.0.1:8001)
- `yarn build` - Build the client for production (output: `server/dist/`)
- `yarn bundle:server` - Bundle the relay into one ESM file with esbuild (`dist-server/server.js`)
- There is no `build:common` step: `@avalon/common` is consumed as TypeScript source

### Linting
- `yarn lint` - ESLint over the whole repo (flat config `eslint.config.mjs`)
- `yarn workspace @avalon/client lint` - Lint client code
- `yarn workspace @avalon/server lint` - Lint + typecheck the server
- `common/crypto` and `common/protocol` (except `driver.ts`, tests and `bench.ts`) ban `Date`, `Math.random`, `Intl`/locale APIs and floating point (protocol code must be deterministic)

### Testing
- `yarn test:unit` - Unit tests: `@avalon/common` (crypto, protocol, simulations), client P2P runtime (`client/src/p2p`), relay (`server/relay.test.ts`); all `node --import tsx --test`
- `yarn test:e2e` - Brings up a throwaway relay (temporary `GUN_DIR`) + vite and runs every `tests/e2e-*.mjs`; `PLAYERS=5..10` runs `e2e-full-game.mjs` once per player count
- `yarn test` / `yarn test:browser` / `yarn test:game` - Single e2e files against an already running stack
- `yarn workspace @avalon/server smoke <relay-url> [seconds]` - Two node GUN clients through a running relay

### Nix Build
- `nix build` - Bundled relay + client assets; runs the relay boot self-test as install check
- `nix build .#container` - Docker image (`GUN_DIR=/data/radata`, `/data` volume)
- `nix flake check` - Runs `checks.unit` (`yarn test:unit`)
- `nix run .#e2e` - E2E suite with a Nix-pinned toolchain (Node + Playwright browsers)
- `nix run .#update-deps` - After any dependency change: regenerates `missing-hashes.json` and the offline-cache hash in `default.nix`

## Architecture

Avalon is **fully peer-to-peer** (specification: `docs/p2p-protocol.md`, normative). There is no
authoritative game server and no database. Every client runs the same deterministic state machine
over an append-only set of signed, content-addressed messages stored in GUN; roles are dealt with
a verifiable shuffle so no party, including the relay, learns secret game state.

### Common (`/common/`) - `@avalon/common`
- Source-only ESM TypeScript, consumed directly by Vite, tsx and the worker bundle (no `dist/`)
- `avalonlib.ts` - roles and rules tables
- `crypto/` - ristretto255 primitives, sigma proofs, shuffle, OT (pure, synchronous)
- `protocol/` - envelopes, rules, lobby reducer, game state machine, projections, the `SeatDriver`
- `testing/` - in-memory transport and seeded simulations
- Relative imports use explicit `.ts` extensions

### Client (`/client/`) - `@avalon/client`
- Vue 3 SPA with Vuetify; components use the `AvalonGame` API of `client/src/avalon.ts`
- `client/src/p2p/` - P2P runtime: GUN instance, subscriptions, reconnect/republish watchdog,
  IndexedDB journal, SEA identity, Web Worker crypto pool, `P2PSession`
- Identities are anonymous per-device SEA key pairs

### Server (`/server/`) - `@avalon/server`
- `server.ts` - Express: static SPA (`dist/`), `GET /api/relay-info` (`{bootId, now}`), `GET /healthz`,
  and the GUN relay on `/gun` (same HTTP server)
- `relay.ts` - `installRelayFilter(gun)` (soul/key/value whitelist, size limits, 50 puts/s per
  connection) and `relaySelfTest()` (throwaway loopback relay proving SEA and the filter work;
  the server exits 1 if it fails)
- `gun-shim.ts` - must be the first import: lets SEA use Node's WebCrypto inside the esbuild bundle
- `bundle.ts` - esbuild options for the single-file bundle; `smoke.ts` - two-client smoke test
- No game logic and no dependency on `@avalon/common`
- Deployment: WebSockets, a persistent writable `GUN_DIR`, exactly one instance

## Workspace Structure

Yarn 4 workspace with three packages:
- `@avalon/common` - Crypto + protocol library (TypeScript source)
- `@avalon/client` - Frontend application (Vue 3 + Vite)
- `@avalon/server` - GUN relay + static host (Express + TypeScript)

Always use workspace commands from the root directory for consistent dependency management. Use
`yarn`, never `npm`.

## Tech Stack

- **Frontend:** Vue 3.5, Vuetify, Vite, TypeScript
- **P2P:** GUN (fork `github:georgyo/gun`) with SEA, IndexedDB, Web Workers, `@noble/curves` (ristretto255, P-256)
- **Relay:** Node.js 22+, Express 5, GUN relay with radisk storage
- **Testing:** `node:test` + tsx (unit), Playwright (E2E)
- **Build:** Yarn 4 workspaces, esbuild (relay bundling), Nix (reproducible builds)
- **Linting:** ESLint (flat config) with TypeScript and Vue plugins
