# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development Commands
- `yarn dev` - Start client development server (from client/ directory)
- `yarn workspace @avalon/server serve` - Start server with nodemon (from root)
- `yarn start` - Start production server (from root)
- `yarn build` - Build client for production (from root)

### Linting
- `yarn workspace @avalon/client lint` - Lint client code
- `yarn workspace @avalon/server lint` - Lint server code
- `cd firebase/functions && npm run lint` - Lint Firebase functions

### Firebase Deployment
- `firebase deploy` - Deploy Firebase functions
- `firebase emulators:start --only functions` - Run Firebase functions locally

### Server Deployment
- `gcloud app deploy` - Deploy server to Google App Engine

### Admin Functions
- `yarn admin` or `node server/admin.js` - Run administrative functions

## Architecture

This is a **multiplayer Avalon card game** with three main components:

### Common (`/common/`)
- Shared game logic workspace package (`@avalon/common`)
- Role definitions and game rules
- Used by both server and Firebase functions
- Main file: `avalonlib.js`

### Client (`/client/`)
- Vue.js 2.7 SPA with Vuetify UI framework
- Real-time game state via Firebase Firestore listeners
- REST API calls to Express server for game actions
- Build tool: Vite

### Server (`/server/`)
- Express.js REST API server
- Handles game logic validation and state mutations
- Writes to Firebase Firestore database
- Main files: `server.js` (entry), `avalon-server.js` (game logic)

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
- `common/avalonlib.js` - Core game logic (roles, rules) - shared by server and Firebase
- `client/src/avalon-api-rest.js` - API client wrapper
- `client/src/components/Game.vue` - Main game interface
- `firebase/functions/common/stats.js` - Post-game statistics computation

## Workspace Structure

This is a Yarn workspace with four packages:
- `@avalon/common` - Shared game logic library
- `@avalon/client` - Frontend application
- `@avalon/server` - Backend API
- `functions` - Firebase Cloud Functions

Always use workspace commands from the root directory for consistent dependency management.