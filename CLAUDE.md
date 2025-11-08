# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `yarn dev` - Start client development server (from client/ directory, auto-opens browser)
- `yarn workspace @avalon/server serve` - Start server with nodemon (from root)
- `yarn start` - Start production server (from root)
- `yarn build` - Build client for production (from root)

**Development Workflow:**
For local development, run both:
```bash
# Terminal 1: Start the API server
yarn workspace @avalon/server serve

# Terminal 2: Start the Vite dev server (proxies /api to server)
yarn dev
```

### Linting
- `yarn workspace @avalon/client lint` - Lint and auto-fix client code
- `yarn workspace @avalon/server lint` - Lint server code
- `cd firebase/functions && npm run lint` - Lint Firebase functions

**Linting is configured with:**
- ESLint 9 with flat config format
- Vue plugin with recommended rules
- TypeScript ESLint for `.ts` and `.vue` files
- Vite plugin shows errors in browser during development

### Firebase Deployment
- `firebase deploy` - Deploy Firebase functions
- `firebase emulators:start --only functions` - Run Firebase functions locally

### Server Deployment
- `gcloud app deploy` - Deploy server to Google App Engine

### Admin Functions
- `yarn admin` or `node server/admin.js` - Run administrative functions

## Architecture

This is a **multiplayer Avalon card game** with three main components:

### Client (`/client/`)
- **Vue 3.5** SPA with **Vuetify 3.7** UI framework
- **TypeScript** for type safety
- Real-time game state via Firebase Firestore listeners
- REST API calls to Express server for game actions
- Build tool: **Vite 5.4**
- Module type: ESM (`"type": "module"` in package.json)

**Icon Systems:**
- FontAwesome for game icons (syntax: `<v-icon icon="fa:fas fa-crown"></v-icon>`)
- Material Design Icons for UI (syntax: `<v-icon icon="star"></v-icon>`)

**Bundle Optimization:**
- Code-split into chunks: main (345KB), vuetify, vuetify-components, fontawesome, firebase
- Source maps enabled for debugging app code
- Dependencies pre-bundled without source maps to reduce warnings

### Server (`/server/`)
- **Express.js 5.1** REST API server
- Handles game logic validation and state mutations
- **Authentication**: Verifies Firebase ID tokens (requires `X-Avalon-Auth` header)
- **Authorization**: Validates user permissions and game state
- Writes to Firebase Firestore database using **Firebase Admin SDK**
- Main files: `server.js` (entry), `avalon-server.js` (game logic)

**Security Note:**
- Server must remain separate from client (cannot move to Vite)
- Contains Firebase Admin credentials that must stay server-side
- Prevents cheating by validating all game actions server-side

### Firebase (`/firebase/`)
- **Firestore** database for game state storage
- **Cloud Functions** for post-game statistics computation
- **Authentication** and real-time data sync
- Functions: `onLogCreate` triggers after games to compute player stats

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
- `server/common/avalonlib.cjs` - Core game logic (roles, rules)
- `firebase/functions/common/avalonlib.js` - Shared game utilities
- `client/src/avalon-api-rest.js` - API client wrapper
- `client/src/components/Game.vue` - Main game interface

## Workspace Structure

This is a **Yarn 4.9.1** workspace with three packages:
- `@avalon/client` - Frontend application (Vue 3 + Vite + TypeScript)
- `@avalon/server` - Backend API (Express + Firebase Admin)
- `functions` - Firebase Cloud Functions (post-game stats)

**Package Manager:** Yarn 4 with Plug'n'Play (PnP)

Always use workspace commands from the root directory for consistent dependency management.

## Code Standards

### Vue Components
- **Composition API**: Prefer `<script setup>` for new components
- **Options API**: Only `RoleList.vue` and `MissionSummaryTable.vue` still use this (legacy)
- **TypeScript**: Use `<script setup lang="ts">` when types are needed
- **Props**: Always define types and defaults/required flag

```vue
<!-- Good -->
<script setup lang="ts">
const props = defineProps({
  playerList: {
    type: Array as PropType<string[]>,
    default: () => []
  }
})
</script>
```

### Icons
- **FontAwesome**: Use `fa:` prefix → `icon="fa:fas fa-crown"`
- **Material Design**: No prefix → `icon="star"`
- **Deprecated attributes**:
  - ❌ `small` → ✅ `size="small"`
  - ❌ `left` → ✅ `start`
  - ❌ `@keyup.native` → ✅ `@keyup`
  - ❌ `slot="activator"` → ✅ `v-slot:activator`

### Linting
- ESLint runs automatically in dev mode (shows errors in browser)
- Auto-fix on save if IDE configured
- TypeScript strict mode for `.ts` and `.vue` files
- Unused vars allowed if prefixed with `_`

### File Organization
```
client/src/
├── components/     # Vue components
├── stores/         # Pinia stores
├── plugins/        # Vuetify, router config
├── lib/            # Shared utilities
└── main.ts         # App entry point
```

## Vite Configuration

### Dev Server
- Auto-opens browser on start
- HMR overlay shows errors
- Proxies `/api/*` to Express server (https://avalon.onl in dev)

### Build
- Source maps enabled for debugging
- Code splitting by library (vuetify, firebase, fontawesome)
- Output in `dist/` directory

### Environment
- Use `.env` files for configuration
- Access with `import.meta.env.VITE_*` variables