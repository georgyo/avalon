# @avalon/common

Shared game logic for the Avalon project.

## Overview

This package contains game rules, role definitions, and other shared logic used by:
- Server (`@avalon/server`) - Express.js backend

## Contents

- **avalonlib.ts** - Core Avalon game logic
  - `ROLES` - Array of all role definitions (Merlin, Morgana, etc.)
  - `getNumEvilForGameSize(numPlayers)` - Returns evil player count for a given game size
  - `Role` - TypeScript interface for role objects

## Building

The TypeScript source is compiled to CJS in `dist/` for Node.js consumers:

```bash
yarn workspace @avalon/common build
```

This runs automatically as part of `yarn build` and `yarn bundle:server`.

## Usage

```javascript
import avalonLib from '@avalon/common';

// Access roles
console.log(avalonLib.ROLES); // Array of 8 role objects

// Get evil count for game size
const evilCount = avalonLib.getNumEvilForGameSize(7); // Returns 3
```

Sub-path import for just the game library:
```javascript
import avalonLib from '@avalon/common/avalonlib';
```

TypeScript types are included via the `exports` field in `package.json`.

## History

Previously, this code was duplicated across the server and cloud functions. It is now consolidated into a single workspace package.
