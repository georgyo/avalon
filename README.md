# Avalon Online

A multiplayer web implementation of **The Resistance: Avalon** board game. Players join lobbies, get assigned secret roles, and compete in teams of Good vs Evil across five missions.

The game is **fully peer-to-peer**: every browser runs the same deterministic state machine over signed, content-addressed messages exchanged through [GUN](https://github.com/georgyo/gun). Roles are dealt with a verifiable mental-poker shuffle, so nobody (not even the server) learns anything they should not know until the game is over. The server is an untrusted GUN relay plus a static file host; it holds no game logic and no secret. The normative specification is [`docs/p2p-protocol.md`](docs/p2p-protocol.md).

## Tech Stack

- **Client:** Vue 3 + Vuetify + TypeScript (Vite); P2P runtime in `client/src/p2p/` (GUN, IndexedDB, Web Worker crypto)
- **Protocol:** `@avalon/common` - source-only TypeScript: ristretto255 crypto (`@noble/curves`), protocol state machine, simulations
- **Server:** Express static host + GUN relay (SEA, input filter, boot self-test) in `server/`
- **Identity:** anonymous per-device SEA key pairs (no accounts, no email)
- **Build:** Yarn 4 workspaces, esbuild (single-file relay bundle), Nix

## Getting Started

### Prerequisites
- Node.js 22+
- Yarn 4 (`corepack enable`)

### Install Dependencies
```bash
yarn install
```

### Development
```bash
# Start the relay on :8001 (GUN relay + /api/relay-info, data in server/radata:
# Yarn runs workspace scripts in server/)
yarn start

# Start the client dev server (in another terminal); it proxies /gun
# (websocket) and /api to the relay on 127.0.0.1:8001
yarn workspace @avalon/client dev
```

Relay environment variables: `PORT` (default 8001), `HOST` (bind address), `GUN_DIR` (radisk directory, default `./radata` relative to the working directory, i.e. `server/radata` under `yarn start`; must be writable and persistent), `STATIC_DIR` (default: `dist/` next to the server file), `TRUST_PROXY=1` (behind a reverse proxy: the relay's per-IP limits use the last `X-Forwarded-For` entry; without it, loopback and private client addresses are exempt from them), `GUN_PUBLIC_PEERS` (public community GUN relays the clients also dial, comma separated; unset gives the default list in `server/peers.ts`, `none` turns public relays off).

Clients connect to this relay **and** to the public relays it advertises in `/api/relay-info`, so a game keeps going while this relay is down. Public relays are untrusted like this one (every message is signed and content-addressed) but their operators see the public game data and the players' IP addresses; see `docs/p2p-protocol.md` §7.1.

The relay serves the SPA's content-hashed `/assets/*` with a one-year immutable cache and `index.html` with `no-cache`, brotli- or gzip-compressed when the browser accepts it.

### Build for Production
```bash
yarn build            # Build the client (output: server/dist/)
yarn bundle:server    # Bundle the relay to one file (output: dist-server/server.js)
```

The bundle runs anywhere with Node (no `node_modules`) and serves `dist/` next to itself.
Before listening it runs a boot self-test against a throwaway loopback relay (SEA rejects
forged and overwritten writes, the filter rejects non-whitelisted data) and exits with
status 1 if anything fails.

### Nix Build
```bash
nix build             # Bundled relay + client (runs the relay self-test as install check)
nix build .#container # Docker image (GUN_DIR=/data/radata on the /data volume)
nix flake check       # Unit tests (checks.unit)
nix run .#e2e         # Playwright e2e suite against a throwaway local stack
nix run .#update-deps # After changing dependencies: regenerate missing-hashes.json + offline cache hash
```

`nix build` and `nix flake check` also run `yarn lint` and `yarn typecheck` (tsc for common and
server, vue-tsc for the client and its `.vue` files).

## Deployment

The relay needs WebSockets, a persistent writable disk and **exactly one instance**
(a VM, or Cloud Run with min = max = 1 instances, session affinity and a volume).
App Engine standard is not supported (no WebSockets).

```bash
docker build -t avalon .
docker run -p 8001:8001 -v avalon-data:/data avalon
```

The relay is a cache: clients republish their messages after a relay restart, even
with an empty disk. Optionally prune `avalon/v1/game/*` souls older than 30 days and
restart the relay weekly to bound memory.

## Project Structure

```
avalon/
  common/           # @avalon/common - crypto, protocol state machine, rules, simulations (source-only TS)
  client/           # @avalon/client - Vue 3 SPA + P2P runtime (client/src/p2p)
  server/           # @avalon/server - GUN relay + static host (relay.ts, server.ts, gun-shim.ts)
  docs/             # p2p-protocol.md: the normative protocol specification
  tests/            # E2E tests (Playwright) and the local stack runner
  flake.nix         # Nix build configuration
```

## Testing

```bash
yarn test:unit      # Unit tests: common (crypto, protocol, simulations), client P2P runtime, relay
yarn test:e2e       # Playwright e2e suite against a throwaway relay + vite (PLAYERS=5..10 for all sizes)
yarn test           # E2E flow test only (needs a running stack)
yarn test:browser   # E2E browser test (headless Firefox by default; HEADLESS=0 to watch)

# Relay smoke test: two node GUN clients through a running relay for 60 s
yarn workspace @avalon/server smoke http://127.0.0.1:8001 60
```

`yarn test:unit` takes about 10 minutes on 4 cores (every simulated game proves for real). Slow
extras: `AVALON_SLOW_TESTS=1` (full crypto sweep, ~25 min) and `AVALON_SIM_FULL=1` (all 384
role/size simulations, ~30 min).

The e2e files can also run one at a time against any running stack, e.g. the production build
served by the relay itself:

```bash
yarn build && yarn start                                    # relay + built client on :8001
BASE_URL=http://127.0.0.1:8001/ PLAYERS=10 node tests/e2e-full-game.mjs
BASE_URL=http://127.0.0.1:8001/ node tests/e2e-cancel.mjs    # also e2e-reload, e2e-offline, e2e-two-tabs, ...
```

E2E environment variables: `BASE_URL` (default `http://localhost:5173/`), `BROWSER`
(`chromium`/`firefox`), `CHROMIUM_PATH` (else Playwright's own, or one found under
`PLAYWRIGHT_BROWSERS_PATH` / `/opt/pw-browsers`), `HEADLESS=0`, `RNG_SEED` (replay a run),
`EVIL_FAIL_RATE=0` (good wins three missions, so the game reaches the assassination),
`ENFORCE_PERF=1` (fail when a full game's setup exceeds `SETUP_BUDGET_MS`, default 15000).

## Linting

```bash
yarn lint                            # Everything (ESLint flat config at the root)
yarn workspace @avalon/client lint   # Client
yarn workspace @avalon/server lint   # Server (ESLint + tsc)
```
