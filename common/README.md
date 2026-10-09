# @avalon/common

Shared game rules, cryptography and the peer-to-peer protocol of Avalon
(specification: [`docs/p2p-protocol.md`](../docs/p2p-protocol.md)).

## Overview

`@avalon/common` is a **source-only ESM TypeScript package**: Vite (client and
Web Worker), tsx (tests, simulations) and the browser consume `.ts` files
directly. There is no `dist/` and no build step. Relative imports inside the
package use explicit `.ts` extensions.

It is used by:
- the client (`@avalon/client`): the P2P runtime in `client/src/p2p/` and the
  crypto worker run the protocol in every browser;
- the tests and in-process simulations (`node --import tsx --test`).

The relay (`@avalon/server`) does **not** depend on it: it has no game logic.

## Entry points

| Import | Contents |
|---|---|
| `@avalon/common` | `avalonlib.ts` and `crypto/index.ts` re-exported |
| `@avalon/common/avalonlib` | `ROLES`, `getNumEvilForGameSize(n)`, `Role` |
| `@avalon/common/crypto` | ristretto255 group and codecs, deterministic secret derivation, the sigma-proof engine, ElGamal, card points, the verifiable shuffle, the 1-of-R oblivious transfer (§2, §5.3-5.5) |
| `@avalon/common/protocol` | envelope types and codec, rules (`deriveDeck`, `seen`, `RULES_HASH`), lobby reducer and `LobbyDriver`, the game state machine (`reduceGame`), proving/verification jobs, outcomes, projections to the UI shapes, the `SeatDriver`, local stats (§3-§6) |
| `@avalon/common/testing` | `MemoryTransport`, seeded simulations and adversaries, `legacyAssignRoles` for golden tests |

## Determinism

`crypto/` and `protocol/` are pure: no `Date`, `Math.random`, `Intl`/locale
APIs or floating point (ESLint enforces it). The only exception is
`protocol/driver.ts`, which receives `now()` by injection. Randomness comes from
`crypto.getRandomValues` or from the deterministic derivation of §2.5.

## Commands

```bash
yarn workspace @avalon/common test        # unit tests and simulations
yarn workspace @avalon/common typecheck   # tsc --noEmit
yarn workspace @avalon/common bench       # crypto benchmarks
```

## Usage

```ts
import avalonLib from '@avalon/common/avalonlib';

avalonLib.ROLES;                     // all role definitions
avalonLib.getNumEvilForGameSize(7);  // 3
```
