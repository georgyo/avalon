# @avalon/common

Shared game logic for the Avalon project.

## Overview

This package contains game rules, role definitions, and other shared logic used by both:
- Server (`@avalon/server`) - Express.js backend
- Firebase Functions (`functions`) - Cloud Functions for stats computation

## Contents

- **avalonlib.js / avalonlib.ts** - Core Avalon game logic
  - `ROLES` - Array of all role definitions (Merlin, Morgana, etc.)
  - `getNumEvilForGameSize(numPlayers)` - Returns evil player count for a given game size

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

Previously, this code was duplicated in:
- `server/common/avalonlib.cjs`
- `firebase/functions/common/avalonlib.js`

The code is now consolidated into a single workspace package to maintain a single source of truth.
