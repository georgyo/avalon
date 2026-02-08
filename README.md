# Avalon Online

A multiplayer web implementation of **The Resistance: Avalon** board game. Players join lobbies, get assigned secret roles, and compete in teams of Good vs Evil across five missions.

## Tech Stack

- **Client:** Vue 3 + Vuetify 3 + TypeScript (Vite)
- **Server:** Express.js + Firebase Admin SDK
- **Database:** Firebase Firestore (real-time sync)
- **Build:** Yarn 4 workspaces, esbuild, Nix

## Getting Started

### Prerequisites
- Node.js 20+
- Yarn 4 (`corepack enable`)
- Firebase project with Firestore enabled

### Install Dependencies
```bash
yarn install
```

### Development
```bash
# Start the server (with auto-reload)
yarn workspace @avalon/server serve

# Start the client dev server (in another terminal)
cd client && yarn dev
```

The client dev server proxies `/api` requests to `https://avalon.onl` by default. Edit `client/vite.config.js` to point at a local server instead.

### Build for Production
```bash
yarn build            # Build client (output: server/dist/)
yarn bundle:server    # Bundle server to single file (output: dist-server/server.js)
```

### Nix Build
```bash
nix build             # Build bundled package (~17MB)
nix build .#container # Build Docker container image
```

## Deployment

```bash
# Server (Google App Engine)
gcloud app deploy

# Firebase functions
firebase deploy
```

## Project Structure

```
avalon/
  common/           # @avalon/common - Shared game logic (roles, rules)
  client/           # @avalon/client - Vue 3 SPA
  server/           # @avalon/server - Express REST API
  firebase/         # Firebase functions + Firestore rules
  test-flow-v5.mjs  # E2E tests (Playwright)
  flake.nix         # Nix build configuration
```

## Testing

```bash
yarn test           # Run E2E flow test (headless)
yarn test:browser   # Run E2E browser test (headed)
```

## Linting

```bash
yarn workspace @avalon/client lint   # Client
yarn workspace @avalon/server lint   # Server
```
