# Avalon over GUN: peer-to-peer protocol specification

Status: **final, v1** (protocol identifier `avalon-p2p/v1`). This document is
normative. "MUST", "MUST NOT", "SHOULD" and "MAY" have their RFC 2119 meaning.
It replaces the draft that went through adversarial review (privacy,
cheating, consistency and implementation lenses); Appendix A lists every
review finding and how it was resolved.

Branch `gun-p2p` replaces Firebase (Auth, Firestore, Cloud Functions) and the
authoritative Express game server with a fully peer-to-peer design. The
user's requirement is:

> Players in a lobby know all their information, but not the information
> they should not know until the game is over.

**No party, including the relay server, ever holds secret game state.** Every
client runs the same deterministic state machine over an append-only set of
signed, content-addressed messages stored in GUN (the user's TypeScript fork,
dependency `gun` from `github:georgyo/gun`). The server becomes an untrusted
GUN relay plus a static file host. Identities are anonymous per-device SEA key
pairs. Old Firestore data is not migrated.

Contents

1. Goals and threat model
2. Cryptographic foundations (encodings, group, hashing, secret derivation, the sigma-proof engine)
3. Messages, storage and ordering (GUN graph, envelopes, signing, step chain, conflict and cancel rules, persistence, recovery)
4. Lobby lifecycle
5. Game protocol (setup, dealing, sight exchange, proposals, missions, assassination, end, audit)
6. Logs and stats
7. Client runtime (GUN configuration, subscriptions, reconnect, clock, presence, timeouts, UI states)
8. Relay server and deployment
9. Metadata hygiene
10. Security properties
11. Module architecture
12. Test plan
13. Work plan
- Appendix A: review findings disposition
- Appendix B: constants

### Protocol at a glance

```
Lobby:  lobby.create → lobby.roster (seq 1) ← lobby.join … (admin admits/rejects via new rosters) → lobby.config
Setup:  key (all seats) → shuf/0 … shuf/n-1 (each seat in order, pipelined) → deal (all) → otR (all) → otS (all, reveals beacon seeds)
Play:   per proposal:  p/m/p (proposer) → vc/m/p (all, human) → vr/m/p (all, automatic)
        if approved:   mv/m (team, human) → mt/m (all, automatic)
        3 successes and MERLIN in play: as (assassin)
End:    terminal outcome (natural, cancel or invalid) → reveal (all) → outcome, audit, local stats, log
```

Everything is an immutable signed message in a content-addressed GUN soul;
the game state is a pure function of the message set (§3).

---

## 1. Goals and threat model

### 1.1 Information flow (what must hold)

| Information | Who may know it during the game | How it is enforced |
|---|---|---|
| Lobby membership, seat order, roles in play, options | everyone in the lobby (and anyone who knows the lobby code) | public, admin-signed roster/config |
| Own role and the assassin flag | the player only | card dealt under the player's own ElGamal key (§5.4) |
| "Sees" list (`ROLES[r].sees`, by role **name** only) | the player only | verifiable 1-of-R oblivious transfer (§5.5) |
| Team proposals | everyone | public signed message |
| Who has voted on a proposal / on a mission | everyone (as today: `proposal.votes`, `mission.team` fill up as people vote) | public messages |
| Proposal approve/reject votes | nobody until all `n` seats have committed; then everyone | hash commit-reveal (§5.8) |
| Mission success/fail votes | only the number of fails, once every team member voted; individual votes after the game | exponential ElGamal under the joint key + homomorphic tally (§5.9) |
| All roles and all individual mission votes | everyone, once the game is over (won, lost, canceled or invalid) | end-of-game key reveal (§5.12) |

Inherent, accepted leakage (identical to the physical game and to today's
server): a team member on a 2-player team learns the partner's mission vote
from the fail count; intersecting teams across missions narrow suspicion; the
order and timing of human actions is visible. The protocol leaks nothing
beyond the fail count `k` per mission.

### 1.2 Adversaries

* **Curious player or coalition** (reads every GUN message, runs modified code
  passively): learns nothing beyond the table above and what the coalition
  members legitimately know together.
* **Cheating player or coalition** (deviates arbitrarily: bad shuffle, lying in
  the sight exchange, failing a mission while good, equivocating, replaying,
  canceling strategically): every deviation that could leak a secret or change
  the game is **prevented** by a zero-knowledge proof that every client checks
  before using the message. Deviations that cannot be prevented (equivocation,
  premature reveal, invalid messages) are **detected, attributed with
  self-verifying evidence, and end the game** as `INVALID` (the cheater's team
  forfeits, §5.13). Withholding (stalling) cannot be prevented without an
  honest majority; it is attributed and the game can be canceled (§3.8).
* **Relay / outsider**: sees all public data and ciphertexts (the same as any
  player's public view), IP addresses and timing. May drop, delay or reorder
  messages (liveness only). Cannot forge (application-level signatures on
  every message) and cannot rewrite (content addressing).
* **Lost device**: a player whose browser storage is wiped mid-game cannot
  continue; the protocol defines the outcome (§3.10).

Non-goals: preventing out-of-band communication between players; anonymity of
lobby membership; protecting a player against a coalition of *all* other
seats; fairness against aborts (the last party to contribute to a
decryption learns the result first and can withhold; this is attributed).

Assumptions: DDH in ristretto255; SHA-256/SHA-512 as random oracles;
ECDSA P-256 unforgeability; a CSPRNG (`crypto.getRandomValues`) at least once
per game per device; eventual delivery between online peers through the relay.

---

## 2. Cryptographic foundations

### 2.1 Libraries

* Group: ristretto255 from `@noble/curves@2.4` (`import { ristretto255,
  ristretto255_hasher } from '@noble/curves/ed25519.js'`), `Point =
  ristretto255.Point`, `G = Point.BASE`, `O = Point.ZERO`,
  `L = Point.Fn.ORDER = 2^252 + 27742317777372353535851937790883648493`.
* MSM: `pippenger(Point, points, scalars)` from
  `@noble/curves/abstract/curve.js` works directly on ristretto points
  (verified).
* Hashes: `@noble/hashes` (`sha2.js`: `sha256`, `sha512`; `hmac.js`;
  `hkdf.js`).
* Signatures: ECDSA P-256 from `@noble/curves/nist.js` (`p256`), using the
  SEA pair's `priv` as the secret key (verified: `p256.getPublicKey(priv)`
  equals the SEA `pub`).
* Secret scalars are multiplied with `multiply` (constant time, rejects 0);
  public verification uses `multiplyUnsafe` and `msm`.

### 2.2 Encodings

| Type | Binary | String form (in JSON) |
|---|---|---|
| `Pt` point | 32-byte RFC 9496 encoding (`toBytes`) | unpadded base64url, 43 chars |
| `Sc` scalar | 32-byte **little-endian**, value `< L` | unpadded base64url, 43 chars |
| `Hex32` digest / msgId | 32 bytes | 64 lowercase hex chars |
| `B64` other bytes | raw | unpadded base64url |
| SEA pub | `0x04 ‖ x ‖ y` (65 bytes) for noble | `"<x b64url 43>.<y b64url 43>"` (87 chars) |
| `u8`, `u32` | big-endian fixed width | — |

Decoders are strict: base64url MUST be unpadded, use only `[A-Za-z0-9_-]`, and
re-encode to the identical string; scalars `>= L` are rejected; points that do
not decode are rejected. `noble`'s decoder accepts the all-zero identity
encoding, so **every decoded statement point is checked against the identity**
unless this spec explicitly allows it (§2.3).

`lp(x) = u32(len(x)) ‖ x`. `utf8(s)` is the UTF-8 encoding. All protocol
strings are printable ASCII, so UTF-16 code-unit order equals byte order.

**Canonical JSON** (`canon(v)`): the RFC 8785 subset with these rules: object
keys sorted by code unit, no whitespace, strings restricted to printable ASCII
(0x20-0x7e) with only `"` and `\` escaped, numbers are integers with
`|x| < 2^53` printed without exponent or leading zeros, `true`, `false`,
`null`, arrays allowed. Parsers reject anything for which
`canon(JSON.parse(s)) !== s`, duplicate keys, unknown keys and missing keys
(per-type schemas in §3.3).

### 2.3 Identity point rules

The identity `O` is rejected, wherever it is decoded, for: every `y_j`, the
joint key `Y`, every `A` component of every shuffle output deck, every dealing
share `d_{j,i}`, every OT choice commitment `U_Q`, every `F_r.a` and `E.a`,
every ballot `a`, the tally base `T_m`, every tally share, every assassin
opening `O_a`. The identity is allowed only (1) as the `A` component of the
canonical initial deck, which is computed, never decoded, and (2) for proof
commitments `K` (negligible probability, no harm). Decrypted values that the
protocol compares (`X ∈ {O, G}`) are computed, not decoded.

### 2.4 Hash functions and domain separation

* `H2C(tag, msg) = ristretto255_hasher.hashToCurve(msg, {DST: utf8(tag)})`
  (RFC 9380 / RFC 9496 hash-to-ristretto255).
* `H2S(tag, msg) = ristretto255_hasher.hashToScalar(msg, {DST: utf8(tag)})`
  (expand_message_xmd SHA-512, 64 bytes reduced mod `L`).
* `SHA256`, `SHA512` from `@noble/hashes`.

Every tag starts with `avalon-p2p/v1/`. The full list is in Appendix B.

**Generators** (global constants, nobody knows any discrete-log relation
between them and `G`):

| Name | Definition | Use |
|---|---|---|
| `S` | `H2C("avalon-p2p/v1/gen", utf8("ot-S"))` | OT choice base |
| `J` | `H2C("avalon-p2p/v1/gen", utf8("ot-J"))` | OT sender profile key |
| `H₀` | `H2C("avalon-p2p/v1/gen", utf8("shuffle-H"))` | shuffle commitment chain start |
| `H_i` (i = 0..9) | `H2C("avalon-p2p/v1/gen", utf8("shuffle-H/" + i))` | shuffle permutation commitment |

**Card points.** A card label is `λ = {role: string, assassin: boolean}`.
`M(λ) = H2C("avalon-p2p/v1/card", utf8(λ.role) ‖ 0x00 ‖ u8(λ.assassin ? 1 : 0))`.
Implementations MUST assert at startup that the points of all 13 possible
labels (the 8 role names of `ROLES` with `assassin=false`, plus EVIL MINION,
MORGANA, MORDRED, OBERON and ASSASSIN with `assassin=true`) are pairwise
distinct and differ from `O` and `G`. `ASSASSIN` with `assassin=false` is
reachable (ASSASSIN selected without MERLIN). `assertCardPointsDistinct()`
generates the list from `ROLES` (every role with `false`, every evil role with
`true`) instead of hard-coding it.

### 2.5 Secret derivation (reload-safe determinism)

At config acceptance (§4.6) each seat `j` draws a **per-game seed**
`gs_j = getRandomValues(32 bytes)` and commits it to IndexedDB **before** it
signs anything for that game (§3.9). All of seat `j`'s per-game secrets and all
proof randomness are derived from `gs_j` and bound to the public inputs of the
computation, RFC 6979 style. Identical inputs therefore give byte-identical
outputs (republishing is idempotent), and different inputs never reuse a nonce.
Secrets are never derived from the SEA pair, never stored in GUN, and are
independent across games.

```
PRK = HKDF-Extract(SHA-256, salt = utf8("avalon-p2p/v1/derive"), ikm = gs_j)
stream(purpose, ctx...) produces blocks
  blk_t = HMAC-SHA-512(PRK, lp(utf8(gameId)) ‖ lp(utf8(purpose)) ‖ lp(ctx_1) ‖ ... ‖ u32(t)),  t = 0, 1, 2, ...
  .scalar()  = next 64-byte block as big-endian integer mod L; if 0, take the next block
  .bytes(k)  = next k bytes of the concatenated blocks
  .index(m)  = next 64-byte block as big-endian integer mod m   (bias < 2^-500)
  .perm(N)   = Fisher-Yates: p = [0..N-1]; for i = N-1 down to 1: j = .index(i+1); swap p[i], p[j]
```

Context items are byte strings (strings are `utf8`, integers `u32`, points
their 32-byte encoding, digests their 32 bytes).

| Secret | Derivation |
|---|---|
| ElGamal key share `x_j` | `stream("x").scalar()` |
| Beacon seed `seed_j` (32 B) | `stream("seed").bytes(32)` |
| Shuffle permutation, re-encryption and commitment randomness | `stream("shuffle", SHA256(enc(Y) ‖ enc(deck_in)))`: `.perm(N)`, then `ρ_0..ρ_{N-1}`, then `r_0..r_{N-1}`, then `r̂_0..r̂_{N-1}` (all `.scalar()`) |
| OT receiver blinding `β_Q` | `stream("ot-beta").scalar()` |
| OT sender profile randomness `f_r` | `stream("ot-f", u32(r)).scalar()` |
| OT sender per-pair randomness `k_{Q,r}` | `stream("ot-k", u32(Q), u32(r), enc(U_Q)).scalar()` |
| Proposal-vote nonce | `stream("pvote", utf8(stepId), prev).bytes(32)` |
| Ballot randomness `r` | `stream("ballot", utf8(stepId), prev, u8(v)).scalar()` |
| Sigma-proof nonces | `stream("nonce", utf8(proofType), utf8(stepId), SHA256(tb))` (§2.6) |

Verifiers' batch weights (§2.6.4) are **not** derived: they come from
`getRandomValues`, so a prover cannot predict them.

### 2.6 The sigma-proof engine

All zero-knowledge proofs in this protocol (Schnorr, DLEQ, batched DLEQ, CDS
OR, AND-inside-OR, and the Terelius-Wikström shuffle argument) are instances of
**one** engine for proofs of knowledge of witnesses satisfying linear relations
over the group, composed with the Cramer-Damgård-Schoenmakers OR.

#### 2.6.1 Statements

```ts
interface Term     { w: number; base: Point }          // w = witness index within the branch
interface Equation { target: Point; terms: Term[] }    // target = Σ terms[t].w-th witness · terms[t].base
interface Branch   { nWitness: number; eqs: Equation[] }
interface ProofContext { configId: Hex32; stepId: string; prover: string /* SEA pub */ }
interface Statement { proofType: ProofType; ctx: ProofContext; aux: Uint8Array /* empty except for shuffle, §5.3 */; branches: Branch[] }
```

A statement with one branch is an AND of its equations (all equations share
the branch's single challenge). A statement with `B > 1` branches proves that
**at least one** branch holds (CDS OR). Each branch has exactly **one**
challenge `e_k` that is shared by **all** of its equations (this is what makes
AND-inside-OR sound: separate challenges per conjunct would let a prover mix
branches). Both prover and verifier build the statement themselves from public
data; it is never transmitted.

#### 2.6.2 Transcript and challenge (strong Fiat-Shamir)

```
tb = lp(utf8("avalon-p2p/v1")) ‖ lp(utf8(proofType)) ‖ configId(32 B) ‖ lp(utf8(stepId)) ‖ lp(utf8(prover))
   ‖ lp(aux)                                   // empty (u32(0)) except for proofType shuffle (§5.3 step 6)
   ‖ u32(B)
   ‖ for each branch k: u32(nWitness_k) ‖ u32(#eqs_k)
        ‖ for each equation i: enc(target) ‖ u32(#terms) ‖ for each term: u32(w) ‖ enc(base)
e  = H2S("avalon-p2p/v1/fs/" + proofType,  tb ‖ enc(K_{0,0}) ‖ enc(K_{0,1}) ‖ ... ‖ enc(K_{B-1,last}))
```

`enc` is the 32-byte point encoding (the identity encodes as 32 zero bytes).
The transcript therefore binds the protocol version, the proof type, the game
configuration (which commits to gameId, seats, roles and options), the step,
the prover's identity, the statement's public input digest `aux` (shuffle
only), **every statement point including generators and card points**, and
every commitment, in a fixed order.

#### 2.6.3 Prove

Inputs: statement, index `ρ` of the real branch, witness vector `w` of length
`nWitness_ρ`. Let `st = stream("nonce", proofType, stepId, SHA256(tb))`.

1. For each branch `k ≠ ρ`, in increasing `k`: `e_k = st.scalar()`; for each
   witness `j`: `s_{k,j} = st.scalar()`; for each equation `i`:
   `K_{k,i} = Σ_t s_{k,w_t}·base_t − e_k·target_i`.
2. For the real branch: `ω_j = st.scalar()` for each witness;
   `K_{ρ,i} = Σ_t ω_{w_t}·base_t`. To keep the work independent of which branch
   is real, the prover also computes (and discards) `e'·target_i` for a dummy
   scalar `e' = st.scalar()`.
3. `e` = challenge from §2.6.2.
4. `e_ρ = e − Σ_{k≠ρ} e_k mod L`; `s_{ρ,j} = ω_j + e_ρ·w_j mod L`.
5. Output `SigmaProofE = { K: Pt[][] (per branch, per equation), e: Sc[] (per branch), s: Sc[][] (per branch, per witness) }`.

With `B = 1` this is an ordinary (multi-equation) Schnorr proof and `e_0 = e`.

#### 2.6.4 Verify

1. Shapes must match the statement exactly; decode every `K`, `e_k`, `s_{k,j}`
   strictly.
2. Recompute `e` from `tb` and the received `K`; require `Σ_k e_k ≡ e (mod L)`.
3. For every branch `k` and equation `i`, require
   `Σ_t s_{k,w_t}·base_t − e_k·target_i − K_{k,i} = O`.

**Batch verification** (MUST be used for steps with many proofs, MAY be used
always): after step 2 succeeds for every proof in the batch, draw a fresh
128-bit nonzero weight `z_{k,i}` per equation from `getRandomValues` and check
the single MSM `Σ z_{k,i}·(Σ_t s_{k,w_t}·base_t − e_k·target_i − K_{k,i}) = O`
over all equations of all proofs. If the batch fails, re-verify each proof
individually to attribute the failure (a failing proof is publicly verifiable
evidence).

#### 2.6.5 Proof types

| `proofType` | Branches | Witnesses | Equations (per branch) | Section |
|---|---|---|---|---|
| `pok` | 1 | `x` | `y = x·G` | §5.2 |
| `shuffle` | 1 | `r̄, r̂, r̃, ρ̄, r̂_0..r̂_{N-1}, u'_0..u'_{N-1}` | 5 + N (below) | §5.3 |
| `deal` | 1 | `x` | `y_j = x·G`; `d_{j,i} = x·A_i` for all `i ≠ j` | §5.4 |
| `ot-recv` | one per distinct label `λ ∈ Λ` | `x, β` | `y_Q = x·G`; `C_Q − M(λ) = x·A_Q`; `U_Q − idx(λ.role)·S = β·G` | §5.5 |
| `ot-profile` | one per `λ ∈ Λ` | `x, f_0..f_{R-1}` | `y_P = x·G`; `C_P − M(λ) = x·A_P`; for each `r`: `F_r.a = f_r·G`, `F_r.b − seen(ν_r, λ.role)·G = f_r·J` | §5.5 |
| `ot-eq` | 1 | `f_0..f_{R-1}`, `k_{Q,r}` for all `Q ≠ P`, all `r` | `F_r.a = f_r·G`; for each `Q, r`: `E_{Q,r}.a = k_{Q,r}·G`, `E_{Q,r}.b − F_r.b = k_{Q,r}·PK_{Q,r} + f_r·(−J)` | §5.5 |
| `ballot` | `1 + #evil labels` | branch 0: `r`; branch `e`: `r, x` | branch 0: `a = r·G`, `b = r·Y`; branch for evil label `λ`: `a = r·G`, `b − G = r·Y`, `y_Q = x·G`, `C_Q − M(λ) = x·A_Q` | §5.9 |
| `tally` | 1 | `x` | `y_j = x·G`; `D_{j,m} = x·T_m` | §5.9 |
| `open` | 1 | `x` | `y_a = x·G`; `O_a = x·A_a` | §5.10 |

Witness indices are numbered in the order listed. Equations are listed in the
order given (for `deal`, increasing `i`; for `ot-profile`, `r` increasing with
the `.a` equation before the `.b` equation; for `ot-eq`, first all `F_r.a`
equations, then `Q` increasing, `r` increasing, `.a` before `.b`; witness
order for `ot-eq` is `f_0..f_{R-1}` then `k_{Q,r}` in the same `(Q, r)` order).
Branch order: labels in `Λ` order (§5.1); for `ballot`, branch 0 first, then
the evil labels in `Λ` order.

---

## 3. Messages, storage and ordering

GUN gives no log, no total order and no immutability in user space: a
user-space key is a last-writer-wins register whose HAM state is chosen by the
writer, and an author can show different versions to different peers. The
protocol therefore **never stores protocol messages in mutable slots**. Every
protocol message is an immutable, self-signed string in a **content-addressed**
GUN soul, and the game state is a **pure function of the set of messages**
(arrival order, GUN state and wall clocks never decide anything).

### 3.1 GUN graph layout

| Soul | Content | Key | Value |
|---|---|---|---|
| `avalon/v1/lobby/<CODE>#` | lobby messages (`lobby.*`) for every lobby that ever used `CODE` | `hex(SHA256(utf8(value)))` | envelope string |
| `avalon/v1/game/<gameId>/setup#` | `key`, `shuffle`, `deal`, `ot.recv`, `ot.send` | same | envelope string |
| `avalon/v1/game/<gameId>/play#` | `propose`, `vote.*`, `ballot`, `tally`, `assassinate`, `cancel`, `reveal` | same | envelope string |
| `avalon/v1/logs/<YYYY-MM>#` | `log` (month of the config's `t`, UTC) | same | envelope string |
| `~<pub>` (SEA user space) | key `avalon_v1_presence` only | — | presence string (§7.6), advisory |

`CODE` matches `[A-HJ-NP-TV-Z]{4}` (alphabet `ABCDEFGHJKLMNPQRSTVWXYZ`).
`gameId` is 16 random bytes, base64url (22 chars, `[A-Za-z0-9_-]`). Souls are
built **only** from validated components; nothing user-typed (names) ever
appears in a soul or key. Clients address every node by its full soul with
`gun.get(soul)` and never follow links in public space.

The `#` suffix makes SEA (on every peer that loads `gun/sea`, including the
relay) enforce `key == SHA-256(value)` (the fork's `check.hash` accepts a hex
key; verified), so values can be neither overwritten nor deleted (`null` is
rejected). Clients re-check the hash themselves (§3.4), so a misconfigured
relay cannot inject data either; it can only drop it.

### 3.2 Envelope

```ts
// common/protocol/types.ts (normative; WP-B owns the file, content fixed by this spec).
// Pt, Sc, Hex32, B64, Pub, CtE, SigmaProofE and CardLabel are defined in common/crypto/types.ts (WP-A)
// and re-exported here; they are shown inline for completeness.
export type Pt = string;     // 43-char b64url ristretto point
export type Sc = string;     // 43-char b64url little-endian scalar < L
export type Hex32 = string;  // 64 lowercase hex chars
export type B64 = string;    // unpadded base64url
export type Pub = string;    // SEA pub "x.y"

export interface CtE { a: Pt; b: Pt }                               // ElGamal ciphertext (A, B)
export interface SigmaProofE { K: Pt[][]; e: Sc[]; s: Sc[][] }      // §2.6.3
export interface CardLabel { role: string; assassin: boolean }

export type LobbyMsgType = 'lobby.create' | 'lobby.join' | 'lobby.leave' | 'lobby.roster' | 'lobby.config';
export type GameMsgType =
  | 'key' | 'shuffle' | 'deal' | 'ot.recv' | 'ot.send'
  | 'propose' | 'vote.commit' | 'vote.reveal' | 'ballot' | 'tally' | 'assassinate'
  | 'cancel' | 'reveal';
export type MsgType = LobbyMsgType | GameMsgType | 'log';

export interface Member { pub: Pub; name: string; joinId: Hex32 }
export interface GameConfig {
  gameId: B64;                               // 16 random bytes
  seats: { pub: Pub; name: string }[];      // seat order = playerList order chosen by the admin
  selectedRoles: string[];                  // subset of selectable role names, ROLES order, unique
  options: { inGameLog: boolean };
  rulesHash: Hex32;                         // §11.2 rules.ts RULES_HASH
}

export interface Bodies {
  'lobby.create': { code: string; name: string; nonce: B64 /* 16 random bytes */ };
  'lobby.join':   { name: string; ticket?: B64 };    // ticket: 16 bytes, §4.3
  'lobby.leave':  { };
  'lobby.roster': { seq: number; admin: Pub; members: Member[];
                    rejected: { joinId: Hex32; reason: 'name-taken' | 'invalid-name' | 'full' | 'game-active' | 'declined' }[];
                    closed: boolean };
  'lobby.config': GameConfig;
  key:            { y: Pt; pok: SigmaProofE; seedCommit: Hex32 };
  shuffle:        { deck: CtE[]; c: Pt[]; chat: Pt[]; proof: SigmaProofE };
  deal:           { d: (Pt | null)[]; proof: SigmaProofE };           // d[i] = x_j·A_i, null at i = j
  'ot.recv':      { U: Pt; proof: SigmaProofE };
  'ot.send':      { F: CtE[]; E: (CtE[] | null)[]; profile: SigmaProofE; eq: SigmaProofE; seed: B64 };
  propose:        { team: number[] };                                // seat indices, strictly ascending
  'vote.commit':  { commit: Hex32 };
  'vote.reveal':  { approve: boolean; nonce: B64 };                  // 32 bytes
  ballot:         { ballot: CtE; proof: SigmaProofE };
  tally:          { share: Pt; proof: SigmaProofE };
  assassinate:    { target: number; open: Pt; proof: SigmaProofE };
  cancel:         { at: string; reason: 'cancel' | 'leave' | 'abort' | 'lost' };
  reveal:         { x: Sc; ballots: { m: number; r: Sc }[]; basis: Hex32[] };   // basis: §3.7 rule 3
  log:            LogBundle;                                         // §6
}

export interface Envelope<T extends MsgType = MsgType> {
  v: 1;
  type: T;
  lobby: Hex32 | '';     // lobbyId; '' only in lobby.create
  game: B64 | '';        // gameId for game messages and log; '' for lobby messages
  step: string;          // game step id (§3.5); '' for lobby and log messages
  author: Pub;
  prev: Hex32 | '';      // see table below
  t: number;             // author's drift-corrected wall clock, ms; informational only
  body: Bodies[T];
}
```

| Type | `step` | `prev` |
|---|---|---|
| `lobby.create` | `''` | `''` (its msgId becomes the `lobbyId`) |
| `lobby.join`, `lobby.leave` | `''` | `''` |
| `lobby.roster` | `''` | msgId of the previous roster on its branch, or the `lobbyId` for `seq = 1` |
| `lobby.config` | `''` | msgId of the roster it is based on (`rosterId`) |
| game messages except `cancel`/`reveal` | the step id | `D_{k-1}`, the chain digest before the step (§3.5) |
| `cancel` | `'cancel'` | `D_{k-1}` of the step `body.at` it cancels |
| `reveal` | `'reveal'` | the terminal digest in the author's view: the last digest of its natural chain (informational, not validated; `body.basis` is what justifies the reveal, §3.7 rule 3) |
| `log` | `''` | the terminal digest |

The `configId` of a game is the msgId of its `lobby.config` envelope.

### 3.3 Wire encoding, message id and signatures

```
m        = the Envelope object
mBytes   = utf8(canon(m))
msgId    = SHA256(utf8("avalon-p2p/v1/msg\0") ‖ mBytes)                  // Hex32 in JSON
sig      = p256.sign(utf8("avalon-p2p/v1/sig\0") ‖ msgId(32 bytes), privOf(author),
                     { prehash: true, lowS: true })                    // 64-byte compact, RFC 6979 deterministic
value    = "AV1." + b64url(mBytes) + "." + b64url(sig)
gunKey   = hex(SHA256(utf8(value)))
```

* `privOf(author)` = `b64urlDecode(pair.priv)` (32 bytes); the public key is
  `0x04 ‖ b64urlDecode(x) ‖ b64urlDecode(y)` from `pub = "x.y"`.
* Verification uses `p256.verify(sig, msg, pub, { prehash: true, lowS: true })`
  and rejects high-S signatures.
* **Identity, deduplication and equivocation are keyed by `msgId` only**,
  never by `value`, signature bytes or GUN key (ECDSA malleability and
  re-signing cannot frame anyone).
* The value never starts with `SEA{` and is not JSON, so neither SEA nor GUN
  reinterprets it. Maximum `value` length: 64 KiB (the largest message,
  `ot.send` at n = 10, is about 25 KiB).

Schema validation (`parseEnvelope`) is strict: exact key sets per type, all
encodings canonical (§2.2), integers in range, `step` well-formed, array
lengths as required by the config (checked again by the step validator),
`name` matching `/^[A-Z]{1,20}$/` and not a role name.

### 3.4 Ingestion pipeline

For every `(soul, key, value)` delivered by GUN:

1. Require `typeof value === 'string'`, `value.startsWith('AV1.')`, length ≤ 64 KiB,
   and `key === hex(SHA256(utf8(value)))`.
2. Split, strict-decode, `parseEnvelope`; then, **before** the signature
   check, drop the envelope unless it can matter to this driver (a game
   driver: `game` is its game and `author` is a seat of its config; a lobby
   driver: a `lobby.create` of its code, or `lobby` is its lobby), so junk
   anyone writes into a public soul costs no ECDSA work and is never stored;
   recompute `msgId`; verify `sig` against `author`.
3. Require that the soul matches the envelope (`lobby` code or `game` id and
   the setup/play/log category of `type`).
4. Deduplicate by `msgId`; store `{msgId, soul, key, value}` in IndexedDB
   `transcript` (§3.9); schedule a (debounced, 30 ms) re-evaluation.

Failures at steps 1-3 are dropped silently (anyone can write garbage into a
public soul; it is not attributable unless signed).

### 3.5 Steps and the digest chain

A game is a sequence of **steps**. From each state, the rules
(`common/protocol/steps.ts`) give the next step id and its required author set
`Req(k)`:

| Step id | Message type | `Req` | Kind |
|---|---|---|---|
| `key` | `key` | all seats | setup |
| `shuf/<j>` (j = 0..n-1, in order) | `shuffle` | seat `j` | setup (pipelinable, §5.3) |
| `deal` | `deal` | all seats | setup |
| `otR` | `ot.recv` | all seats | setup |
| `otS` | `ot.send` | all seats | setup |
| `p/<m>/<p>` | `propose` | the proposer seat | human |
| `vc/<m>/<p>` | `vote.commit` | all seats | human |
| `vr/<m>/<p>` | `vote.reveal` | all seats | automatic |
| `mv/<m>` | `ballot` | the approved team | human |
| `mt/<m>` | `tally` | all seats | automatic |
| `as` | `assassinate` | the assassin (identified by its valid opening, §5.10) | assassination |

`m` and `p` are 0-based mission and proposal indices. The digest chain:

```
D_0 = configId
D_k = SHA256(utf8("avalon-p2p/v1/step\0") ‖ D_{k-1} ‖ lp(utf8(stepId_k)) ‖ msgId_{a_1} ‖ ... ‖ msgId_{a_q})
      where a_1 < ... < a_q are the seats in Req(k) and msgId_a is a's message for step k
```

Every game message (except `cancel` and `reveal`) carries `prev = D_{k-1}`.
Because messages are immutable and a seat contributes exactly one message per
step, `D_k` fixes the entire public history up to step `k`: a vote reveal
binds the exact set of `n` commits it answers, a ballot binds the approved
proposal, and so on.

### 3.6 Evaluation (`reduce`)

`reduce(config, S, verdicts)` is a pure, order-independent function of the set
`S` of ingested envelopes for the game and of cached proof verdicts. It walks
the **natural chain**:

```
state ← initial(config); D ← configId; k ← 0
loop
  step ← nextStep(state)                       // null when state is terminal
  if step == null: break                       // natural terminal outcome reached
  M ← { m ∈ S : m.game = gameId ∧ m.step = step.id ∧ m.type = step.type }
  for each author a with ≥ 2 distinct msgIds in M:            → INVALID(a, "equivocation", evidence = both values)
  for each a ∈ Req(step) (for `as`: every author in M) with exactly one m ∈ M:
      m.prev ≠ D                                               → ignore m (logged locally; a counts as absent)
      step validator rejects body (sizes, team rules, …)       → INVALID(a, reason)
      verdict(m) = false (proof or decryption check failed)    → INVALID(a, reason)
  if any INVALID: stop; record INVALID at step k
  if some a ∈ Req(step) has no message, or a needed verdict is unknown:
      stop; pending at step k (emit verification jobs for unknown verdicts)
  state ← apply(state, messages); D ← D_k; k ← k + 1
```

* **Wrong `prev` is absence, not a fault.** A message whose `prev` is not the
  digest `D` of the natural chain is ignored and logged locally: it counts as
  absent for completion (its author shows as stalled) and is never
  `INVALID`. Honest seats can produce such messages when the admin equivocates
  on the config (two configs sharing one `gameId` share the game souls, §4.6),
  so blaming them would be wrong; a cheater gains nothing from a wrong `prev`
  beyond withholding. Equivocation is still judged on all of `M`: two distinct
  msgIds from one author at one step are equivocation whatever their `prev`
  (the journal keeps an honest seat to one message per step and game, §3.9).
* Messages from authors not in `Req(k)` are ignored (they cannot change
  anything), except at `as` where any `assassinate` is examined: a valid
  opening of a non-assassin card is `INVALID(author, "false assassination
  claim")`.
* **Pipelining exception:** a `shuf/j` step is *structurally complete* when
  seat `j`'s message is present and schema-valid; the walk may pass it before
  its proof is verified (so `shuf/j+1` can start), but it does **not** pass
  `deal` until every shuffle proof has a `true` verdict. A `false` shuffle
  verdict is `INVALID(j)` at `shuf/j`.
* Messages for steps the natural chain never reaches are ignored.
* Two `INVALID`s at the same step are all reported; the primary cheater is the
  lowest seat.

### 3.7 Cancels, premature reveals and the outcome

Any seat may cancel a running game (as today). A cancel is a `cancel` message
with `body.at = stepId_k` and `prev = D_{k-1}`: it targets the step that was
pending in the author's view. Resolution, applied after the natural walk:

1. **Validity.** A cancel is considered only if `D_{k-1}` lies on the natural
   chain, `stepId_k` is the step that follows it, the state at `D_{k-1}` is not
   terminal, and the phase at `D_{k-1}` is not `ASSASSINATION` (see rule 6).
   Otherwise it is ignored.
2. **Canceled and continued.** If the canceller `X` also has a message (any
   type other than `cancel`, `reveal`, `log`) at a natural-chain step **after**
   `k`, the result is `INVALID(X, "canceled and continued")` at step `k`. An
   honest client never publishes after canceling, and its cancel always
   targets its own head step, so this can only be a cheater (typically a sore
   loser referencing an old digest after the result became known).
   2a. **No contributor cancel at the step before the assassination.** At a
   step `mt/m` whose start state (at `D_{k-1}`) has two successful missions
   and MERLIN in play, a cancel by `X` counts only if `X` has no `tally` at
   `mt/m`. If `X` has both a cancel at `mt/m` and a `tally` at `mt/m`, the
   result is `INVALID(X, "canceled and continued")` at `mt/m`. Without this
   rule, a contributor could wait until `mt/m` completed and the assassin had
   chosen, then cancel at `mt/m` (rule 2 only looks at steps after `k`, rule 6
   only at cancels whose start phase is `ASSASSINATION`, and rule 5 keeps only
   terminal completions), voiding the assassination result. A withholder's
   cancel (no tally) is still valid and still beats a later completion
   (rule 5), so the cancel-reveal-then-complete exploit stays closed. An honest
   client never publishes a cancel at such a step once its own tally is
   journaled (§7.7, §7.8).
3. **Premature reveal.** Every `reveal` carries `basis`: the msgIds of the
   messages that made the outcome terminal in the revealer's view (the
   deciding cancel; the faulty, equivocating or premature-reveal envelope(s)
   of the deciding `INVALID`, i.e. its `Fault.evidence`, where an equivocation
   or a config equivocation cites only its two lowest msgIds, which prove it,
   so the basis stays far below the reveal's 256-entry limit however many
   messages a cheater signs; or every message of
   the terminal step for a natural terminal). Its `prev` is the terminal
   digest (informational). A reveal whose `x` satisfies `x·G = y_j` is
   * **pending** (neither `INVALID` nor used, and it makes nothing terminal)
     while some basis message is not ingested, or the natural walk over `S` is
     still pending before the step a basis message belongs to, or a verdict
     needed to evaluate a basis message is unknown;
   * otherwise **premature**, `INVALID(j, "revealed key during the game")` at
     the pending step, if the outcome computed over `S` without this reveal is
     still not terminal; it then makes the game terminal for everybody, so no
     honest player keeps playing after secrets are out;
   * otherwise an ordinary end-of-game reveal (§5.12).

   Because envelopes are immutable and every check is deterministic, a peer
   that holds the basis computes the same terminal outcome the revealer did, so
   an honest reveal is never premature, even if the relay withheld the deciding
   message from that peer for a while (it is then only pending). The revealing
   client re-puts every basis envelope immediately before its reveal (§7.7).
   While any reveal is pending in a client's view, its driver is **suspended**:
   it publishes nothing except a cancel (on user request) and, once terminal,
   its own reveal, and the UI shows "NAME revealed their keys citing messages
   this device has not received - waiting [Cancel]" (a reveal with a bogus
   basis therefore halts the game instead of letting play continue with a
   verifiably disclosed card). Exception: the assassin's `as` is not
   suspended. Cancels are ignored during the assassination (rule 6), so a
   reveal citing a made-up msgId would otherwise veto the assassination with
   no attribution; if its basis is real, an earlier terminal event decides the
   game and the `as` is moot (rule 4), and if it is bogus, the `as` decides.
4. **Earliest event wins.** Among the natural `INVALID` (step `i`), rule-2/2a/3
   `INVALID`s (including `INVALID(admin, "config equivocation")` at `key`,
   §4.6), the earliest valid cancel (step `k`; ties broken by lowest seat)
   and the natural terminal (step `t`), the event with the smallest step index
   decides. At equal index, `INVALID` beats cancel.
5. **Cancel at an automatic step does not void a decided result.** If the
   deciding event is a cancel at step `k` of kind *automatic* (`vr`, `mt`) and
   the natural chain completed step `k` with a terminal result (5th rejection,
   third fail, third success without Merlin), that natural outcome stands. In
   every other case the outcome is `CANCELED` at step `k` (subject to rule 5a). Cancels at human
   steps (`p`, `vc`, `mv`) and setup steps always win over completion of the
   same step: a human decision taken after a cancel may have used the secrets
   revealed because of the cancel (e.g. a vote commit cast after everyone's
   role became known), so it must not count.
   5a. **A withheld decisive result is completed from the reveals.** If the
   deciding event is a cancel at `mt/m` and, after the reveals, every team
   ballot of `mv/m` is opened (by its voter's revealed `r`, or by all `x_j`),
   compute `numFails` from the opened ballots. If completing `mt/m` with that
   value would have been terminal (third fail, or third success without
   MERLIN), the outcome is that natural result, with the message suffix
   `" (NAME withheld the tally)"` naming the stalled seats at `mt/m`.
   Likewise, if the deciding event is a cancel at `vr/m/4` and the valid vote
   reveals in `S` already contain at least `n − floor(n/2)` rejections, the
   outcome is `EVIL_WIN` ("Five team proposals in a row rejected", same
   suffix with "the vote"). Both are monotone: the cancel already made the
   outcome terminal, more messages only fix the label, and no decision follows
   either result. A third success *with* MERLIN in play is not terminal and
   stays `CANCELED` (rule 2a keeps contributors from using it).
6. **No cancel during ASSASSINATION.** During the assassination phase cancels
   are ignored. Otherwise either (a) a cancel would trigger the reveal, the
   assassin would learn Merlin and then assassinate, or (b) a sore loser could
   void the game after seeing the chosen target. (Rule 2a closes the same hole
   for a cancel that targets the preceding `mt/m` instead.) Instead, a player who wants to
   leave during the assassination simply leaves; the game ends when the
   assassin acts. If the assassin never acts, players use the local
   **Abandon** action (§7.8), which stops their client from waiting without
   publishing anything and without revealing.

Properties: the resolved outcome is **monotone**: once terminal under a set
`S`, it is terminal under every superset of `S` (only the label can change,
e.g. `CANCELED` to `INVALID(X)` when X's continuation appears, or `CANCELED`
to the natural result under rule 5a). Honest clients reveal only when
terminal and cite their basis, so an honest reveal can never be "premature"
(rule 3).

The outcome records the **stalled** seats: the members of `Req` at the pending
step of the natural chain who had no message (e.g. "Canceled by ALICE, waiting
for BOB"). If the canceller itself is among them at an automatic step
(`vr`, `mt`), the message says so ("Canceled by BOB while withholding the
mission result"): this is the only way a last contributor can exploit seeing a
result first, and it is attributed. When the withheld result was terminal,
rule 5a restores it after the reveals, so withholding cannot void a loss whose
ballots are opened. Honest clients publish their own open automatic message
before a cancel (§7.7), so an honest canceller is never the sole withholder.

### 3.8 Stalls and timeouts

There are **no protocol timeouts**. Wall clocks and GUN states are
author-chosen and arrival times differ per peer, so a timeout cannot be
evaluated consistently. Timers exist only in the UI (§7.8): they surface who is
blocking and enable the Cancel button; the resulting `cancel` message is
ordered by §3.7. Without an honest majority, fairness against aborts is
impossible; the protocol's answer is attribution (`stalled`, "withholding").

### 3.9 Local persistence, the journal and the single writer

The client keeps an IndexedDB database `avalon` (version 1). GUN's own
`localStorage` adapter is disabled (§7.1).

| Store | Key | Value |
|---|---|---|
| `identity` | `'self'` | `{ pair: SEA pair, created: number }` |
| `profile` | `'self'` | `{ name: string \| null, lobbyCode: string \| null, lobbyId: Hex32 \| null }` |
| `games` | `gameId` | `{ gameId, lobbyId, configId, seat, seed: B64 (gs_j), status: 'active' \| 'ended' \| 'abandoned' \| 'lost' \| 'superseded', startedAt, endedAt? }` |
| `journal` | `[scopeId, slot]` | own signed envelope `value` (string) |
| `transcript` | `msgId` | `{ soul, key, value, gameId \| lobbyId }` |
| `verdicts` | `jobId` | `{ ok: boolean, reason?: string }` (only for verified-valid or verified-invalid proofs) |
| `history` | `gameId` | finished-game summary for stats (§6) |

`identity` and `games` live in the same database, so clearing site data
removes both together (a device never keeps a pair while losing its seeds).
The client calls `navigator.storage.persist()` at startup. Every IndexedDB
error is caught and surfaces as `LOST_SECRETS` (never "continue anyway").

**Journal and once-only release.** Every message this device publishes goes
through `publish(slot, build)`:

1. If `journal[scope, slot]` exists, re-put exactly that value and return.
2. Otherwise build the envelope (deterministic from `gs_j`, the state and the
   user's choice), sign it, **commit it to IndexedDB**, then `put` it to GUN.

Slots: game messages use `step` (and `'cancel'`, `'reveal'`, `'log'`); lobby messages
use `type` plus a discriminator (`'join'`, `'leave'`, `'roster/<seq>'`,
`'config/<gameId>'`, `'create'`). User choices (vote, ballot, team, target) are
written into the journal as part of the envelope and are never asked twice.

Consequences: a seat never produces two different messages for one step, even
across reloads, crashes or partitions, so it never equivocates and **never
releases a secret-dependent output (dealing share, OT answer, tally share,
opening, reveal) for two different inputs**. This is what defeats the
"last shuffler rewrites its deck to collect shares for several versions"
attack: each honest seat publishes dealing shares for exactly one final deck,
and a deck can only be decrypted with shares from every other seat on that
same deck.

**Single writer.** Only one tab per device runs the protocol driver:
`navigator.locks.request('avalon-driver', { ifAvailable: true }, holdUntilUnload)`.
A tab that does not get the lock is `READ_ONLY_OTHER_TAB` ("Avalon is open in
another tab - [Use here]"; Use here re-requests with `{ steal: true }`, which
makes the other tab drop to read-only). Only the lock holder signs or
publishes.

### 3.10 Startup recovery and lost storage

On startup the lock holder:

1. Loads `identity`, `profile` and every `games` record with status `active`.
2. Subscribes to the lobby and game souls (§7.3) and loads the cached
   `transcript` from IndexedDB into the evaluator.
3. Re-evaluates (cached verdicts avoid re-verifying proofs; unknown verdicts
   are queued to the worker pool).
4. Recomputes its private view (card, sees) from `gs_j` and the transcript.
5. Re-puts every journal entry of the active lobby and game.
6. Resumes automatic steps.

Lost storage:

* **Pair present, game record missing** for a game whose config seats this
  pub: state `LOST_SECRETS` ("This browser lost the secret keys for this game;
  it cannot continue"). The only action is **Cancel game**, which publishes a
  `cancel` with reason `'lost'` (it needs only the SEA pair). The client never
  regenerates `x_j`.
* **Pair lost**: the device is a stranger. The others see a stalled seat and
  cancel. After the reveal, the lost seat's role is recovered by elimination
  if every other seat revealed (§5.12); its mission votes are recovered by
  elimination when it is the only unknown voter on a mission, otherwise shown
  as unknown.
* Optional (SHOULD): "Export identity" (SEA pair + active game seeds as a QR
  code or text) so a player can move devices mid-game; importing writes the
  same IndexedDB records.

---

## 4. Lobby lifecycle

The lobby holds no secrets; today's server is authoritative over it. In P2P
the **admin's signed roster** is the single authority for membership, names,
seat order and kicks. Joins are requests. Nothing depends on HAM states or
self-asserted timestamps, and nothing in public space is mutable.

### 4.1 Identifiers

* `CODE`: 4 letters from `ABCDEFGHJKLMNPQRSTVWXYZ` (279,841 codes; the old
  3-letter codes are not used). It is a rendezvous hint, not an identity:
  several lobbies may share a code over time.
* `lobbyId`: msgId of the `lobby.create` envelope (unique).
* Lobby fingerprint shown in the UI: the first 8 hex chars (32 bits) of
  `lobbyId`, uppercase, as `XXXX-XXXX` (e.g. `ABCD · 7F3A-91C2`), for verbal
  confirmation at the table. (A msgId hashes the unsigned envelope, so 16 bits
  could be ground offline in under a second.) The chooser also shows the admin
  key's fingerprint: the first 32 bits of SHA-256 of the admin's `x.y` pub.
* Invite link: `https://<host>/?lobby=<CODE>&id=<first 16 hex of lobbyId>&k=<invite key>`
  (`k` only in the admin's link, §4.3).

### 4.2 Create

1. Draw `CODE` with `getRandomValues`. Subscribe to `avalon/v1/lobby/<CODE>#`
   for 1.5 s. If a **live** lobby (§4.3) already uses the code, draw again
   (at most 5 attempts; then use the last code anyway, since collisions are
   disambiguated at join time).
2. Publish `lobby.create {code, name, nonce}`; `lobbyId` = its msgId.
3. Publish `lobby.roster {seq: 1, admin: self, members: [{pub: self, name, joinId: lobbyId}], rejected: [], closed: false}` with `prev = lobbyId`.
4. Save `profile {name, lobbyCode, lobbyId}`; the lobby is connected.

### 4.3 Discover, join

* A **candidate** for `CODE` is a `lobby.create` with `body.code = CODE` whose
  roster head (§4.4) is not `closed`. It is **live** if its admin's presence
  (§7.6) was received in the last 60 s.
* Joining by code: subscribe for up to 3 s. If the invite link carried `id`,
  keep only candidates whose `lobbyId` starts with it. Exactly one live
  candidate: join it. Several: show a chooser (admin name, member names,
  fingerprint, online state); never pick silently. None: "Lobby CODE not found".
* **Invite key and tickets.** The admin's invite key is
  `K = SHA-256(T_inv ‖ sign_admin(T_inv ‖ lobbyId))[0..16)` with
  `T_inv = "avalon-p2p/v1/invite\0"` and the deterministic (RFC 6979) envelope
  signer: only the admin can compute it, it survives reloads and it is never
  published; it travels only as `k` (base64url) in the admin's invite link. A
  joiner holding `k` adds `ticket = HMAC-SHA-256(K, "avalon-p2p/v1/ticket\0" ‖
  lobbyId ‖ utf8(pub))[0..16)` to its `lobby.join`.
* Join: publish `lobby.join {name, ticket?}` with `lobby = lobbyId`. The promise
  resolves when a roster on the head chain lists `{pub: self}`, and rejects
  with `Error('Name taken')`, `Error('Invalid name')`, `Error('Lobby full')` or
  `Error('Cannot join while game is in progress')` when a head roster lists the
  join id in `rejected`. While pending the UI shows "Waiting for ADMIN to admit
  you".
* The admin's client processes join requests in the order it ingests them:
  reject (with the reason) a request whose name fails `validateName`, that the
  admin declined (`'declined'`), whose name a current member has, when members
  = 10, or while a config is pending (its `key` step incomplete and not
  canceled) or a game is non-terminal; otherwise admit it **automatically only
  if it carries a valid ticket**, or once the admin approved it by hand
  ("NAME asked to join [Admit] [Decline]"). A request by code alone therefore
  never fills the lobby with Sybil keys (lobby codes are enumerable). Each
  decision is a new roster (`seq + 1`) listing at most 32 rejections (oldest
  first; the schema allows 256), so a burst of join requests is worked off in
  bounded rosters instead of producing one that cannot be encoded. While a config is
  pending or a game is non-terminal, every join is rejected with
  `'game-active'` (the joiner's "Cannot join while game is in progress"
  comes from that roster). Such a roster only appends to `rejected` and keeps
  `admin` and `members` unchanged, so it does not disturb config acceptance
  (§4.6.2); membership-changing rosters (admissions, removal of leavers) are
  deferred until the game is terminal or the pending config is aborted.

### 4.4 Roster chain and fork choice

Rosters form a tree through `prev`. The **head** is found from the root
(`lobbyId`, whose admin is the creator and whose members are `[creator]`) by
repeatedly choosing, among the rosters `R` with `R.prev = node` and
`R.body.seq = node.seq + 1` (root has seq 0):

1. rosters authored by `node.admin` (the incumbent): lowest msgId wins;
2. otherwise **takeover** rosters authored by a member of `node` with
   `R.body.admin = R.author`: the author with the lowest index in
   `node.members` wins, ties by lowest msgId.

Rosters by anyone else are ignored. A roster's `members` is the full ordered
membership after it. A roster is also ignored unless **every member entry is
bound**: either the creator's (`pub` = the `lobby.create` author, `name` = its
name, `joinId = lobbyId`) or a `lobby.join` of this lobby whose msgId is
`joinId`, whose author is `pub` and whose `body.name` is `name` (so an admin can
neither rename, swap names between devices, nor seat a phantom pub; the UI
identifies "me" by pub, never by a locally chosen name). A takeover roster
(rule 2) must keep `node.members` unchanged (same entries, same order). The incumbent always beats a takeover at the same parent,
so a returning admin cannot be locked out; joins on a losing branch are simply
admitted again by the winning admin (join envelopes are independent).

### 4.5 Leave, kick, admin handoff and takeover

* **Leave:** publish `lobby.leave`. If this seat is in a non-terminal game,
  the phase is not ASSASSINATION, and the pending step is not a §3.7 rule-2a
  `mt/m` for which this seat's tally is journaled, first publish
  `cancel {reason: 'leave'}` (the outcome message is "NAME left the game", as
  today); in the two excepted cases the seat only leaves. The admin's client
  removes the member in its next roster. The leaver's UI disconnects
  immediately.
* **Admin leaving:** first publish a roster handing off (`admin` = the first
  other member in member order, the same rule as today's
  `eligibleUsers[0]`), then leave. If no other member remains, publish a
  roster with `closed: true`.
* **Kick:** the admin publishes a roster without the member. Disabled while a
  game is non-terminal ("Cancel game first", as today). A client that is not in
  the head roster's members gets `DISCONNECTED_FROM_LOBBY`.
* **Takeover:** if the admin's presence has not been received for 60 s
  (local receipt time), the UI offers "[Take over as admin]" to the first
  non-admin member only. It never happens automatically. A takeover roster is
  ordered by §4.4.
* **Reclaim:** the incumbent admin's client, on seeing a takeover roster that
  is a child of a roster it authored while its own presence is live,
  immediately publishes a sibling roster (same `prev`, same `seq`) with
  unchanged membership and itself as `admin`; by §4.4 rule 1 the sibling wins.
  It does not do this once a game has started (step `key` complete) on the
  takeover branch: that takeover then stands (the running game stays current
  anyway, §4.6.4), and the new admin can hand the lobby back by an ordinary
  handoff roster. A mere config on the takeover branch, or a non-terminal game
  of either branch, does not stop the reclaim. To keep a member from hijacking a
  live admin with a takeover and a config published in one burst: the ousted
  admin never keys a config whose base chain contains an open takeover of its
  own roster (it reclaims instead, and `key` needs every seat), and every other
  seat keys such a config only once the takeover roster is at least 60 s old in
  local receipt time (it re-checks then), giving a live admin time to reclaim. A
  takeover is *open* until a config based on a roster at or after it has `key`
  complete.
* **Roster changes during a game.** A device seated in the lobby's current,
  non-terminal game stays attached to the lobby (and the game) even if a roster
  drops it (a takeover branch, a malicious kick): it leaves once the game is
  terminal and its end is shown.

### 4.6 Starting a game

1. The admin publishes `lobby.config` with `prev` = head roster msgId (if a
   config already names the head roster as `prev`, e.g. the previous game of an
   unchanged lobby, it first publishes a no-op roster `{seq: head.seq + 1,
   admin: self, members: head.members, rejected: [], closed: false}` and uses
   that as `prev`, so the new config is alone at the highest roster seq and
   cannot lose the item-4 tie-break to an old, terminal game):
   `gameId` (16 random bytes), `seats` = exactly the head roster's members in
   the admin's chosen order (`config.sortList`), `selectedRoles`, `options`,
   `rulesHash`.
2. Each seated client **accepts** by publishing its `key` message (§5.2) iff
   all of the following hold, and otherwise shows why it does not:
   * the config's author is the head roster's admin, `prev` is on the head
     chain, and every roster between `prev` and the head has the same `admin`
     and `members` as `prev` (it only appends `rejected` entries, §4.3), so a
     join request arriving between config and keys cannot stall the start;
   * no open takeover on the chain up to `prev` ousted this seat, and every open
     takeover there was received at least 60 s ago (§4.5; a temporary refusal,
     re-checked);
   * `{pub, name}` of the seats equal the head members (same set);
   * `5 ≤ n ≤ 10`, names valid and unique, pubs unique;
   * `selectedRoles` ⊆ selectable role names, unique, in ROLES order;
   * `rulesHash` equals its own `RULES_HASH` (otherwise "Reload to update",
     before anything secret exists);
   * it has no `games` record for this `gameId` with a different `configId`;
   * it has seen no other `lobby.config` with the same `body.gameId` (see
     item 3);
   * it is not in another non-terminal game (statuses `abandoned`, `lost` and
     `superseded` do not count).
   Before signing `key` it writes the `games` record with a fresh `gs_j` to
   IndexedDB (§2.5).
3. The game starts when step `key` completes (all `n` keys). Two conflicting
   configs (admin equivocation, or two admins after a fork) cannot both start:
   each seat accepts at most one, and `key` requires every seat. If `key` is
   not complete after 30 s the admin's UI offers "[Abort start]" (= `cancel`
   at `key`, reason `'abort'`; nothing secret exists yet, the reveal that
   follows is harmless).
   * **Config equivocation.** Two `lobby.config` envelopes of one lobby with
     equal `body.gameId` and different msgIds share the game souls; they are
     admin equivocation. Clients that have seen both refuse to key. The game
     with that `gameId` (under either `configId`) is terminal as
     `INVALID(admin, "config equivocation")` at step `key`, evidence = both
     configs (§3.7 rule 4; nothing secret exists unless the second config
     surfaces late, and then the reveals end the game like any `INVALID`).
     `reduceGame` receives the lobby's other configs with the same `gameId`
     for this check (§11.2). Keys that name the other config as `prev` are
     merely absent (§3.6), so no honest seat is blamed.
   * **Superseded.** A seat whose accepted config is no longer the lobby's
     current game (item 4) while its `key` step is incomplete marks that game
     `superseded`: terminal, nothing published or revealed, excluded from the
     "another non-terminal game" check, so it can accept the current config.
     A superseded game is never resumed by this device; if its `key` step
     later completes anyway, this seat withholds at the next step and the
     others cancel (liveness only, its `x_j` was never used).
4. The **current game** of a lobby: once step `key` of a config completes,
   that game stays the lobby's current game until it is terminal, regardless
   of later roster forks (roster fork choice does not apply to a running game;
   if several started games are non-terminal, the lowest `configId`).
   Otherwise it is the config with the highest roster seq whose `prev` is on
   the head chain (ties by msgId; item 1 keeps an honest admin's new config
   from ever tying with an earlier one). After the game is terminal, `lobby.game`
   keeps showing it until the next config.

While a config is pending or a game is non-terminal the admin's client rejects
joins (`'game-active'`, as rejection-only rosters, §4.3), defers membership
changes and disables kick, as today.

### 4.7 Projection to `LobbyData`

```
LobbyData = {
  name:  CODE,
  admin: { uid: head.admin, name: member name of head.admin },
  users: { [name]: { name, uid: pub } } for head.members,
  game:  project(current game) or { state: 'INIT', phase: '', players: [], roles: [], missions: [] }
}
```

---

## 5. Game protocol

Notation: `n` seats `0..n-1` in config order; `N = n` cards; `x_j` seat `j`'s
secret, `y_j = x_j·G`, `Y = Σ_j y_j`. `(A, B)` is an ElGamal ciphertext
encrypting point `M` under key `Z` as `(ρ·G, M + ρ·Z)`;
`ReEnc_ρ(A, B) = (A + ρ·G, B + ρ·Y)`.

### 5.1 Deck derivation and sight rule (exact port of `assignRoles`)

```ts
function deriveDeck(n: number, selected: string[]): CardLabel[] {
  const numEvil = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 }[n];
  const makeTeam = (size: number, team: 'good' | 'evil'): string[] => {
    const teamRoles = ROLES.filter(r => r.team === team);                 // ROLES order
    const specials = teamRoles.filter(r => selected.includes(r.name)).slice(0, size);
    const filler = teamRoles.find(r => r.filler)!;
    return [...specials.map(r => r.name), ...Array(size - specials.length).fill(filler.name)];
  };
  const evil = makeTeam(numEvil, 'evil').map(role => ({ role, assassin: false }));
  const good = makeTeam(n - numEvil, 'good').map(role => ({ role, assassin: false }));
  if (selected.includes('MERLIN')) {            // lodash _.maxBy: first maximum wins
    let best = 0;
    evil.forEach((l, i) => { if (prio(l.role) > prio(evil[best].role)) best = i; });
    evil[best].assassin = true;
  }
  return [...evil, ...good];                    // canonical deck order
}
```

* `Λ` = distinct labels of the deck in first-occurrence order;
  `N_roles = (ν_0..ν_{R-1})` = distinct role **names** in play, in ROLES order;
  `idx(name)` = position in `N_roles`.
* **Sight rule:** `seen(viewerName, targetName) = ROLES[viewerName].sees.includes(targetName)`.
  It depends on role **names only**; the assassin flag never changes
  visibility (today's `assignRoles` compares `r2.role.name == seenRole`).
  (The draft's "assassin card counts as ASSASSIN" rule was wrong: it showed an
  assassin-flagged Mordred to Merlin and hid an assassin-flagged Morgana from
  Percival.)
* The public `game.roles` is the deck's role names in canonical order.

### 5.2 Step `key`

Seat `j`: `x_j = stream("x").scalar()`, `y_j = x_j·G`,
`seed_j = stream("seed").bytes(32)`,
`seedCommit = hex(SHA256(utf8("avalon-p2p/v1/seed\0") ‖ configId ‖ u8(j) ‖ seed_j))`,
`pok` = proof `pok` (stepId `key`). Validation: `y_j ≠ O`, all `y_j` distinct,
proof valid. After completion `Y = Σ y_j` (must be `≠ O`). The PoK binds
`configId` and the prover's pub, so a key cannot be copied, replayed from
another game or chosen as a rogue key.

### 5.3 Steps `shuf/0..n-1`: verifiable shuffle (Terelius-Wikström)

Input deck of `shuf/0` is the canonical initial deck `(O, M(deck[i]))`,
`i = 0..N-1`, recomputed by every client from the config. The input of
`shuf/j` is the output of `shuf/j-1`.

**Prover (seat j)**, with `st = stream("shuffle", SHA256(enc(Y) ‖ enc(in)))`:

1. `π = st.perm(N)`; `ρ_i = st.scalar()` for `i = 0..N-1`;
   output `out_i = (Ã_i, B̃_i) = ReEnc_{ρ_i}(in_{π(i)})`.
2. `r_j' = st.scalar()` for every input index `j'`; permutation commitment
   indexed by **input** position: `c_{π(i)} = r_{π(i)}·G + H_i`.
3. Challenges `u_{j'} = H2S("avalon-p2p/v1/shuffle-u", lp(utf8("avalon-p2p/v1")) ‖ configId ‖ lp(utf8(stepId)) ‖ lp(utf8(prover)) ‖ enc(Y) ‖ enc(in) ‖ enc(out) ‖ enc(c_0..c_{N-1}) ‖ u32(j'))`, where `enc(deck)` concatenates `enc(A_i) ‖ enc(B_i)`.
   `u'_i = u_{π(i)}`.
4. Commitment chain: `ĉ_{-1} = H₀`; `r̂_i = st.scalar()`;
   `ĉ_i = r̂_i·G + u'_i·ĉ_{i-1}` for `i = 0..N-1`.
5. Witnesses: `r̄ = Σ r_{j'}`, `v_i = Π_{t=i+1}^{N-1} u'_t` (`v_{N-1} = 1`),
   `r̂ = Σ r̂_i·v_i`, `r̃ = Σ r_{j'}·u_{j'}`, `ρ̄ = −Σ ρ_i·u'_i` (all mod `L`).
6. Proof `shuffle` (§2.6) over the derived values
   `c̄ = Σ c_{j'} − Σ_i H_i`, `ĉ = ĉ_{N-1} − (Π u_{j'})·H₀`,
   `c̃ = Σ u_{j'}·c_{j'}`, `Â = Σ u_{j'}·A_{j'}`, `B̂ = Σ u_{j'}·B_{j'}` with the
   equations, witness order `[r̄, r̂, r̃, ρ̄, r̂_0..r̂_{N-1}, u'_0..u'_{N-1}]`:

   ```
   E1:  c̄   = r̄·G
   E2:  ĉ   = r̂·G
   E3:  c̃   = r̃·G + Σ_i u'_i·H_i
   E4:  Â   = ρ̄·G + Σ_i u'_i·Ã_i
   E5:  B̂   = ρ̄·Y + Σ_i u'_i·B̃_i
   E6_i: ĉ_i = r̂_i·G + u'_i·ĉ_{i-1}        (i = 0..N-1)
   ```

   The statement's `aux` (§2.6.2) is
   `SHA256(enc(in) ‖ enc(out) ‖ enc(c_0..c_{N-1}))`, so the final challenge
   hashes the full public input (input deck, output deck and every
   permutation commitment) directly, as in the CHVote/Verificatum transcript,
   and not only through `u`. WP-A pins it with a test vector.
7. Body: `{deck: out, c: [c_0..c_{N-1}], chat: [ĉ_0..ĉ_{N-1}], proof}`.

**Verifier:** decode; every `Ã_i ≠ O`; recompute `u`, the derived values and
the statement; verify (batched). Soundness `≈ 2^-128` per shuffle (it is the
Verificatum/CHVote argument), so it cannot be ground offline, unlike the
draft's 40-round cut-and-choose. Prove ≈ 7N scalar multiplications, verify ≈
one MSM of ≈ 9N points (≈ 15-30 ms at N = 10 on desktop V8). The relations
were checked numerically against a prototype.

**Pipelining:** seat `j+1` may shuffle as soon as `shuf/j` is structurally
complete; nothing secret is released until **every** shuffle proof verified
(the `deal` gate, §3.6). Privacy of the final permutation holds if at least one
shuffler is honest.

### 5.4 Step `deal`

Gate: all keys and all shuffle proofs verified, every final `A_i ≠ O`. Seat
`j` publishes `d_{j,i} = x_j·A_i` for every `i ≠ j` (null at `i = j`) and one
proof `deal` (a single DLEQ for all `i`, witness `x_j`). Every client derives

```
C_i = B_i − Σ_{j ≠ i} d_{j,i}          // an ElGamal encryption of M_i under y_i alone
```

and seat `i` decrypts `M_i = C_i − x_i·A_i` and finds its label `λ_i` with
`M(λ_i) = M_i` (always exists once proofs verified). Publishing the shares in
the clear is safe under DDH: `C_i` is still `(A_i, M_i + x_i·A_i)`. The draft's
SEA-encrypted variant is dropped: it added nothing, needed admin-supplied
`epub`s, and made bad shares unattributable. There are no SEA private
messages anywhere in the protocol.

### 5.5 Steps `otR`, `otS`: the sight exchange (verifiable 1-of-R OT)

Viewer `Q` must learn, for each other seat `P`, the bit
`seen(name(λ_Q), name(λ_P))` and nothing else; `P` must learn nothing about
`λ_Q`; neither may lie.

**Receiver message (`otR`, one per seat, used by every sender):**
`c_Q = idx(λ_Q.role)`, `β_Q = stream("ot-beta").scalar()`,
`U_Q = β_Q·G + c_Q·S`, proof `ot-recv` (real branch: `λ_Q`'s position in `Λ`).
It proves that `U_Q` commits to the role-name index of the card `Q` actually
holds (a Loyal Follower cannot choose Merlin's index), and that `Q` knows
`β_Q`. `U_Q` is perfectly hiding. `Q` knows the discrete log of
`PK_{Q,r} = U_Q − r·S` only for `r = c_Q` (two would yield `log_G S`).

**Sender message (`otS`, one per seat)**, gate: all `otR` proofs verified.
Seat `P` with label `λ_P`, profile bits `s_r = seen(ν_r, λ_P.role)`:

```
F_r     = (f_r·G,  s_r·G + f_r·J)                  r = 0..R-1, f_r = stream("ot-f", r)
E_{Q,r} = (k·G,    s_r·G + k·PK_{Q,r})             Q ≠ P, r = 0..R-1, k = k_{Q,r} = stream("ot-k", Q, r, U_Q)
profile = proof ot-profile   (real branch: λ_P)    // F encrypts the seen-vector of the card P holds
eq      = proof ot-eq                              // every E_{Q,r} encrypts the same s_r as F_r
seed    = seed_P                                   // beacon reveal, must match seedCommit
```

Body: `F` (length R), `E` (length n, indexed by receiver seat, `null` at `P`,
each an array of R ciphertexts indexed by `r`).

**Decoding:** `Q` computes, for each `P ≠ Q`,
`X = E_{Q,c_Q}.b − β_Q·E_{Q,c_Q}.a`; the proofs guarantee `X ∈ {O, G}`
(`G` = seen). `sees` = names of seats with bit 1, **in seat order** (seat
order is independent of roles because the deck is shuffled; the server's
random shuffle served the same purpose).

Why it is secure:

* *Receiver privacy:* `U_Q` is perfectly hiding and its proof is
  zero-knowledge.
* *Sender privacy:* for `r ≠ c_Q`, `E_{Q,r}` is an ElGamal encryption under a
  key whose discrete log nobody knows (DDH); `k_{Q,r}` is fresh per pair and
  per index (sharing `k` across receivers would let two receivers decrypt
  every index); `F_r` is ElGamal under `J` (DDH), so the profile stays hidden.
* *No lying, no tagging, no selective failure:* `profile` binds the bits to
  `P`'s real card and `eq` binds every receiver's ciphertexts to the same bits
  (the shared witness `f_r`, pinned by `F_r.a = f_r·G` in both proofs). An evil
  player cannot hide from Merlin, cannot answer differently per receiver, and
  cannot corrupt only the Merlin index to watch for an error. No OT secret is
  ever revealed.
* Every client verifies **all** `otR` and `otS` proofs and decodes its `n − 1`
  entries regardless of role (§9).

**Beacon and first proposer:** once `otS` completes, every `seed_j` is checked
against `seedCommit_j` (mismatch: `INVALID(j, "seed")`), and
`firstProposer = int_be(SHA512(utf8("avalon-p2p/v1/beacon\0") ‖ configId ‖ seed_0 ‖ ... ‖ seed_{n-1})) mod n`.
The seeds were committed before any shuffle, so the last shuffler cannot grind
the first proposer (the draft's `H(transcript) mod n` could be).

When `otS` completes and verifies, the game becomes `ACTIVE` in phase
`TEAM_PROPOSAL` with proposal `(0, 0)` proposed by `firstProposer`.

### 5.6 Game rules (port of `server/avalon-server.ts`)

* Mission team sizes per `n`: 5 `[2,3,2,3,3]`, 6 `[2,3,4,3,4]`, 7 `[2,3,3,4,4]`,
  8-10 `[3,4,4,5,5]`. `failsRequired = 2` for mission index 3 when `n ≥ 7`,
  else 1.
* Proposers rotate: each new proposal (after a rejection, or the first
  proposal of the next mission) is proposed by the seat after the previous
  proposal's proposer (`proposalTemplate`).
* A proposal is approved iff approvers `≥ floor(n/2) + 1`. A rejection of
  proposal index 4 ends the game: `EVIL_WIN`, "Five team proposals in a row
  rejected".
* A mission fails iff `numFails ≥ failsRequired`. Three failed missions:
  `EVIL_WIN`, "Three failed missions". Three successful missions:
  `ASSASSINATION` phase if MERLIN is in play, else `GOOD_WIN`, "Three missions
  succeeded".
* `hammer`, `lastProposal`, `currentProposer` etc. are computed by the existing
  client `Game` class from the projected `GameData`.

### 5.7 Step `p/<m>/<p>`: team proposal

The proposer publishes `{team}`: seat indices, strictly ascending, length =
team size of mission `m`. Anything else is `INVALID(proposer, "invalid
team")`. (The UI passes names; the client maps them to seats and sorts.)

### 5.8 Steps `vc/<m>/<p>`, `vr/<m>/<p>`: proposal vote (simultaneous reveal)

```
nonce  = stream("pvote", "vc/<m>/<p>", prev).bytes(32)           // prev = D before vc
commit = hex(SHA256(utf8("avalon-p2p/v1/pvote\0") ‖ prev ‖ u8(seat) ‖ u8(approve ? 1 : 0) ‖ nonce))
```

`vc`: each seat publishes `{commit}` when its player votes. `vr`: as soon as
`vc` is complete, each client automatically publishes `{approve, nonce}` (its
`prev` is `D` after `vc`, which binds the exact set of `n` commits). A reveal
that does not open its commit is `INVALID(seat, "vote reveal does not match
commit")`. The commit binds the step digest and the seat, so a commit cannot be
copied (mirror voting) or reused. Approvers become `proposal.votes`.

### 5.9 Steps `mv/<m>`, `mt/<m>`: mission vote and tally

**Ballot (`mv/m`, each member of the approved team).** The player clicks
SUCCESS or FAIL. A good player's FAIL is silently cast as success (`v = 0`),
exactly like today's server-side flip. With `v ∈ {0, 1}` (1 = fail),
`r = stream("ballot", stepId, prev, v)`:

```
ballot = (a, b) = (r·G,  v·G + r·Y)          // under the joint key of all seats
proof  = ballot  (branch 0 if v = 0, else the branch of the player's own evil label)
```

The single CDS proof shows `v ∈ {0, 1}`, that `v = 1` only for an evil card
(good cannot fail), and knowledge of `r` (so a ballot cannot be a copy or
re-randomization of another ballot, and `a` cannot be a card component such as
`A_Q`, which would turn the tally into a decryption oracle for `Q`'s card). The
proof is computed at click time for every player, with identical work for all
branches.

**Tally (`mt/m`, all seats, automatic).** Gate: `mv/m` complete, every ballot
proof verified, all `a` distinct and `≠ O`, and no `tally` for `m` in this
seat's journal. Each seat publishes `D_{j,m} = x_j·T_m` with
`T_m = Σ_{team} a` (computed locally) and proof `tally`. Then

```
W = Σ_{team} b − Σ_j D_{j,m} = k·G,    numFails = k ∈ [0, teamSize]   (by trial)
```

All seats contribute (rather than only the team) so that every seat has a
message at `mt/m`. At the `mt/m` that can lead to the assassination (two
successes so far, MERLIN in play), a seat that published its tally and also
cancels at `mt/m` is `INVALID(X, "canceled and continued")` (§3.7 rule 2a),
so a sore-loser cancel after the assassin's choice is self-incriminating; a
seat that withheld its tally is named as withholding (§3.7), and a withheld
terminal result is restored from the reveals (§3.7 rule 5a). Decrypting only the sum reveals only `k`;
individual votes open at the end with each voter's `r` (§5.12), so one missing
seat cannot hide everyone's votes.

### 5.10 Step `as`: assassination

Only the assassin's client (own label has `assassin = true`) offers target
selection; the target must be another seat (today's UI rule). Body:
`{target, open: O_a = x_a·A_a, proof: open}`. Valid iff the proof verifies and
`C_a − O_a = M(λ*)` for the deck's assassin label `λ*`; this publicly reveals
the assassin's card, exactly like announcing the assassination at the table. A
valid opening of any other card is `INVALID(author, "false assassination
claim")`. Two different valid assassinations by the assassin are
equivocation. The step is terminal; the target's role comes from the reveal.

### 5.11 Decryption allow-list (normative)

Card `i` is encrypted under `y_i` alone and every other share is public, so any
publication of `x_j·P` for an adversary-influenced `P` could be a decryption
oracle. An honest seat `j` publishes a multiple of `x_j` **only** for:

1. `A_i` of the final deck, `i ≠ j`, at `deal`, once, after every key and
   shuffle proof verified;
2. `T_m` at `mt/m`, once per mission, after every ballot proof of `mv/m`
   verified, with `T_m` computed locally from the agreed ballots;
3. `A_j` at `as`, only if `j` holds the assassin card;
4. `x_j` itself at `reveal`, only once the outcome is terminal (§3.7).

Local uses (decrypting its own card, OT decoding with `β_Q`, proofs) are not
publications. Code MUST keep `x_j` inside the builders for these four messages
(`common/protocol/build.ts`), and the once-only journal (§3.9) MUST be
consulted before each. `β_Q`, `f_r` and `k_{Q,r}` are never revealed. Ballot
randomness `r` is revealed only at the end.

### 5.12 End of game: reveal, outcome and audit

When the outcome is terminal (§3.7), every seat automatically publishes
`reveal {x: x_j, ballots: [{m, r}], basis}` with a ballot entry for every
mission whose approved team included it (on cancel and invalid games too:
that is when "the game is over"). `basis` is the msgId list of §3.7 rule 3
(the `basis` of `GameEval.terminal`); the client re-puts each basis envelope
from its transcript immediately before publishing the reveal. A reveal is valid iff `x·G = y_j` and, for each listed ballot,
`a = r·G` and `b − r·Y ∈ {O, G}`; an invalid reveal is listed in `cheaters`
("invalid reveal") and treated as missing.

From valid reveals: `λ_j` = the label with `M(λ) = C_j − x_j·A_j`; ballot
`v = 0` if `b − r·Y = O`, else 1. **Elimination:** let the *unresolved
labels* be the deck multiset minus the known labels.
* If exactly one seat is unknown, or all unresolved labels are identical,
  every unknown seat has that label.
* Otherwise, if all unresolved labels belong to one team `T`, every unknown
  seat is on team `T` (its role stays `'UNKNOWN'`, but its **team** is known
  for §5.13).
* For each mission, if exactly one team member's ballot is unknown, its vote
  is `k_m − Σ known v`.
* A game that ended during `MISSION_VOTE` (a cancel at `mv/m`): once every key
  is revealed, the ballots already cast at `mv/m` (prev = the head digest, one
  per team seat) are opened like any other, as the legacy server showed them;
  a team member who had not voted has no vote.

Anything still unknown is `'UNKNOWN'` (role) or absent (vote), and the seat is
listed in `unrevealed`.

**Audit** (defense in depth; with sound proofs it cannot fail, so a failure
indicates a bug and is reported as `cheaters: [{name, reason: 'audit: ...'}]`):
every known card decrypts to a label; known labels form a sub-multiset of the
deck; per mission, known votes are consistent with `k_m`; no good player has
`v = 1`; the assassin's opening matches; every rule of §5.6 replays to the
same state. No OT secrets need revealing: the OT proofs already exclude lying.

**When the UI shows the end:** `GAME_ENDED` fires when the outcome is
terminal and either every seat has revealed or 20 s have passed locally;
later reveals keep updating `outcome` (roles, votes, `final`).

### 5.13 Outcomes

| Condition | `state` | `message` |
|---|---|---|
| 3 failed missions | `EVIL_WIN` | `Three failed missions` |
| 5th proposal rejected | `EVIL_WIN` | `Five team proposals in a row rejected` |
| 3 successes, MERLIN not in play | `GOOD_WIN` | `Three missions succeeded` |
| assassination, target is MERLIN | `EVIL_WIN` | `Merlin assassinated` (`assassinated` = target) |
| assassination, target not MERLIN | `GOOD_WIN` | `Three successful missions` (`assassinated` = target) |
| assassination, whether the target is MERLIN undetermined, all unresolved labels on one team `T` (necessarily good, since MERLIN is among them) | win for `T`'s opponent | `Assassination unresolved: NAMES did not reveal; <T> forfeits` |
| assassination, whether the target is MERLIN undetermined, unresolved labels on both teams | `CANCELED` | `Assassination unresolved: NAMES did not reveal` |
| cancel at `mt/m` or `vr/m/4` whose withheld result is terminal (§3.7 rule 5a) | the natural result | natural message + ` (NAME withheld the tally)` / ` (NAME withheld the vote)` |
| cancel | `CANCELED` | `Canceled by NAME` / `NAME left the game` / `NAME aborted the start` / `NAME lost their game keys` (+ `, waiting for A, B` / ` while withholding the mission result`) |
| `INVALID(X)`, X's team known (revealed, by elimination, or because all unresolved labels are on one team) | win for the other team | `NAME cheated (reason); <team> forfeits` |
| `INVALID(X)`, X's team unknown (X unrevealed, unresolved labels on both teams, or no cards dealt yet) | `CANCELED` | `Game invalid: NAME cheated (reason)` |

The forfeit rule makes cheating (including the sore-loser cancels of §3.7
rules 2 and 2a) a loss rather than a free void. Using the deck multiset for
the team of unrevealed seats means two cooperating non-revealers of one team
(e.g. an assassinated Merlin and a Loyal Follower who both close their tabs)
cannot turn their team's loss into `CANCELED`; only non-revealers from both
teams together can, which needs a player acting against their own team.
Equivocation is the only `INVALID` an honest device could conceivably
produce, and §3.9 (journal, Web Locks, no regeneration) prevents it (a wrong
`prev` is absence, not a fault, §3.6).

```ts
// GameOutcome as defined in common/protocol/views.ts (WP-B, §11.2); client/src/types.ts re-exports it
interface GameOutcome {
  state: 'GOOD_WIN' | 'EVIL_WIN' | 'CANCELED';
  message: string;
  assassinated?: string;
  roles: RoleAssignment[];                 // role may be 'UNKNOWN'
  votes: Record<string, boolean>[];        // votes[m][name] = true for SUCCESS; key absent if unknown
  final: boolean;                          // every role and every vote known
  unrevealed: string[];
  cheaters: { name: string; reason: string }[];
  canceledBy?: string;
  stalled?: string[];
}
```

### 5.14 Sizes and costs (n = 10, R ≤ 7 role names, |Λ| ≤ 7 labels)

| Message | Size (base64url) | Prove | Verify (each, batched MSM) |
|---|---|---|---|
| `key` | 0.3 KB | 1 mult | ≈ 1 ms |
| `shuffle` | 3.5 KB | ≈ 70 mults (≈ 0.1 s) | ≈ 20 ms |
| `deal` | 1 KB | ≈ 20 mults | ≈ 5 ms |
| `ot.recv` | 2 KB | ≈ 40 mults | ≈ 10 ms |
| `ot.send` | 22 KB | ≈ 500 mults (≈ 0.5 s) | ≈ 600-point MSM (≈ 0.1 s) |
| `ballot` | 1.5 KB | ≈ 40 mults | ≈ 10 ms |
| `tally` | 0.3 KB | 2 mults | ≈ 2 ms |

These are estimates from measured noble timings (variable-base mult
1.1-1.75 ms, fixed-base 0.27-0.4 ms, MSM of 400 points 83 ms). Per client
for a 10-player game: ≈ 1 s to prove and ≈ 1.5-2 s to verify on desktop V8,
3-6× that on phones, all in a Web Worker pool. A game is ≈ 300 KB and ≈ 300
messages.

---

## 6. Logs and stats

* **Logs.** When a game with outcome `GOOD_WIN` or `EVIL_WIN` (including
  forfeits) becomes `final`, or 120 s after it became terminal, each seat
  publishes one `log` envelope (`prev` = terminal digest, built by
  `buildLog`, §11.2; driver row in §7.7) into `avalon/v1/logs/<YYYY-MM>#`:

  ```ts
  export interface LogBundle {
    gameId: B64; configId: Hex32; lobbyCode: string;
    outcome: GameOutcome;                       // §5.13
    missions: Mission[];                        // as projected (common/protocol/views.ts, the client/src/types.ts shape)
    players: { name: string; uid: Pub }[];      // seat order
    options: { inGameLog: boolean };
    createdAt: number;                          // config envelope t (informational)
  }
  ```

  Canceled games are not logged (as today). Logs are signed records "seat X
  says this happened"; they are not used for stats, because one person with
  several device keys could fabricate entire games.
* **Per-user stats** are computed locally from the IndexedDB `history` store
  (one entry per finished game this device played) with a port of
  `firebase/functions/common/stats.js` `computeStats`: `{games, good, evil,
  wins, good_wins, evil_wins, playtimeSeconds}`. Only `GOOD_WIN`/`EVIL_WIN`
  games where this device's own role is known count. `playtimeSeconds` uses
  local time from `key` completion to terminal.
* **Global stats** are dropped: `globalStats = null` (StatsDisplay already
  hides them). They could only be computed from forgeable public logs.

---

## 7. Client runtime

### 7.1 GUN instance

```ts
import Gun from 'gun';
import 'gun/sea';
const gun = Gun({ peers: [location.origin + '/gun'], localStorage: false, radisk: false });
```

* GUN's browser `localStorage` adapter is off: it keeps the whole graph in one
  5 MB key, re-serializes it on every write and, once full, makes the app's own
  `localStorage` writes fail. All app state is in IndexedDB (§3.9).
* `gun`, the driver, the worker pool and noble objects are module-level
  singletons or wrapped in `markRaw()`; only plain JSON snapshots (`LobbyData`,
  `RoleDoc`, status) enter Vue reactivity.
* Content-addressed puts need no GUN user session. Only presence writes to user
  space; they are queued until `gun.user().auth(pair)` resolves.
* SEA logs rejected writes to the console; the e2e `isErrorIgnorable` filter
  ignores `"Data hash not same as hash!"` and `"Signature did not match"`.

### 7.2 Clock

HAM defers any update whose state is in the future (`if (state > now)
setTimeout(...)`, also on the relay), so a phone whose clock is fast would see
its messages delayed by the skew. At startup and every 10 minutes the client
fetches `GET /api/relay-info` → `{ bootId: string, now: number }` and sets
`Gun.state.drift = now + rtt/2 − Date.now()`. Envelope `t` values use the
corrected clock. No protocol decision uses any clock.

### 7.3 Subscriptions

One `SubscriptionManager` per GUN instance, one GUN subscription per soul,
ref-counted internally:

* lobby: `gun.get('avalon/v1/lobby/<CODE>#').map().on(h)`;
* game: `gun.get('avalon/v1/game/<gameId>/setup#').map().on(h)` and
  `.../play#` likewise, subscribed **as soon as the config is seen**, in that
  order, by every seat regardless of role;
* presence: `gun.get('~' + pub).get('avalon_v1_presence').on(p)` for every
  roster member, in member order.

`h` runs the ingestion pipeline (§3.4). Never use `.once` for protocol
decisions (it resolves after a 99 ms quiet period with partial data). Never
call `.off()` (it tears down shared chains): when the subscribed set must
shrink (leaving a lobby, 10 minutes after a game ended), create a fresh GUN
instance. Backstop: while any step has been pending for more than 10 s,
re-ask the lobby, setup and play souls every 15 s with
`gun._.opt.mesh.say({ get: { '#': soul } })`, which bypasses GUN's local
cache.

### 7.4 Transport watchdog and republish

GUN's websocket adapter retries once after about 2 s and then never again
(measured: outages ≥ 3 s leave `peers: 0` forever), and puts made while
disconnected are never pushed on reconnect.

* Track root `hi`/`bye`. If no wire is open for 2 s, call
  `gun.opt({ peers: [RELAY_URL] })` with backoff 1, 2, 4, 8, then every 15 s,
  forever. Also trigger on `online`, `pageshow` and `visibilitychange` to
  visible.
* On every `hi` and at startup, re-put every journal entry (§3.9) of the active
  lobby and game (idempotent: content-addressed), then re-ask the souls
  (§7.3).
* When `/api/relay-info` returns a new `bootId` (relay restarted, possibly with
  an empty disk), also re-put the **entire** verified transcript of the active
  lobby and game from IndexedDB, after a random 0-5 s delay. Envelopes are
  self-authenticating, so any client may restore any author's messages.
* While this seat's own required message for the pending step has not come
  back from the relay, re-put it every 30 s.
* Only a relay echo counts as "sent" in the UI.

### 7.5 Worker pool

All proving and verification run in `client/src/p2p/crypto.worker.ts`
(`new Worker(new URL('./crypto.worker.ts', import.meta.url), { type: 'module' })`),
pool size `max(1, min(4, navigator.hardwareConcurrency − 1))`. Jobs are pure
and take encoded inputs (§11.2 `jobs.ts`). A verification verdict is keyed by
the message's `msgId` (which binds `prev`, hence the full statement) and cached
in IndexedDB, so a reload does not redo work. Provers precompute fixed-base
tables for `G`, `Y` and each `y_j` once per game; verifiers use
`multiplyUnsafe` and batched MSM.

### 7.6 Presence and device liveness

* Every 10 s and on visibility changes, write to user space
  `avalon_v1_presence` the string `canon({lobby, game, seq, vis, head})`
  (`seq` increments; `vis` 1 if the page is visible; `head` = first 8 hex of
  the local head digest). It carries nothing role-dependent.
* A member is **online** if a new `seq` arrived within the last 30 s of local
  receipt time (sender timestamps are never compared).
* Only a value signed by the soul's own key counts: the stored SEA value must
  have exactly the keys `:` and `~`. (SEA verifies a value carrying `*` against
  that embedded pub instead, and skips the certificate check without `+`, so
  any key pair could otherwise write another user's presence; the relay
  refuses such values too, §8.)
* While a game is non-terminal the client holds a screen Wake Lock
  (`navigator.wakeLock.request('screen')`, re-acquired on visibility) and, on
  becoming visible, reconnects and immediately runs pending automatic steps.

### 7.7 Automatic actions of the driver

| Step | Acts when | Gate (all MUST hold) |
|---|---|---|
| `key` | config accepted (§4.6) | `games` record with `gs_j` committed |
| `shuf/j` | `shuf/j-1` structurally complete (or `key` complete for j = 0) | `key` verified |
| `deal` | all shuffles present | every key and shuffle proof verified; final `A_i ≠ O` |
| `otR` | `deal` complete | every deal proof verified; own card decrypts to a label |
| `otS` | `otR` complete | every `otR` proof verified |
| `vr` | `vc` complete | — |
| `mt` | `mv` complete | every ballot proof verified; `a` distinct, `≠ O` |
| `reveal` | outcome terminal (no reveal pending, §3.7 rule 3) | basis computed; every basis envelope re-put first |
| `log` | outcome `final`, or 120 s (local) after it became terminal | outcome `GOOD_WIN` or `EVIL_WIN` (§6) |

Human actions (`propose`, `vote.commit`, `ballot`, `assassinate`, `cancel`)
are published only from UI calls, and only for the current pending step. After
publishing (or ingesting) a cancel that ends the game, the driver publishes
nothing but its `reveal` (and later its `log`).

**Cancel.** When the user clicks Cancel, the driver first publishes its own
message for the pending automatic step (`vr`, `mt`) if that step's gate is
already open, then the cancel; so an honest canceller is never the sole
withholder (§3.7 rule 5a). Exception, §3.7 rule 2a: at an `mt/m` whose start
state has two successful missions and MERLIN in play, once this seat's own
tally is journaled the driver **never** publishes a cancel at `mt/m` (if the
click made it publish the tally, it stops there); the Cancel button is
disabled for that step and [Abandon] is offered after 60 s (§7.8). While a
reveal is pending in this client's view (§3.7 rule 3) the driver is
suspended and publishes nothing but a user-requested cancel.

### 7.8 Timeouts and UI states

Timers only drive UI (§3.8). They use `performance.now()` from when the step
became pending locally.

| Situation | UI |
|---|---|
| socket down > 3 s | banner "Reconnecting..." |
| socket down > 30 s | "Offline - your moves are saved and will be sent when reconnected" |
| automatic step pending 0-10 s | "Waiting for devices..." |
| automatic step pending > 10 s | list blocking seats with presence (online / screen off / offline since mm:ss), "Ask NAME to open Avalon" |
| automatic step pending > 60 s, or shuffle > 45 s | Cancel button emphasized for everyone |
| `key` incomplete > 30 s | admin: "[Abort start]" |
| human step whose actor is offline > 3 min | suggest Cancel |
| assassination pending and assassin offline > 3 min | "[Abandon]" (local only: stop waiting, no message, no reveal; `games.status = 'abandoned'`) |
| `mt/m` before a possible assassination (§3.7 rule 2a) pending > 60 s with own tally journaled | Cancel disabled ("Canceling now would forfeit"); "[Abandon]" as above |
| a reveal pending for missing basis messages (§3.7 rule 3) | "NAME revealed their keys citing messages this device has not received - waiting" + Cancel (during the assassination the assassin still acts, §3.7 rule 3) |
| this device offline (its relay socket is down) | no `STALLED`: it cannot judge anybody's absence; the connection banner explains the state |
| terminal, reveals missing after 60 s | "NAME did not reveal - results incomplete" |
| admin presence missing > 60 s | first non-admin member: "[Take over as admin]" |

Session status values (exposed by `P2PSession.status`): `CONNECTING`,
`SYNCING` (fetching and verifying, with percentage), `LOBBY`, `STARTING`
(keys n/N), `SETUP` (shuffle i/n, dealing, sight exchange), `ACTIVE`,
`STALLED {seats, sinceMs}`, `ENDING` (reveals n/N), `ENDED`, `LOST_SECRETS`,
`READ_ONLY_OTHER_TAB`.

---

## 8. Relay server and deployment

`server/` becomes an untrusted relay + static host with no game logic and no
dependency on `@avalon/common`.

* **Entry** (`server/server.ts`): Express serving `server/dist` (the built
  SPA), `GET /api/relay-info` → `{ bootId, now }` (`bootId` random per process
  start), `GET /healthz`, and the GUN relay on the same HTTP server:

  ```ts
  import './gun-shim';                    // must run before gun/sea in the esbuild bundle
  import Gun from 'gun';
  import 'gun/sea';
  await relaySelfTest();                   // throwaway relay on 127.0.0.1:0, exit(1) on failure
  const gun = Gun({ web: httpServer, file: process.env.GUN_DIR ?? './radata',
                    multicast: false, axe: false, localStorage: false });
  installRelayFilter(gun);
  httpServer.listen(PORT);                 // only after the self-test passed and the filter is installed
  ```

* **Bundling.** `yarn bundle:server` bundles gun into one ESM file, and SEA's
  dynamic `USE(x, 1)` requires then fail at runtime (`./lib/text-encoding`,
  `@peculiar/webcrypto`). Without SEA the relay accepts forged user-space and
  non-hash `#` writes and serves them in place of valid data (verified), which
  lets anyone stall any lobby. `server/gun-shim.ts` makes SEA use Node's
  built-in WebCrypto and TextEncoder:
  `import Gun from 'gun'; globalThis.self ??= globalThis; (globalThis as any).GUN = Gun; (globalThis as any).Gun = Gun;`
  (verified to give a working SEA sign/verify round trip in the bundle).
* **Boot self-test** (`relaySelfTest`). Local puts do not pass through wire
  `in` middleware (gun.js routes them through `put`/`out`), and the filter
  would drop non-whitelisted test data before SEA saw it, so the test uses a
  throwaway relay instance built from the same bundled `gun`/`gun/sea` code,
  on its own HTTP server bound to `127.0.0.1:0` with a temporary `file`
  directory, before the public server listens. Every probe is sent by a
  loopback websocket client (`Gun({ peers: ['http://127.0.0.1:<port>/gun'],
  localStorage: false, radisk: false })`), and every assertion reads the
  relay's own graph (`gun._.graph`) and its radisk store (the `rad` API on the
  temporary directory) after a 500 ms settle.
  1. **Without the filter** (tests SEA): assert `Gun.SEA` exists; then send
     (a) a well-formed `AV1.` value under a wrong 64-hex key in
     `avalon/v1/lobby/ZZZZ#`; (b) to a fresh pair's `~<pub>`, key
     `avalon_v1_presence`, a SEA-formatted value with a bad signature;
     (c) a valid `AV1.` value under its correct key in
     `avalon/v1/lobby/ZZZZ#` (MUST be stored, proving the probe path works),
     then a different value under that same key (overwrite). (a), (b) and the
     overwrite in (c) MUST NOT be stored.
  2. **With the filter** installed on the same instance: a correctly hashed
     `AV1.` value under a non-whitelisted soul (e.g. `avalon/v1/selftest#`)
     MUST NOT be stored, a well-shaped lobby value MUST be, and a presence
     value carrying `*` and a correctly hashed value that is no lobby envelope
     MUST NOT be; the mesh must be hardened (no DAM but `?` and `!`).
  Any failure, or a probe timeout, is `process.exit(1)`. The throwaway server
  is closed afterwards. WP-E's acceptance runs exactly these cases against
  both the unbundled (`tsx`) and the esbuild-bundled relay.
* **Input filter** (`installRelayFilter`, `gun.on('in')` middleware) drops a
  put unless every node in it satisfies:
  * soul matches
    `^avalon/v1/(lobby/[A-HJ-NP-TV-Z]{4}|game/[A-Za-z0-9_-]{22}/(setup|play)|logs/\d{4}-\d{2})#$`
    with keys `^[0-9a-f]{64}$` and string values starting with `AV1.` of at most
    64 KiB; or
  * soul matches `^~[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$`, the only key is
    `avalon_v1_presence`, and the value is a SEA-signed string of at most 1 KiB;
  * a public value must also have the shape `AV1.<b64url>.<86-char b64url
    signature>`, decode to a JSON object whose `type` belongs to the soul
    (lobby types in lobby souls, setup / play types in the game's setup / play
    soul with `game` equal to the soul's game id, `log` in log souls) and, for a
    `lobby.create`, whose `body.code` is the soul's code (no signature check:
    clients verify);
  * a presence value must have exactly the keys `:` and `~` (no `*` / `+`,
    §7.6);
  * plus a per-connection limit of 50 puts/s (burst 200) and 256 KiB per
    message, per-soul quotas (lobby 4096 values / 16 MiB, game souls 4096 /
    32 MiB, logs 200,000 / 1 GiB of new values per process lifetime), and per
    client IP 32 connections, 200 puts/s (burst 1000) and 60 gets/s (burst 600);
    loopback and private addresses are exempt unless `TRUST_PROXY=1` names the
    client by its last `X-Forwarded-For` entry.
  Gets are rate limited (20/s, burst 200, per connection; at most 1024 souls
  per connection). Acknowledgements and replies (`@`) sent by clients are
  dropped: any client could forge one for another client's put (a fake SEA
  error) or get. The mesh accepts only the `?` and `!` DAM messages: GUN's
  `mob` would dial any URL a client names (SSRF).
* **Routing.** The relay runs with `axe: false`, which would forward every put
  to every connection. Instead it forwards a put only to the connections that
  asked for its soul (a `get`), and never forwards gets to clients, so a
  passive listener learns no lobby code, game or presence it did not ask for.
* **Static files.** Content-hashed `/assets/*` are served with
  `Cache-Control: public, max-age=31536000, immutable`, everything else
  (`index.html`) with `no-cache`; text assets are brotli- or gzip-compressed
  on the fly (once per file) when the browser accepts it.
* **Storage.** `GUN_DIR` on a persistent writable volume (the container's
  WORKDIR is in the read-only Nix store). The relay is a cache: clients
  republish (§7.4). Retention: an offline job MAY prune `avalon/v1/game/*`
  souls older than 30 days; restart the relay weekly (or enable `lib/evict`)
  to bound memory.
* **Hosting.** WebSockets, persistent disk, exactly one instance (a VM, or
  Cloud Run with min = max = 1 instances, session affinity and a volume). App
  Engine standard does not support WebSockets: `server/app.yaml` is deleted.
  The Dockerfile WORKDIR is fixed to the installed path and `GUN_DIR=/data`
  is a volume. `default.nix` installs the shimmed bundle.
* **Development.** `vite.config.mjs` proxies `/gun` (`ws: true`) and `/api` to
  `http://127.0.0.1:8001`; `yarn start` runs the relay with `tsx`.

---

## 9. Metadata hygiene

Ciphertexts and proofs hide the secrets; these rules keep behaviour from
leaking them.

* **Same subscriptions for every role** (§7.3): fixed souls, subscribed at
  fixed points, in seat order. GUN forwards gets to other peers, so a
  role-dependent read pattern would be visible.
* **Same work for every role:** every client verifies every proof and decodes
  all of its `n − 1` OT entries, including a Loyal Follower who sees nobody.
  CDS proofs do the same group operations for real and simulated branches. A
  ballot proof is computed at click time for every player, good or evil.
* **Deterministic release points:** an automatic message is published as soon
  as its gate opens (§7.7), with no role-dependent delay. GUN's per-field HAM
  state (a public millisecond timestamp) therefore reveals only the gate time,
  which is the same for every role.
* **Nothing role-derived in GUN before the end:** no self-backups, no history,
  no presence fields that depend on role or sees. History and logs are written
  after the end.
* **Accepted, as today:** the timing and order of human actions (who has voted
  so far), who is on which team, IP addresses visible to the relay, and that
  outsiders who know the lobby code can read the public game data (the same
  information any player sees publicly).

---

## 10. Security properties

### 10.1 Prevented (every client checks before using a message)

| Attack | Mechanism |
|---|---|
| Reading another seat's card mid-game | card `i` is ElGamal under `y_i` alone after dealing; the decryption allow-list (§5.11) and the once-only journal (§3.9) mean no honest seat ever publishes `x_j·P` for an adversary-chosen `P` |
| Stacking, duplicating or dropping cards; choosing one's own role | Terelius-Wikström shuffle proof per shuffler, 2^-128 soundness, not grindable; initial deck recomputed from the config; identity `A` rejected |
| Last shuffler rewriting its deck to collect shares for several decks | immutable messages + equivocation is terminal + each honest seat deals for exactly one deck |
| Loyal Follower picking Merlin's OT index | `ot-recv` proof binds the choice to the card actually held |
| Evil hiding from Merlin, Morgana hiding from Percival, per-receiver tagging, selective failure | `ot-profile` + `ot-eq` proofs bind every OT answer to the sender's card; no OT secret is revealed |
| Wrong sight semantics | name-only `seen()`, golden-tested against the old `assignRoles` for every configuration |
| Good player failing a mission | `ballot` proof: `v = 1` only for an evil card; the honest client silently casts 0 |
| Ballot copying, re-randomization, out-of-range votes, ballot as a decryption oracle | `ballot` proof includes PoK of `r` under strong Fiat-Shamir bound to seat and step |
| Learning individual mission votes mid-game | only `Σ` is decrypted, once per mission, over agreed ballots |
| Learning proposal votes early, mirror voting | commit binds step digest and seat; reveal binds the full commit set |
| Fake assassination | opening must prove the assassin card |
| Forging, rewriting or deleting messages; framing by re-encoding | P-256 signatures per message; content-addressed souls; identity by msgId |
| Replay across games, rogue keys | `configId` in every transcript and digest chain; PoK of `x_j` |
| Admin showing different configs to different seats, or substituting keys | game starts only if all seats key on the same `configId`; two configs with one `gameId` are `INVALID(admin)` and keys naming the other config count as absent, never as the honest seat's fault (§3.6, §4.6); no admin-supplied key material exists |
| First-proposer grinding | seeds committed at `key`, revealed at `otS` |
| Cancel-then-exploit (assassin learns Merlin from a cancel's reveal; votes cast after reveals); sore-loser cancel after the assassin's choice, including one aimed at the preceding `mt/m` | §3.7 rules 2a, 5 and 6 |
| Lobby vandalism (null, overwrite, link hijack, backdated name theft) | content-addressed lobby soul; admin roster is the only authority |
| Non-SEA relay injecting forged data | clients verify hash and signature themselves; relay boot self-test |

### 10.2 Detected and attributed (game ends `INVALID`, cheater's team forfeits)

Equivocation (two signed messages for one step), config equivocation by the
admin (two configs with one `gameId`), malformed messages, invalid proofs, a
non-assassin claiming the assassination, a vote reveal not matching its
commit, revealing `x_j` during the game (judged against the reveal's `basis`,
§3.7 rule 3), canceling and then continuing (including a tally followed by a
cancel at the `mt/m` before an assassination). A message with a wrong `prev`
is treated as absent, not as a fault (§3.6). The evidence (the signed envelopes) is in the content-addressed
souls, so every client reaches the same verdict.

### 10.3 Attributed but not preventable

Without an honest majority, fairness against aborts is impossible:

* **Withholding / stalling** any step. The game can be canceled; the outcome
  names the stalled seats, and says so when the canceller was itself
  withholding (e.g. the last tally share, whose holder can compute the result
  first). If the withheld result was terminal (third fail, third success
  without MERLIN, fifth rejection) and the reveals open it, the natural result
  stands (§3.7 rule 5a).
* **Not revealing at the end.** One missing seat is recovered by elimination;
  with two or more, their roles stay `UNKNOWN` unless the unresolved labels
  are all identical, but their team is known whenever the unresolved labels
  are all on one team. An assassination whose target cannot be classified
  as MERLIN or not forfeits that team when the non-revealers are all on one
  team, and is `CANCELED` ("unresolved") only when they are on both teams
  (§5.12-5.13).
* **An assassin who never acts.** Players abandon locally; nothing is revealed.

### 10.4 Out of scope

* Out-of-band communication and collusion; one person playing several seats
  from several devices (Sybil). Such players are a coalition, as they are today
  with several accounts.
* A coalition of all other seats.
* Denial of service by the relay or the network (dropping, delaying,
  partitioning). Liveness only; secrecy and agreement are unaffected.
* Metadata visible to the relay: IP addresses, timing, who is in which lobby.
* **The static host serving malicious client code.** Players trust the
  JavaScript they run; a compromised host could ship code that exfiltrates
  secrets. Mitigations (self-hosting, reproducible builds, pinned releases) are
  outside this protocol.
* Integrity of stats (local only) and of public logs (signed claims, not
  verified history).

---

## 11. Module architecture

### 11.1 Package layout

`common/` becomes a **source-only ESM TypeScript package** consumed directly
by Vite, tsx and the worker bundle. There is no `dist` and no `build:common`
step any more (the Firebase Functions consumer is deleted).

```jsonc
// common/package.json
{
  "name": "@avalon/common", "private": true, "type": "module",
  "exports": {
    ".": "./index.ts", "./avalonlib": "./avalonlib.ts",
    "./crypto": "./crypto/index.ts", "./protocol": "./protocol/index.ts", "./testing": "./testing/index.ts"
  },
  "scripts": { "typecheck": "tsc --noEmit", "test": "node --import tsx --test \"**/*.test.ts\"" },
  "dependencies": { "@noble/curves": "^2.4.0", "@noble/hashes": "^2.4.0" },
  "devDependencies": { "typescript": "^6.0.3", "tsx": "^4.23.15" }
}
// common/tsconfig.json: "module": "ESNext", "moduleResolution": "bundler", "target": "ES2022",
//   "lib": ["ES2022", "DOM"], "strict": true, "noEmit": true, "allowImportingTsExtensions": true,
//   "include": ["**/*.ts"]
```

`common/index.ts` re-exports only `./avalonlib.ts` and `./crypto/index.ts`;
the `./protocol` and `./testing` subpaths are consumed only through their own
export entries (so WP-A's root entry never depends on WP-B/WP-C files).
Relative imports inside `common/` use explicit `.ts` extensions. `Math.random`,
`Date`, `Intl`/locale APIs and floating point are banned in `common/crypto`
and `common/protocol` (ESLint `no-restricted-globals`/`no-restricted-syntax`
in `eslint.config.mjs`, a WP-E deliverable), except `driver.ts`, which
receives `now()` by injection. Because the client typechecks `common` sources
and the worker, `client/tsconfig.json` (WP-F) adds
`"allowImportingTsExtensions": true` and `"lib": ["ES2022", "DOM", "WebWorker"]`,
and `client/src/vite-env.d.ts` (WP-F) carries the worker typing.

### 11.2 Files and exported interfaces

**`common/crypto/`** (pure, synchronous, no protocol knowledge)

```ts
// bytes.ts
export class CodecError extends Error {}
export function utf8(s: string): Uint8Array;
export function concat(...parts: Uint8Array[]): Uint8Array;
export function u8(n: number): Uint8Array;
export function u32(n: number): Uint8Array;                         // big-endian
export function lp(b: Uint8Array): Uint8Array;                      // u32(len) ‖ b
export function b64uEncode(b: Uint8Array): string;
export function b64uDecode(s: string, expectedLen?: number): Uint8Array;   // strict, throws CodecError
export function hexEncode(b: Uint8Array): string;
export function hexDecode(s: string, expectedLen?: number): Uint8Array;    // strict lowercase
export function sha256(...parts: Uint8Array[]): Uint8Array;
export function sha512(...parts: Uint8Array[]): Uint8Array;
export function canon(v: unknown): string;                          // §2.2, throws CodecError
export function parseCanon(s: string): unknown;                     // rejects non-canonical input
export function randomBytes(n: number): Uint8Array;                 // crypto.getRandomValues

// group.ts
export type Point = InstanceType<typeof ristretto255.Point>;
export type Scalar = bigint;
export class CryptoError extends Error {}
export const G: Point, O: Point, L: bigint;
export function encPoint(P: Point): Pt;
export function decPoint(s: Pt, opts?: { allowIdentity?: boolean }): Point;   // rejects O by default
export function ptBytes(P: Point): Uint8Array;
export function encScalar(x: Scalar): Sc;
export function decScalar(s: Sc): Scalar;                                     // rejects >= L
export function mod(x: bigint): Scalar;
export function mul(P: Point, k: Scalar): Point;        // secret scalar: constant-time multiply, k ≠ 0
export function mulPub(P: Point, k: Scalar): Point;     // public data: multiplyUnsafe, allows 0
export function msm(points: Point[], scalars: Scalar[]): Point;               // pippenger
export function H2C(tag: string, msg: Uint8Array): Point;
export function H2S(tag: string, msg: Uint8Array): Scalar;
export const GEN: { S: Point; J: Point; H0: Point; H: readonly Point[] };    // H.length === 10
export function smallLog(P: Point, max: number): number | null;              // P = k·G, 0 ≤ k ≤ max
export function randomWeight128(): Scalar;

// derive.ts
export type CtxItem = string | number | Uint8Array | Point;
export interface Stream { scalar(): Scalar; bytes(k: number): Uint8Array; index(m: number): number; perm(n: number): number[] }
export interface SeedRef { gameSeed: Uint8Array; gameId: string }
export function deriveStream(seed: SeedRef, purpose: string, ...ctx: CtxItem[]): Stream;   // §2.5

// sigma.ts
export type ProofType = 'pok' | 'shuffle' | 'deal' | 'ot-recv' | 'ot-profile' | 'ot-eq' | 'ballot' | 'tally' | 'open';
export interface Term { w: number; base: Point }
export interface Equation { target: Point; terms: Term[] }
export interface Branch { nWitness: number; eqs: Equation[] }
export interface ProofContext { configId: Hex32; stepId: string; prover: Pub }
export interface Statement { proofType: ProofType; ctx: ProofContext; aux: Uint8Array; branches: Branch[] }   // aux: §2.6.2
export function transcriptBase(st: Statement): Uint8Array;
export function proveSigma(st: Statement, real: number, witness: Scalar[], seed: SeedRef): SigmaProofE;
export function verifySigma(st: Statement, proof: SigmaProofE): boolean;
export class BatchVerifier {
  add(st: Statement, proof: SigmaProofE): boolean;   // shape + Fiat-Shamir check; false = invalid now
  verify(): boolean;                                  // one MSM over all added equations
}

// elgamal.ts
export interface Ct { a: Point; b: Point }
export function reenc(Y: Point, c: Ct, rho: Scalar): Ct;
export function encCt(c: Ct): CtE;
export function decCt(e: CtE, opts?: { allowIdentityA?: boolean }): Ct;

// cards.ts
export function cardPoint(l: CardLabel): Point;                  // cached
export function labelEq(a: CardLabel, b: CardLabel): boolean;
export function findLabel(P: Point, labels: readonly CardLabel[]): CardLabel | null;
export function assertCardPointsDistinct(): void;

// shuffle.ts
export interface ShuffleOutput { deck: Ct[]; c: Point[]; chat: Point[]; proof: SigmaProofE }
export function initialDeck(labels: readonly CardLabel[]): Ct[];                 // (O, M(λ_i))
export function proveShuffle(ctx: ProofContext, Y: Point, input: Ct[], seed: SeedRef): ShuffleOutput;
export function shuffleStatement(ctx: ProofContext, Y: Point, input: Ct[], out: Ct[], c: Point[], chat: Point[]): Statement;

// statements.ts (one builder per proof type of §2.6.5; prover and verifier share them)
export function pokStatement(ctx: ProofContext, y: Point): Statement;
export function dealStatement(ctx: ProofContext, y: Point, A: Point[], d: (Point | null)[]): Statement;
export function otRecvStatement(ctx: ProofContext, y: Point, A: Point, C: Point, U: Point,
                                labelPts: Point[], labelRoleIdx: number[]): Statement;
export function otProfileStatement(ctx: ProofContext, y: Point, A: Point, C: Point, F: Ct[],
                                   labelPts: Point[], seenRows: (0 | 1)[][]): Statement;   // seenRows[λ][r]
export function otEqStatement(ctx: ProofContext, F: Ct[], E: (Ct[] | null)[], U: (Point | null)[]): Statement;
export function ballotStatement(ctx: ProofContext, Y: Point, ballot: Ct, y: Point, A: Point, C: Point,
                                evilLabelPts: Point[]): Statement;
export function tallyStatement(ctx: ProofContext, y: Point, T: Point, D: Point): Statement;
export function openStatement(ctx: ProofContext, y: Point, A: Point, Oa: Point): Statement;

// ot.ts
export function otChoice(beta: Scalar, c: number): Point;                       // β·G + c·S
export function otPk(U: Point, r: number): Point;                               // U − r·S
export function otSenderMessages(seed: SeedRef, bits: (0 | 1)[], U: (Point | null)[], self: number):
  { F: Ct[]; E: (Ct[] | null)[]; f: Scalar[]; k: (Scalar[] | null)[] };
export function otDecode(beta: Scalar, e: Ct): 0 | 1 | null;

// index.ts re-exports all of the above
```

**`common/protocol/`**

```ts
// types.ts: exactly §3.2, plus the view types:
export interface Verdict { ok: boolean; reason?: string }
export interface SetupProgress { stage: 'keys' | 'shuffle' | 'deal' | 'sight'; done: number; total: number; waitingFor: string[] }
export interface UserStats { games: number; good: number; evil: number; wins: number; good_wins: number; evil_wins: number; playtimeSeconds: number }
export type CancelReason = 'cancel' | 'leave' | 'abort' | 'lost';
export interface StoredMsg { msgId: Hex32; env: Envelope; value: string; key: Hex32 }

// views.ts (WP-B): the view types the Vue components use, in exactly the shapes of
// today's client/src/types.ts, plus the §5.13 additions. common must not import from
// client, so these live here; WP-C and WP-D import them from '@avalon/common/protocol',
// and client/src/types.ts re-exports them (WP-F).
import type { Role } from '../avalonlib.ts';
export interface Proposal { proposer: string; team: string[]; votes: string[]; state: 'PENDING' | 'APPROVED' | 'REJECTED' }
export interface Mission { state: 'PENDING' | 'SUCCESS' | 'FAIL'; team: string[]; teamSize: number; failsRequired: number;
                           numFails: number; proposals: Proposal[]; evilOnTeam?: string[] }
export interface RoleAssignment { name: string; role: string /* may be 'UNKNOWN' */; assassin?: boolean }
export interface GameOutcome { /* exactly §5.13: state, message, assassinated?, roles, votes, final, unrevealed,
                                  cheaters, canceledBy?, stalled? */ }
export interface GameData { state: 'INIT' | 'ACTIVE' | 'ENDED'; phase: string; players: string[]; roles: string[];
                            missions: Mission[]; outcome?: GameOutcome; options?: Record<string, unknown>;
                            setup?: SetupProgress }
export interface LobbyUser { name: string; uid?: string }
export interface LobbyData { name: string; admin: { uid: string; name: string }; users: Record<string, LobbyUser>; game: GameData }
export interface RoleDoc { role: Role; assassin: boolean; sees?: string[] }

// rules.ts (WP-B)
export { ROLES } from '../avalonlib.ts';
export const LOBBY_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ';
export function numEvil(n: number): number;
export function missionSizes(n: number): number[];
export function failsRequired(n: number, mission: number): number;
export function deriveDeck(n: number, selected: readonly string[]): CardLabel[];   // §5.1
export function distinctLabels(deck: readonly CardLabel[]): CardLabel[];          // Λ
export function roleNamesInPlay(deck: readonly CardLabel[]): string[];            // N_roles, ROLES order
export function seen(viewerRole: string, targetRole: string): boolean;            // name-only
export function teamOf(role: string): 'good' | 'evil';
export function validateName(name: string): string | null;                        // error text or null
export function validateSelectedRoles(selected: readonly string[]): boolean;
export function nextSeat(seat: number, n: number): number;
export const RULES: object;              // canonical descriptor of all rule constants, DSTs and generator labels
export const RULES_HASH: Hex32;          // hex(SHA256(utf8(canon(RULES)))), pinned by a test

// envelope.ts (WP-B)
export interface Signer { pub: Pub; sign(msg: Uint8Array): Uint8Array }   // deterministic P-256, low-S
export function signerFromPair(pair: { pub: Pub; priv: string }): Signer;
export function msgIdOf(env: Envelope): Hex32;
export function encodeEnvelope(env: Envelope, signer: Signer): { value: string; key: Hex32; msgId: Hex32 };
export function decodeEnvelope(value: string, key?: string, admit?: (env: Envelope) => boolean): StoredMsg | { error: string };   // §3.3-3.4; admit runs before the signature check
export function soulOf(env: Envelope, lobbyCode: string): string;                             // §3.1

// lobby.ts + lobbyDriver.ts (WP-B)
export interface LobbyCandidate { lobbyId: Hex32; code: string; adminPub: Pub; adminName: string; members: string[]; fingerprint: string; adminFingerprint: string }
export interface LobbyState {
  lobbyId: Hex32; code: string;
  head: { rosterId: Hex32; seq: number; admin: Pub; members: Member[]; closed: boolean };
  joins: Map<Hex32, { pub: Pub; name: string; status: 'pending' | 'admitted' | 'rejected'; reason?: string; ticket: B64 | null }>;
  leaves: Set<Pub>;
  currentConfig: { configId: Hex32; config: GameConfig; author: Pub } | null;
}
export function candidates(code: string, msgs: Iterable<StoredMsg>): LobbyCandidate[];
export function reduceLobby(lobbyId: Hex32, msgs: Iterable<StoredMsg>): LobbyState;
export function checkConfig(state: LobbyState, me: Pub, local: { activeGameIds: string[]; knownGame?: { gameId: B64; configId: Hex32 };
                                                               keyComplete?: (configId: Hex32) => boolean;           // §4.5 open takeovers
                                                               rosterAgeMs?: (rosterId: Hex32) => number | null | undefined }):
  { ok: true; seat: number } | { ok: false; reason: string; retryAfterMs?: number };              // retryAfterMs: temporary (§4.5)
export function inviteKeyOf(signer: Signer, lobbyId: Hex32): Uint8Array;                       // §4.3
export function inviteTicket(inviteKey: Uint8Array, lobbyId: Hex32, pub: Pub): B64;
export function awaitingApproval(state: LobbyState, inviteKey: Uint8Array): { joinId: Hex32; pub: Pub; name: string }[];
export type LobbyAction =
  | { kind: 'roster'; body: Bodies['lobby.roster'] }        // admin decisions: admit, reject, remove leavers
  | { kind: 'none' };
export function adminNextAction(state: LobbyState, me: Pub, gameActive: boolean,
  opts?: { inviteKey?: Uint8Array; approved?: ReadonlySet<Hex32>; declined?: ReadonlySet<Hex32>; keyComplete?: (configId: Hex32) => boolean }): LobbyAction;
export class LobbyDriver {                                 // used by client/src/p2p/lobbyClient.ts and simulations
  constructor(o: { code: string; lobbyId: Hex32 | null; signer: Signer; transport: Transport; journal: Journal;
                   onState(s: LobbyState): void });
  start(): void; stop(): void;
  create(name: string): Promise<Hex32>;
  join(name: string, inviteKey?: Uint8Array): Promise<void>;  // resolves when admitted, rejects with Error(reason)
  inviteKey(): B64 | null; awaitingApproval(): { joinId: Hex32; pub: Pub; name: string }[];
  approve(joinId: Hex32): void; decline(joinId: Hex32): void;   // admin, §4.3
  leave(): Promise<void>; kick(pub: Pub): Promise<void>; takeOver(): Promise<void>;
  startGame(seats: { pub: Pub; name: string }[], selectedRoles: string[], options: { inGameLog: boolean }): Promise<Hex32>;
  setGameActive(active: boolean): void;
}

// stats.ts (WP-B)
export interface HistoryEntry { gameId: B64; outcome: GameOutcome /* views.ts */; myName: string; startedAt: number; endedAt: number }
export function computeUserStats(history: readonly HistoryEntry[]): UserStats;

// steps.ts (WP-C)
export type StepKind = 'setup' | 'human' | 'automatic' | 'assassination';
export interface StepDef { id: string; type: GameMsgType; req: number[] | 'assassin'; kind: StepKind }
export function nextStep(state: PublicState): StepDef | null;

// machine.ts (WP-C)
export interface PublicState { /* deck labels, keys, decks, C_i, U_Q, missions, proposals, phase, ... */ }
export interface Fault { seat: number; stepId: string; reason: string; evidence: Hex32[] }
export interface GameEval {
  chain: { stepId: string; digest: Hex32; msgIds: Hex32[] }[];
  state: PublicState;
  pending: { step: StepDef; missing: number[]; unverified: Hex32[] } | null;
  terminal: null | { kind: 'natural' | 'canceled' | 'invalid'; atStep: string; by?: number; faults: Fault[];
                     basis: Hex32[] /* §3.7 rule 3 */ };
  pendingReveals: Hex32[];                 // reveals waiting for their basis (§3.7 rule 3); non-empty suspends the driver
  jobs: VerifyJob[];                       // verifications needed before the walk can advance
}
export function reduceGame(input: { config: GameConfig; configId: Hex32;
                                    msgs: ReadonlyMap<Hex32, StoredMsg>;
                                    verdicts: ReadonlyMap<Hex32, Verdict>;
                                    conflictingConfigs: readonly StoredMsg[] /* other lobby.config with this gameId, §4.6 */ }): GameEval;   // §3.6-3.7

// jobs.ts (WP-C): self-contained, encoded, worker-safe
export type EncodedStatement = { proofType: ProofType; ctx: ProofContext; aux: B64;
  branches: { nWitness: number; eqs: { target: Pt; terms: { w: number; base: Pt }[] }[] }[] };   // Statement with points encoded (§2.2)
export type VerifyJob = { id: Hex32 /* msgId */; kind: 'sigma'; statement: EncodedStatement; proofs: SigmaProofE[] }
                      | { id: Hex32; kind: 'reveal'; /* x, y, ballots */ };
export type ProveTask = { kind: string; [k: string]: unknown };
export function runJobs(jobs: VerifyJob[]): Verdict[];     // batch-verifies, falls back to per-job attribution
export function runProve(task: ProveTask): unknown;

// private.ts (WP-C)
export interface GameSecrets { gameSeed: Uint8Array }
export interface PrivateView { seat: number; label: CardLabel; seesSeats: number[]; c: number }
export function derivePrivate(config: GameConfig, ev: GameEval, seat: number, secrets: GameSecrets): PrivateView | null;

// build.ts (WP-C): the only module that reads x_j (§5.11). Each returns an unsigned envelope.
export function buildKey(ctx: BuildCtx): Envelope<'key'>;
export function buildShuffle(ctx: BuildCtx): Envelope<'shuffle'>;
export function buildDeal(ctx: BuildCtx): Envelope<'deal'>;
export function buildOtRecv(ctx: BuildCtx): Envelope<'ot.recv'>;
export function buildOtSend(ctx: BuildCtx): Envelope<'ot.send'>;
export function buildPropose(ctx: BuildCtx, team: number[]): Envelope<'propose'>;
export function buildVoteCommit(ctx: BuildCtx, approve: boolean): Envelope<'vote.commit'>;
export function buildVoteReveal(ctx: BuildCtx, commitEnv: Envelope<'vote.commit'>): Envelope<'vote.reveal'>;
export function buildBallot(ctx: BuildCtx, success: boolean): Envelope<'ballot'>;   // applies good-cannot-fail coercion
export function buildTally(ctx: BuildCtx): Envelope<'tally'>;
export function buildAssassinate(ctx: BuildCtx, target: number): Envelope<'assassinate'>;
export function buildCancel(ctx: BuildCtx, reason: CancelReason): Envelope<'cancel'>;
export function buildReveal(ctx: BuildCtx): Envelope<'reveal'>;          // basis = ctx.ev.terminal.basis
export function buildLog(ctx: BuildCtx, outcome: GameOutcome, lobbyCode: string): Envelope<'log'>;   // §6, prev = terminal digest
export interface BuildCtx { config: GameConfig; configId: Hex32; seat: number; me: Pub; ev: GameEval;
                            secrets: GameSecrets; priv: PrivateView | null; now: number }

// outcome.ts (WP-C): §5.12-5.13
export function computeOutcome(config: GameConfig, ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>): GameOutcome | null;

// project.ts (WP-C): to the shapes the Vue components already use
export function projectGame(config: GameConfig, ev: GameEval, outcome: GameOutcome | null): GameData;
export function projectRole(config: GameConfig, priv: PrivateView | null): RoleDoc | null;
export function projectProgress(config: GameConfig, ev: GameEval): SetupProgress | null;

// driver.ts (WP-C): DOM-free, runs in browsers and in node simulations
// Transport and Journal are declared in types.ts (WP-B) so that lobbyDriver.ts can use them; shown here for reference:
//   interface Transport {
//     publish(soul: string, key: Hex32, value: string): Promise<void>;   // resolves on relay echo; retries internally
//     subscribe(soul: string, onValue: (key: string, value: string) => void): () => void;
//   }
//   interface Journal {
//     get(scope: string, slot: string): Promise<string | null>;
//     put(scope: string, slot: string, value: string): Promise<void>;     // durable before it resolves
//     all(scope: string): Promise<string[]>;
//   }
export interface CryptoBackend { verify(jobs: VerifyJob[]): Promise<Verdict[]>; prove(task: ProveTask): Promise<unknown> }
export interface SeatView { game: GameData; role: RoleDoc | null; progress: SetupProgress | null;
                            pending: GameEval['pending']; terminal: boolean; outcome: GameOutcome | null }
export class SeatDriver {
  constructor(o: { config: GameConfig; configId: Hex32; lobbyCode: string; seat: number; signer: Signer;
                   secrets: GameSecrets; transport: Transport; journal: Journal; crypto: CryptoBackend;
                   verdictCache?: Map<Hex32, Verdict>; now: () => number; onView(v: SeatView): void });
  start(): Promise<void>;                  // subscribe, republish journal, evaluate, run automatic steps (§7.7)
  stop(): void;
  ingest(soul: string, key: string, value: string): void;   // §3.4; the soul is checked against the envelope
  propose(teamSeats: number[]): Promise<void>;
  vote(approve: boolean): Promise<void>;
  mission(success: boolean): Promise<void>;
  assassinate(targetSeat: number): Promise<void>;
  cancel(reason: CancelReason): Promise<void>;
}
```

**`common/testing/`** (WP-C, except `legacyAssignRoles.ts` from WP-B)

```ts
export class MemoryTransport implements Transport {   // shared in-memory "relay"
  constructor(o?: { seed?: number; delayMs?: [number, number]; dropRate?: number; duplicateRate?: number; reorder?: boolean });
  peer(): Transport; partition(groups: Transport[][]): void; heal(): void; restartEmpty(): void;
}
export function simulate(o: { n: number; roles: string[]; seed: number; strategy?: 'random' | 'good-wins' | 'evil-wins';
                              adversary?: Adversary; reloadAt?: { seat: number; step: string }[] }): Promise<SimResult>;
export interface Adversary { seat: number; rewrite(env: Envelope, view: GameEval): Envelope[] | null }
export function legacyAssignRoles(playerList: string[], roles: string[], rng: () => number): Record<string, { role: string; assassin: boolean; sees: string[] }>;
```

**`client/src/p2p/`** (WP-D)

| File | Responsibility | Main exports |
|---|---|---|
| `gun.ts` | GUN instance (§7.1), clock drift (§7.2), relay-info polling | `createGun(relayUrl, o?): GunHandle`, `relayInfo(relayUrl?, fetchFn?): Promise<RelayInfo & { rtt: number }>` (`RelayInfo = {bootId; now}`) |
| `subscriptions.ts` | §7.3 manager, re-ask backstop | `class SubscriptionManager { watch(soul, cb): Unsub; reask(souls) }` |
| `gunTransport.ts` | `Transport` over GUN, echo tracking | `class GunTransport implements Transport` |
| `watchdog.ts` | reconnect, republish, bootId handling (§7.4) | `class Watchdog` |
| `store.ts` | IndexedDB (§3.9) behind a `KV` interface (in-memory implementation for node tests) | `openStore(): Promise<Store>`, `Store` with `identity`, `profile`, `games`, `journal: Journal`, `transcript`, `verdicts`, `history` |
| `identity.ts` | SEA pair creation/load, `Signer`, GUN user auth for presence | `loadOrCreateIdentity(store)`, `resetIdentity(store)` |
| `locks.ts` | Web Locks single writer, `useHere()` | `acquireDriverLock(): Promise<LockState>` |
| `presence.ts` | §7.6 heartbeat, online tracking, wake lock | `class Presence` |
| `workerPool.ts`, `crypto.worker.ts` | `CryptoBackend` via `runJobs`/`runProve` | `class WorkerPool implements CryptoBackend` |
| `lobbyClient.ts` | wraps `LobbyDriver`, discovery, chooser data | `class LobbyClient` |
| `session.ts` | composition root used by `avalon.ts` | `class P2PSession` (below) |

```ts
// client/src/p2p/session.ts
export type SessionStatus =
  | { kind: 'CONNECTING' | 'LOBBY' | 'ACTIVE' | 'ENDED' | 'LOST_SECRETS' | 'READ_ONLY_OTHER_TAB' }
  | { kind: 'SYNCING'; percent: number } | { kind: 'STARTING' | 'SETUP'; progress: SetupProgress }
  | { kind: 'STALLED'; seats: string[]; sinceMs: number } | { kind: 'ENDING'; revealed: number; total: number };
export interface LocalProfile { uid: Pub; name: string | null; lobby: string | null }
export class P2PSession {
  static open(o?: { relayUrl?: string }): Promise<P2PSession>;
  readonly profile: LocalProfile | null;              // null until an identity exists
  readonly status: SessionStatus;
  readonly connected: boolean;
  onProfile(cb: (p: LocalProfile | null) => void): () => void;
  onLobby(cb: (l: LobbyData | null) => void): () => void;
  onRole(cb: (r: RoleDoc | null) => void): () => void;
  onStatus(cb: (s: SessionStatus) => void): () => void;
  createIdentity(): Promise<void>;
  resetIdentity(): Promise<void>;                     // refuses while a game is non-terminal
  createLobby(name: string): Promise<{ lobby: string }>;
  findLobbies(code: string): Promise<LobbyCandidate[]>;
  joinLobby(name: string, code: string, lobbyId?: Hex32): Promise<{ lobby: string }>;
  leaveLobby(): Promise<void>;
  kickPlayer(name: string): Promise<void>;
  takeOverAdmin(): Promise<void>;
  startGame(playerList: string[], roles: string[], options: { inGameLog: boolean }): Promise<void>;
  cancelGame(): Promise<void>;
  abandonGame(): Promise<void>;
  proposeTeam(names: string[]): Promise<void>;
  voteTeam(approve: boolean): Promise<void>;
  doMission(success: boolean): Promise<void>;
  assassinate(name: string): Promise<void>;
  useHere(): Promise<void>;
  userStats(): Promise<UserStats>;
}
```

All `P2PSession` action methods validate locally against the rules (phase,
proposer, team size, membership) and reject with `Error(message)` using
today's server messages (e.g. `'Bad team size. Need 3'`, `'You are not the
proposer'`, `'Name taken'`, `'Cancel game first'`), so the existing `.catch`
handlers keep working.

**`server/`** (WP-E): `server.ts` (Express static + `/api/relay-info` +
`/healthz` + relay), `relay.ts` (`installRelayFilter(gun)`,
`relaySelfTest(o?: SelfTestOptions): Promise<void>`, §8; options for tests: `Gun`, `installFilter`, `tmpRoot`, timeouts), `static.ts` (§8 static files), `bundle.ts`, `smoke.ts`, `fixtures/`, `gun-shim.ts`, `relay.test.ts`. Deleted:
`avalon-server.ts`, `admin.ts`, `firebaseKey.ts`, `test.ts`, `types.ts`,
`app.yaml`.

### 11.3 How the `AvalonGame` API is provided

`client/src/avalon.ts` keeps its `Game`, `GameConfig` and `LobbySubscription`
classes and the snapshot-diff event logic unchanged; only the data sources
change. `LobbySubscription.start()` subscribes to `session.onLobby` and
`session.onRole` instead of Firestore `onSnapshot`; each lobby snapshot runs
the existing `_lobbyDocUpdated` diff, so `LOBBY_CONNECTED`, `LOBBY_NEW_ADMIN`,
`PLAYER_LIST_CHANGED`, `GAME_STARTED`, `GAME_ENDED`, `MISSION_RESULT`,
`PROPOSAL_REJECTED`, `PROPOSAL_APPROVED`, `TEAM_PROPOSED` fire as before.
`PLAYER_JOINED`/`PLAYER_LEFT` come from `GameConfig.updatePlayerList` as before.
`DISCONNECTED_FROM_LOBBY` fires when the profile's lobby becomes null
(kicked, or the lobby closed).

| Used by components | Provided by |
|---|---|
| `initialized` | `P2PSession.open()` resolved and (no lobby in profile, or lobby connected) |
| `isLoggedIn` | `initialized && profile != null` |
| `isInLobby`, `isAdmin` | unchanged formulas over `user`, `lobby` (`admin.uid` = admin pub) |
| `isGameInProgress` | unchanged: `game.state == 'ACTIVE' && lobby.role != null` (`ACTIVE` is projected only after this seat's role and sees are derived, so `GAME_STARTED` opens the role sheet with data present) |
| `isGameRunning` (new) | setup in progress or `ACTIVE`; ToolbarQuitButton uses it so a game can be canceled during the dealing phase |
| `game` | `lobby.game` = `Game` built from `projectGame` (§11.2) |
| `user.{uid,name,lobby,stats}` | `{uid: pub, name, lobby: code, stats: await userStats()}`; `user.email = null` |
| `globalStats` | `null` |
| `confirmingEmailError` | always `null` |
| `lobby.{name, admin.name, users}` | `LobbyData` (§4.7) |
| `lobby.role.{role.{name,team,description}, assassin, sees}` | `projectRole`: `{role: Role, assassin, sees: names}`; `RoleDoc` (now in `common/protocol/views.ts`) gains `assassin: boolean` |
| `game.{phase,state,players,roles,missions,options.inGameLog,outcome}` | `projectGame`. During setup `state = 'INIT'` plus `setup: SetupProgress`; `ACTIVE` with phases `TEAM_PROPOSAL`/`PROPOSAL_VOTE`/`MISSION_VOTE`/`ASSASSINATION`; `ENDED` with `outcome` |
| `currentProposal.votes` | during `PROPOSAL_VOTE`: names (seat order) whose `vote.commit` exists; afterwards: approvers. Matches `TeamVoteAction`/`GamePlayerList` |
| `currentMission.team` | during `MISSION_VOTE`: names (seat order) whose valid ballot exists; afterwards `proposal.team`. `numFails = k`. Matches `MissionAction` |
| `currentMission.teamSize`, `currentProposer`, `hammer`, `lastProposal`, `currentMissionIdx`, `currentProposalIdx` | computed by the existing `Game` class from `missions` |
| `outcome.{state,message,assassinated,roles,votes}` | §5.12-5.13; `votes[m][name]` is `true` for success (protocol `v = 1` means fail, so it is inverted) |
| `config.{playerList, sortList, selectableRoles, roles, roleMap}` | unchanged (`GameConfig` class) |
| `init()` | `P2PSession.open()`, then subscribe to profile/lobby/role/status |
| `signInAnonymously()` | `session.createIdentity()` |
| `logout()` | leave lobby if any, then `session.resetIdentity()` (disabled while a game is non-terminal) |
| `createLobby`, `joinLobby`, `leaveLobby`, `kickPlayer`, `startGame`, `cancelGame` | session methods of the same name; `startGame(options)` passes `config.playerList` and `config.selectedRoleList` |
| `proposeTeam`, `voteTeam`, `doMission`, `assassinate` | session methods of the same name |
| `submitEmailAddr`, `validateEmailAddr`, `api` | removed (Email tab removed from `UserLogin.vue`; `data-testid="anonymous-tab"` kept) |

UI changes (WP-F): `LobbySelect.vue` (4-letter code, candidate chooser,
fingerprint, invite link), `UserLogin.vue` (anonymous only), `GameToolbar.vue`
(no email), `GameLobby.vue`/`StartGameEventHandler.vue` (setup progress
"Shuffling 3/7 - waiting for BOB's device"), a new `ConnectionBanner.vue`
(§7.8 states), `ActionPane.vue` (stalled seats, Cancel emphasis, Abandon,
Take over), `EndGameEventHandler.vue` (cheaters, unrevealed, partial results,
guard `roles.find(r => r.assassin)` and `'UNKNOWN'`), `MissionSummaryTable.vue`
and `avalon-analysis.ts` (guard unknown roles/votes), `ToolbarQuitButton.vue`
(`isGameRunning`; during ASSASSINATION, and at a rule-2a `mt/m` after the own
tally, quit only leaves, §4.5).

---

## 12. Test plan

**Unit tests** (`node --import tsx --test`, root script `yarn test:unit`, also
run by `nix flake check` as `checks.unit`):

* *Crypto (WP-A):* RFC 9496 ristretto255 vectors; strict codec round-trips and
  rejections (padding, non-canonical base64, scalars `≥ L`, identity points);
  `canon` vectors; derivation determinism; sigma engine completeness for 1- and
  multi-branch statements and soundness by mutating every field (`K`, each
  `e_k`, each `s`, statement points, context fields); batch verifier detects a
  single bad equation among 1000; shuffle completeness for N = 5..10, rejection
  of duplicated, replaced and dropped cards and of a wrong permutation
  commitment; OT decode for every `(label, receiver index)`; ballot branches;
  tally `smallLog`; card points distinct (all 13 labels, generated from
  `ROLES`); a pinned test vector for the shuffle statement's `aux` and `tb`.
* *Rules (WP-B):* `deriveDeck` and `seen` **golden equivalence** with
  `legacyAssignRoles` for every `n = 5..10` and every subset of selectable roles
  (compare per-seat role, assassin flag and sees set by role, under a seeded
  shuffle); `RULES_HASH` pinned; `computeUserStats` equals the old
  `computeStats`; envelope encode/decode vectors, signature low-S, rejection of
  tampered values and wrong keys; lobby reducer: fork choice, takeover vs
  incumbent, rejections, kick, leave, handoff, config acceptance rules.
* *Machine (WP-C):* `reduceGame` property tests: every permutation, duplicate
  and prefix of a message set yields the same state (order independence,
  idempotence, monotonicity of terminality); every §3.7 rule with a
  constructed transcript (cancel at each step kind, canceled-and-continued,
  rule 2a, premature reveal, pending reveal with a missing basis, cancel
  during ASSASSINATION ignored, automatic-step completion beats cancel,
  rule 5a restoring a withheld third fail / third success without MERLIN /
  fifth rejection); a key whose `prev` names another config is absent, not
  `INVALID`; config equivocation gives `INVALID(admin)` at `key`;
  elimination by one-team unresolved labels (§5.12) and the resulting
  forfeit rows of §5.13.

**In-process simulations** (`common/testing`, MemoryTransport, seeded):

* full honest games for `n = 5..10` with random strategies and each role
  configuration class, ending in every outcome type;
* reload: replace a seat's driver mid-game at every step with a fresh driver
  built from the same `gs_j` and journal; the transcript must be byte-identical
  to an uninterrupted run;
* network: random delay, reordering, duplication, 10 % drop, partitions,
  `restartEmpty()` of the relay with republish;
* **selective withholding:** the transport drops a deciding `cancel` for one
  peer only; that peer must see the honest reveals as pending (driver
  suspended), never as premature, and must reach the same outcome and blame
  once the basis re-put arrives;
* **two withholders after an assassination:** Merlin is assassinated and two
  good seats (Merlin and a Loyal Follower) never reveal; the outcome must be
  `EVIL_WIN` ("good forfeits"), not `CANCELED`;
* **non-interference:** run two games whose deals are indistinguishable to
  seat `s` (same label for `s`, same sees bits for `s`) with the same public
  choices. Until the outcome is terminal, `projectGame` and `projectRole` for
  `s` MUST be identical at every evaluation in both runs. Independently, for
  every seat, the sequence of souls it subscribes to and the sequence of job
  kinds and sizes its driver runs MUST be identical in two runs where only its
  role differs.

**Cheating scenarios** (each must end with the exact `Fault` and attribution,
and no honest seat may have published a secret-dependent message on the
cheater's alternative branch): duplicated / replaced / dropped card in a
shuffle; invalid shuffle proof; last shuffler equivocating its deck (and
collecting shares); identity `A` in a deck; wrong dealing share; Loyal Follower
choosing Merlin's OT index; OT sender lying, tagging one receiver, corrupting
one index; good player failing (proof must not exist; a forged one rejected);
ballot = another seat's card ciphertext; copied and re-randomized ballots;
vote value 2; equivocating proposal, commit, ballot, tally share,
assassination; vote reveal not matching commit; wrong proposer, wrong team
size, duplicate team members; non-assassin assassinating; replay of a key from
another game; forged config / admin equivocation; premature `x_j` reveal;
sore-loser cancel referencing an old digest; cancel during assassination
followed by an assassination; cancel at the final `mt/m` after an
assassination by a seat that published its tally (MUST give
`INVALID(X, "canceled and continued")` and the other team wins, for a good
`X` after "Merlin assassinated" and for an evil non-assassin `X` after a
missed assassination); withholding the last tally share then canceling
(attribution text, and rule 5a restoring a terminal result); admin
publishing two configs with one `gameId` (no honest seat blamed; stale seats
mark the game `superseded`); a join request between config and keys (start
not stalled); a takeover roster during a running game (game stays current);
premature reveal with a bogus `basis` (game suspended, not continued).

**GUN integration (WP-D, node):** an in-process relay
(`Gun({web, file: tmpdir, multicast: false, axe: false})` + `gun/sea` + the
relay filter) and 5 clients (`localStorage: false, radisk: false`) running
`SeatDriver`s over `GunTransport`; forged and overwrite writes rejected; relay
restart with an empty disk followed by republish; client reconnect after a 40 s
outage; subscribe-before-exists delivery.

**Relay (WP-E):** self-test passes on the unbundled and on the esbuild-bundled
relay, and fails (exit 1) when SEA is not loaded or the filter is not
installed (the exact §8 cases: wrong key under `avalon/v1/lobby/ZZZZ#`, bad
presence signature, overwrite, non-whitelisted soul over loopback); the filter drops every non-whitelisted soul, oversize value and rate
excess; `/api/relay-info` works; no stats file is written.

**Playwright e2e (WP-F, run by `tests/e2e-stack.mjs`, which starts only the
relay with a temp `GUN_DIR` and vite with the `/gun` proxy; no emulators, no
JDK):** existing `e2e-flow`, `e2e-browser`, `e2e-full-game` adapted
(anonymous login only), `e2e-full-game` parametrized `PLAYERS=5..10`
(10-player runs on Chromium, 5-player on Firefox); new `e2e-reload` (reload a
page at setup and mid-mission), `e2e-cancel` (close a context, cancel, reveal
shown), `e2e-offline` (`context.setOffline(true)` for 20 s, game continues),
`e2e-two-tabs` (second tab read-only, Use here).

Performance acceptance (desktop CI, Chromium): 10-player setup completes in
< 15 s wall clock; each automatic in-game step < 2 s after its gate opens.

---

## 13. Work plan

Six work packages with **disjoint file ownership**, then one integration
step. Every package codes against the interfaces in §11 (this document is the
contract). Where a package needs a dependency that is not merged yet, it uses a
local fake **inside its own files** (tests), never edits another package's
files. Package manifests are edited only by their owner; `yarn.lock`,
`missing-hashes.json` and the Nix offline-cache hash are regenerated only in
the integration step. Everything a package needs to run its tests (`tsx`,
`gun`, `@noble/*`, `playwright`) is already installed in the workspace.

The encoded primitive types (`Pt`, `Sc`, `Hex32`, `B64`, `Pub`, `CtE`,
`SigmaProofE`, `CardLabel`) live in `common/crypto/types.ts` (WP-A) and are
re-exported by `common/protocol/types.ts` (WP-B), so WP-A does not depend on
WP-B. The view types (`GameOutcome`, `GameData`, `Mission`, `RoleDoc`,
`LobbyData`, ...) live in `common/protocol/views.ts` (WP-B), so WP-B, WP-C
and WP-D never import from `client/`, and they exist with the §5.13 fields
before WP-F is merged. The `Transport` and `Journal` interfaces of §11.2 are declared in
`common/protocol/types.ts` (WP-B); `CryptoBackend` stays in `driver.ts`
(WP-C).

### WP-A: Crypto primitives

* **Owns:** `common/crypto/**` (`types.ts`, `bytes.ts`, `group.ts`,
  `derive.ts`, `sigma.ts`, `elgamal.ts`, `cards.ts`, `shuffle.ts`,
  `statements.ts`, `ot.ts`, `index.ts`, `bench.ts`, `*.test.ts`),
  `common/package.json` (including the `./protocol` and `./testing` export
  entries, whose targets WP-B and WP-C create), `common/tsconfig.json`,
  `common/index.ts` (re-exports only `./avalonlib.ts` and
  `./crypto/index.ts`, §11.1).
* **Consumes:** `@noble/curves`, `@noble/hashes`.
* **Provides:** everything under "common/crypto" in §11.2, implementing §2 and
  the cryptographic parts of §5.3-5.5, 5.9-5.10.
* **Acceptance:** the crypto unit tests of §12 pass; `bench.ts` reports, on
  desktop Node 22, shuffle prove < 200 ms and verify < 50 ms, `ot.send` prove
  < 1 s and verify < 250 ms at n = 10, R = 7; `common` typechecks with
  `tsc --noEmit`.

### WP-B: Protocol foundations

* **Owns:** `common/protocol/types.ts`, `views.ts`, `rules.ts`,
  `envelope.ts`, `lobby.ts`, `lobbyDriver.ts`, `stats.ts` and their tests;
  `common/testing/legacyAssignRoles.ts`; `common/avalonlib.ts`.
* **Consumes:** WP-A `bytes`/`group` (sha256, canon, codecs), `p256` from noble.
* **Provides:** §3.2 types, §3.3-3.4 envelope codec and signing, §5.1/§5.6
  rules, `RULES_HASH`, §4 lobby reducer and `LobbyDriver`, §6 stats.
* **Acceptance:** golden `deriveDeck`/`seen` equivalence with the legacy
  `assignRoles` for all `n` and role subsets; envelope vectors (a fixed SEA
  pair, envelope, msgId, signature, GUN key) checked in; lobby reducer tests
  (fork choice, takeover, handoff, kick, leave, rejections, config checks);
  `LobbyDriver` admits/rejects over an in-test fake transport; stats parity
  with `computeStats`.

### WP-C: Game engine

* **Owns:** `common/protocol/steps.ts`, `machine.ts`, `jobs.ts`,
  `private.ts`, `build.ts`, `outcome.ts`, `project.ts`, `driver.ts`,
  `index.ts` and their tests; `common/testing/memoryTransport.ts`,
  `simulate.ts`, `adversary.ts`, `index.ts` and simulation tests.
* **Consumes:** WP-A (all), WP-B (types, rules, envelope).
* **Provides:** `reduceGame`, `SeatDriver`, `runJobs`/`runProve`,
  `projectGame`/`projectRole`/`projectProgress`, `computeOutcome`,
  `MemoryTransport`, `simulate`.
* **Acceptance:** the machine, simulation, non-interference and cheating tests
  of §12, including reload at every step and relay `restartEmpty()`.

### WP-D: Client P2P runtime

* **Owns:** `client/src/p2p/**` (files of §11.2 plus `*.test.ts`).
* **Consumes:** WP-B (`LobbyDriver`, envelope, types), WP-C (`SeatDriver`,
  jobs, projections), `gun`.
* **Provides:** `P2PSession` (§11.2), the worker bundle entry
  `crypto.worker.ts`.
* **Acceptance:** node tests with an in-memory `KV` store; the GUN integration
  tests of §12 (in-process relay with `gun/sea`, 5 sessions' drivers over
  `GunTransport`, forged/overwrite rejection, empty-relay restart + republish,
  40 s outage reconnect); a test that two `P2PSession`s on one store contend
  correctly for the Web Lock (lock API faked in node).

### WP-E: Relay, build, deployment, Firebase removal

* **Owns:** `server/**`; `Dockerfile`; `default.nix`; `flake.nix`;
  `flake.lock`; root `package.json`; `yarn.lock`; `missing-hashes.json`;
  `.github/**`; `eslint.config.mjs` (including the §11.1 bans on
  `Math.random`, `Date`, `Intl` and floating point in `common/crypto` and
  `common/protocol`); `.gitignore`; `.dockerignore`; `.firebaserc`
  (deleted); `firebase/**` (deleted);
  `README.md`, `CLAUDE.md`, `AGENTS.md`, `common/README.md`;
  `tests/e2e-stack.mjs`.
* **Consumes:** `gun`; the built SPA in `server/dist`.
* **Provides:** the relay (§8) with `/gun`, `/api/relay-info`, `/healthz`;
  root scripts `test:unit` (`yarn workspace @avalon/common test && yarn
  workspace @avalon/client test:unit && yarn workspace @avalon/server test`)
  and `test:e2e`; root workspaces without `firebase/functions`; removed `bin`
  `avalon-admin` and `scripts.admin`; `bundle:server` without `build:common`;
  Nix `checks.unit`, `GUN_DIR` volume, fixed WORKDIR; CI without Firebase
  emulator caching or JDK; `e2e-stack.mjs` starting only relay + vite; docs
  describing the new stack.
* **Acceptance:** `server/relay.test.ts` (filter, self-test, relay-info, no
  stats file); the esbuild bundle starts and passes the self-test outside
  `node_modules`; `yarn lint` passes for `server/`; a 1-minute smoke test with
  two node GUN clients through the bundled relay.

### WP-F: UI integration

* **Owns:** `client/src/avalon.ts`, `client/src/types.ts` (becomes
  `export type { Proposal, Mission, RoleAssignment, GameOutcome, GameData,
  LobbyUser, LobbyData, RoleDoc } from '@avalon/common/protocol'` plus the
  purely client-side types `UserData`, `ProposerStats` and `Role`),
  `client/tsconfig.json` (`allowImportingTsExtensions`,
  `lib: [ES2022, DOM, WebWorker]`), `client/src/vite-env.d.ts` (worker
  typing), `client/src/avalon-analysis.ts`, `client/src/main.ts`, `client/src/App.vue`,
  `client/src/components/**` (including the new `ConnectionBanner.vue`),
  `client/src/firebase-config.ts` and `client/src/avalon-api-rest.ts`
  (deleted), `client/package.json` (drop `firebase`, `axios`; add script
  `test:unit` = `node --import tsx --test "src/p2p/**/*.test.ts"` for WP-D),
  `client/vite.config.mjs` (`/gun` ws proxy, `/api` to the local relay, worker
  format `es`, no `@avalon/common` in `optimizeDeps`),
  `tests/e2e-flow.mjs`, `tests/e2e-browser.mjs`, `tests/e2e-full-game.mjs`
  and the new `tests/e2e-reload.mjs`, `e2e-cancel.mjs`, `e2e-offline.mjs`,
  `e2e-two-tabs.mjs`.
* **Consumes:** `P2PSession` (WP-D). Until WP-D lands, a fake session in
  `client/src/p2p-fake.ts` (owned by WP-F, deleted at integration) that
  replays a scripted game lets the UI be developed.
* **Provides:** the `AvalonGame` API of §11.3, unchanged for components; the UI
  changes listed there.
* **Acceptance:** `yarn workspace @avalon/client lint` and `vite build` pass;
  every component listed in §11.3 handles `UNKNOWN` roles, missing votes,
  `setup` progress and `ending`; the e2e suite passes against the integrated
  stack.

### Integration (orchestrator)

1. Merge in the order A, B, C, D, E, F (each package's own tests pass at
   merge).
2. Regenerate `yarn.lock`, `missing-hashes.json` and the `default.nix` offline
   cache hash (`nix run .#update-deps`); check `yarn why` for the root
   `resolutions` that only Firebase needed.
3. Delete `client/src/p2p-fake.ts`; run `yarn test:unit`, `yarn bundle:server`
   + self-test, `yarn test:e2e` (all e2e files, `PLAYERS=5..10`), `nix flake
   check` where available.
4. Check the performance acceptance of §12 and the metadata rules of §9 by
   inspection of the worker job logs (identical job sequences for different
   roles).
5. Update Appendix A if any decision changed during implementation; this
   document stays the normative reference.

---

## Appendix A. Review findings disposition

"Adopted" means the reviewer's fix is in this spec (section given);
"modified" means the problem is solved differently, with the reason.

### Privacy lens

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | Cut-and-choose shuffle 2^-40 is grindable; last shuffler can stack/copy cards (critical) | **Modified:** Terelius-Wikström argument (2^-128, ≈ 10× cheaper than 128-round shadow mixes) instead of λ = 128 cut-and-choose; `Y`, `configId`, prover, input and output decks in the transcript; batched verification; identity `A` rejected; whole chain verified before dealing (§5.3, §3.6) |
| 2 | Assassin card counted as ASSASSIN in sight (high) | **Adopted:** name-only `seen`, OT index over role names, branches over labels, golden test (§5.1, §5.5, §12) |
| 3 | Tally as decryption oracle; ballot copying; split views (high) | **Adopted:** single CDS ballot proof with PoK of `r` and good-cannot-fail, strong FS, once per mission over verified ballots, allow-list (§5.9, §5.11). Ballots stay under the joint key (see consistency 7) |
| 4 | OT sender unconstrained until audit (high) | **Modified:** verifiable ElGamal 1-of-R OT with global `S` as proposed, but the sender proves its seen-vector once (`ot-profile`, ElGamal under `J`) plus one linear `ot-eq` proof for all receivers instead of a per-pair OR (≈ 7× cheaper); no OT secret is ever revealed (§5.5) |
| 5 | End reveal depends on every player; Merlin can block the assassination outcome (high) | **Modified:** no key escrow. Mid-game, any absent seat halts the all-seat proposal vote anyway, so escrow would only matter at the end, where an (n−1)-of-(n−1) escrow recovers exactly what elimination recovers. Instead: per-ballot randomness in the reveal (each vote opens alone), elimination for one missing seat, and a deterministic "assassination unresolved" outcome when the target's role cannot be determined (§5.12-5.13). Not "evil wins on non-reveal", which an evil target plus one accomplice could exploit; instead the deck multiset gives the team of non-revealers whenever the unresolved labels are all on one team, and that team forfeits (second round 6) |
| 6 | Mutable user space: equivocation, premature reveal (medium) | **Adopted:** content-addressed append-only messages, equivocation is terminal and self-evident, any valid reveal ends the game, Web Locks (§3). The per-step echo barrier is replaced by the once-only journal plus all-author completion (§3.9) |
| 7 | Fiat-Shamir and CDS composition underspecified (medium) | **Adopted:** exact transcript, one challenge per branch shared by all conjuncts, canonical scalars (§2.6) |
| 8 | Identity point accepted; key hygiene (medium) | **Adopted:** identity rules, card points, fresh per-game secrets never derived from the SEA pair (§2.2-2.5). Secrets are derived from a fresh random per-game seed (reload safety, consistency 1) rather than drawn independently |
| 9 | Metadata: timestamps, forwarded gets, role-dependent work, backup length (medium) | **Adopted** (§9) |
| 10 | First-proposer grinding (low) | **Adopted:** committed seeds (§5.5) |
| 11 | Dealing shares both SEA-encrypted and public (low) | **Adopted:** clear shares with DLEQ, no `epub`, no SEA encryption (§5.4) |
| 12 | Team-of-2 leakage (low) | **Adopted:** documented as inherent (§1.1) |

### Cheating lens

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | Mutable slots; last-shuffler rewrite collects shares for many decks (critical) | **Adopted** (a) content addressing with app-level signatures, (b) equivocation evidence, (d) once-only ledger, (e) order-independence (§3). (c) echo barrier **not adopted**: the journal guarantees one release per step per seat, and every secret-dependent step needs all authors on the same input, so split views yield only incomplete, useless share sets (§3.9) |
| 2 | No allow-list for `x_j` multiplication (critical) | **Adopted** (§5.11) |
| 3 | Sight semantics (high) | **Adopted** (§5.1) |
| 4 | OT sender honesty only audited (high) | **Adopted** (construction per privacy 4) |
| 5 | Good player can fail (high) | **Adopted** as MUST. The honest client still coerces a good player's FAIL to success instead of hiding the button (hiding would show the role on screen) |
| 6 | Selective abort, n-of-n veto, no timeouts (high) | **Partly adopted:** persistence (§3.9), signature-based attribution, forfeits for provable cheating (§5.13), no clock-based protocol decisions (§3.8). **Not adopted:** VSS (see privacy 5), ElGamal proposal votes (withholding a reveal is attributed instead), deterministic defaults for missing inputs (they require a consistent notion of absence, which only signatures can give, and absent-votes need all other seats online anyway: cancel is equivalent) |
| 7 | Config equivocation, admin `epub`, replay, invalid role multiset (high) | **Adopted:** each seat's `key` message is its signed acceptance of one `configId`; all seats must agree; `epub` removed; multiset recomputed and validated; every transcript binds `configId` (§4.6, §5.2) |
| 8 | Terminal-event races (medium) | **Adopted and extended** (§3.7): cancel rules by step kind, canceled-and-continued, no cancel during assassination, assassin equivocation is terminal |
| 9 | Shuffle soundness and cost (medium) | **Adopted:** Terelius-Wikström (§5.3) |
| 10 | Commit-reveal binding (medium) | **Adopted:** commit binds step digest and seat; reveal binds the commit set; mismatch is `INVALID` (§5.8) |
| 11 | Lobby index griefing, squatting, Sybil (medium) | **Adopted:** content-addressed lobby soul, admin roster, fingerprints, chooser, relay whitelist (§4, §8). Codes stay random 4-letter (chooser + invite links instead of hash-derived codes) |
| 12 | First-proposer grinding (low) | **Adopted** (§5.5) |
| 13 | Forgeable logs and stats (low) | **Adopted:** stats local only, global stats dropped, logs are signed claims (§6) |
| 14 | Audit gaps (low) | **Adopted** (§5.12) |

### Consistency lens

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | Reload, multi-tab, nonce reuse, lost storage (critical) | **Adopted** (§2.5, §3.9, §3.10) |
| 2 | Cancel vs progress race and the assassin exploit (critical) | **Adopted with changes** (§3.7): human-step cancels win; automatic-step terminal completions win; a contributor's cancel at the `mt/m` before an assassination is `INVALID` (rule 2a), so late cancels are self-incriminating; withheld terminal results are restored from the reveals (rule 5a); cancels ignored during assassination |
| 3 | No log or total order (critical) | **Adopted:** steps, digest chain, completion, conflicts, graph layout (§3.1, §3.5, §3.6). No blob soul: the largest message is ≈ 22 KB |
| 4 | Relay bundling drops SEA; App Engine has no WebSockets; read-only disk; multicast (critical) | **Adopted** (§8); the verified shim is used instead of `--external:gun` to keep the single-file deployment |
| 5 | Reconnect never retries; offline puts lost (critical) | **Adopted** (§7.4) |
| 6 | Lobby vandalism, admin split-brain, join/leave during start (high) | **Adopted** (§4) |
| 7 | All-seat steps on phones; selective abort; assassination target refusal (high) | **Partly adopted:** Wake Lock, workers, presence, progress UI, attribution, target via reveal/elimination. **Not adopted:** team-only ballot key, because all seats must be online for the next proposal vote anyway, and an all-seat tally makes every seat a party to `mt/m`, which together with §3.7 rule 2a closes the sore-loser cancel (§3.7, §5.9) |
| 8 | Timeouts must not change state; UI states (high) | **Adopted** (§3.8, §7.8) |
| 9 | Clock skew delays messages (high) | **Adopted** (§7.2) |
| 10 | GUN localStorage adapter fills the quota (high) | **Adopted** (§7.1, §3.9) |
| 11 | SEA.sign re-serializes; arrays; ECDSA malleability; `#` prefix keys; JS determinism (high) | **Adopted** (§2.2, §3.3, §11.1); hex GUN keys instead of base64 |
| 12 | Message sizes, soul granularity, memory (medium) | **Adopted** (setup/play split, worker, verdict cache, relay retention) |
| 13 | Version skew (medium) | **Adopted:** `rulesHash` in the config, refuse before keys. Keeping the previous rule set for mid-game reloads is a SHOULD |
| 14 | Code collisions and squatting (medium) | **Adopted** (§4.2-4.3) |
| 15 | `.once`, `.off()`, duplicate events (medium) | **Adopted** (§7.3) |
| 16 | End, logs, stats (medium) | **Adopted with simplification:** no endack quorum; logs are not a stats source (§6) |
| 17 | Soul naming hazards (low) | **Adopted** (§3.1, §8) |

### Implementation lens

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | Sight rule leaks (critical) | **Adopted** (§5.1) |
| 2 | Consistency model over GUN (high) | **Adopted** in the content-addressed form (§3) rather than per-author seq chains in user space |
| 3 | Secret persistence, reload, tabs (high) | **Adopted** (§2.5, §3.9) |
| 4 | Non-revealer blocks every vote; UI crashes on partial outcomes (high) | **Adopted:** per-ballot `r` reveal, elimination, `UNKNOWN` guards (§5.12, §11.3). Team key not adopted (consistency 7) |
| 5 | Phone liveness; cancel during dealing (high) | **Adopted:** `isGameRunning`, Wake Lock, setup progress. Auto-cancel not adopted (timers cannot be consistent) |
| 6 | Relay SEA, bundle, disk, WebSockets, limits (high) | **Adopted** (§8) |
| 7 | GUN client config, clock, Vue reactivity, auth ordering, console noise (high) | **Adopted** (§7.1-7.2) |
| 8 | Performance, parameters, workers, pipelining (medium) | **Adopted:** TW shuffle (no tunable round count), workers, pipelining, batching, precomputation (§5.3, §5.14, §7.5) |
| 9 | Shares clear vs SEA (medium) | **Adopted** (§5.4) |
| 10 | 90 OT proofs (medium) | **Adopted:** one sender-independent receiver commitment; the "optional upgrade" to proven sender answers is included (§5.5) |
| 11 | Mission proof MUST, semantics of votes (medium) | **Adopted** (§5.9, §11.3) |
| 12 | Lobby authority, accept round, code length (medium) | **Adopted** (§4); `key` doubles as the accept message |
| 13 | Module architecture and build traps (medium) | **Adopted** (§11) |
| 14 | AvalonGame API semantics (medium) | **Adopted** (§11.3) |
| 15 | Test strategy (medium) | **Adopted** (§12) |
| 16 | Firebase removal inventory (low) | **Adopted** (WP-E, WP-F file lists) |
| 17 | Rules port, first proposer, stats, logs (low) | **Adopted** (§5.1, §5.5, §6) |

### Second review round

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | Contributor cancel at the final `mt/m` voids an assassination result (high) | **Adopted:** §3.7 rule 2a, §5.9, §7.7/§7.8 (no cancel after own tally at that step; Abandon), §12 test |
| 2 | View types only in `client/src/types.ts`; common cannot import from client (high) | **Adopted:** `common/protocol/views.ts` (WP-B); `client/src/types.ts` re-exports (§11.2, §13) |
| 3 | Join requests stall config acceptance; takeover drops a running game; no reclaim (medium) | **Adopted with a change:** acceptance allows rejection-only rosters after `prev` (§4.6.2); instead of deferring rejections, the admin keeps publishing rejection-only rosters (so joiners still get "Cannot join while game is in progress" promptly) and defers only membership changes (§4.3); a started game stays current (§4.6.4); incumbent reclaim (§4.5) |
| 4 | Admin config equivocation blames honest seats via "wrong prev"; non-current config deadlocks a seat (medium) | **Adopted:** wrong `prev` is absence (§3.6); `INVALID(admin, "config equivocation")`; `superseded` status (§4.6, §3.9) |
| 5 | Premature-reveal judgment depends on the evaluator's message set; relay can frame (medium) | **Adopted and extended:** `reveal.basis`, re-put of basis, pending reveals (§3.2, §3.7 rule 3, §5.12); a pending reveal also suspends the driver, so a reveal with a bogus basis cannot be used to disclose a card verifiably while play continues |
| 6 | Two non-revealers of one team void any result (medium) | **Adopted:** one-team inference from the deck multiset, forfeit rows (§5.12-5.13, §10.3) |
| 7 | Withholding the decisive tally share voids a loss (medium) | **Adopted and extended:** §3.7 rule 5a (also for a decided fifth rejection at `vr/m/4`), open automatic message published before a cancel (§7.7) |
| 8 | Relay self-test passes even without SEA; filter untested (medium) | **Adopted:** throwaway loopback relay, exact cases, two phases (§8, §12) |
| 9 | Interface and ownership gaps (low) | **Adopted:** `EncodedStatement`, `buildLog` + §7.7 row, `ingest(soul, key, value)`, ownership of `client/tsconfig.json`, `vite-env.d.ts`, `.firebaserc`, `.dockerignore`, ESLint bans, `common/index.ts` scope (§11, §13) |
| 10 | Card-point self-check counted 9 labels instead of 13 (low) | **Adopted** (§2.4) |
| 11 | Shuffle transcript does not hash the full public input (low) | **Adopted:** `aux` in `tb` (§2.6.2, §5.3) |

---

### Implementation notes (integration)

Decisions taken while implementing the work packages; the code follows these
where they differ from the text above.

| Area | Decision |
|---|---|
| §2.5 derivation | `.scalar()`/`.index()` consume whole 64-byte blocks (the rest of a partly read block is discarded); `.bytes(k)` reads the joined blocks byte-wise. Ballot randomness is `ballotRandomness(seed, stepId, prev, v)` = stream("ballot", stepId, prev, u8(v)). |
| §2.3 identity rules | Statement builders throw on every identity the rules forbid, including computed values (`Y`, `T_m`) and any `PK_{Q,r} = O` (so also `U_Q = r·S`); a builder that throws makes the message invalid. `dealStatement`/`otEqStatement` take the author's index `self`. `proveSigma` refuses a witness that does not satisfy the real branch. |
| §5.5 ot-eq | `ot-eq` does not bind `F` itself: an `ot.send` is accepted only when `ot-profile` and `ot-eq` both verify on the identical decoded `F` (a sigma `VerifyJob` may carry `more` statements, one proof each). Recommended for v2: `aux = SHA256(enc(F) ‖ enc(E rows))`. |
| §5.9-5.11 degenerate values | Ballots whose `a` sum to `O` (`T_m = O`): INVALID("ballots cancel out") for the smallest zero-sum subset; joint key `Y = O`: INVALID for all; duplicate `y_j` or ballot `a`: INVALID for the later seat. |
| §3.2 `lobby.leave` | `prev` is the joinId (the lobbyId for the creator) of the membership being ended, so a leave never applies to a later re-join. Journal slots are `roster/<seq>/<prev>`, `join/<msgId>`, `leave/<joinId>`. |
| §3.9 journal | `Journal.putIfAbsent` (one IndexedDB readwrite transaction) replaces get-then-put; the driver serializes every publish behind one mutex and re-checks the journaled cancel right before each put. |
| §4.6 configs | Only configs authored by the roster admin (`configAuthor`) in the same lobby count, for equivocation and for `checkConfig`; `BuildCtx`/`SeatDriver` carry `lobbyId` and `configAuthor`. "A started game stays current" is applied by `selectCurrentGame`, not by the lobby reducer. |
| §11.2 `P2PSession` | No presence API and no `lobbyId` in `LobbyData`: the UI approximates "online" by STALLED seats and gets the lobbyId (fingerprint, invite link with `k`) from `invite()`. `LobbyData.requests` lists, for the admin only, joins waiting for approval; `approveJoin` / `declineJoin`. The profile name is the roster's (or the current seat's) name for this pub. A read-only tab (§3.9) does not load the lobby; it shows a notice with "Use here". No lobby snapshot is emitted while the current game of a config this device is seated in has no view yet (after a reload, the first snapshot already shows the ended game). |
| §7.5 workers | The pool starts all workers when the session opens and each worker builds the fixed-base tables of `G` and every generator at load (`warmUpTables`); without it the first shuffle a worker proves costs ~0.4 s more. |
| §8 relay | `gun-shim.ts` imports `gun/gun.js` (importing `gun` evaluates SEA before `self` exists); the filter is inserted at the head of the `in` chain (a plain `gun.on('in')` listener runs after puts are applied); every relay instance sets `stats: false`; the self-test client needs `super: false, rfs: false`; ws `maxPayload` 1 MiB; the 256 KiB limit applies to each message's put payload. Docker/Nix use `GUN_DIR=/data/radata` and `TMPDIR=/data/tmp`. |
| §12 performance | Measured with all players' browsers on one 4-core machine (each device gets a fraction of the CPU): 5-player setup about 5-7 s, 10-player 17-21 s (shuffle chain ~8 s, sight exchange CPU-bound); every automatic in-game step completes within 2 s of the human action that opens it. |

### Third review round (security and robustness)

| Finding | Disposition |
|---|---|
| Roster names not bound to the joiner's request (an admin swaps two devices' names; the UI identifies "me" by name) | **Fixed:** every roster member must be the creator or name its own `lobby.join` with the same name (§4.4); the client takes its display name from the roster/seat of its pub. |
| A member takes over a live admin and keys its own config at once; no reclaim once any config exists or while a game runs | **Fixed:** reclaim is blocked only by a *started* game on the takeover branch; the ousted admin never keys a config based on its own open takeover; other seats wait 60 s (local receipt) before keying one (§4.5, §4.6.2). Takeover rosters must keep the members. |
| A roster dropping a seated player disconnects it from the running game | **Fixed:** the device stays attached until the game is terminal (§4.5). |
| Mass equivocation overflows the reveal basis (256), so nobody reveals and the forfeit becomes a void | **Fixed:** equivocation evidence is the two lowest msgIds (§3.7 rule 3). |
| A reveal citing a made-up msgId vetoes the assassination (cancels are ignored there) | **Fixed:** the `as` is not suspended by pending reveals (§3.7 rule 3). |
| One burst of 300 joins stops the admin's join processing (roster over the 256 limit) | **Fixed:** at most 32 rejections per roster, oldest first (§4.3). |
| Sybil joins fill the lobby; codes are enumerable | **Fixed:** automatic admission only with the invite link's ticket; joins by code wait for the admin's approval (§4.3); relay get rate limits (§8). |
| Presence forgeable through SEA's `*` path | **Fixed** at the relay (exact keys `:`, `~`) and in the client (§7.6). |
| `mob` DAM makes the relay dial any URL (SSRF) | **Fixed:** only `?` and `!` DAMs are heard (§8). |
| `axe: false` broadcasts every put to every connection | **Fixed:** puts go only to connections that asked for the soul; gets are not forwarded (§8). |
| Unauthenticated junk costs every player an ECDSA check | **Fixed:** author/game pre-filter before the signature check (§3.4); relay shape checks, per-soul quotas, per-IP limits (§8). |
| 16-bit fingerprint can be ground offline | **Fixed:** 32-bit lobby fingerprint plus the admin key's fingerprint in the chooser (§4.1). |
| Forged error acks make a client give up a put | **Fixed:** client acks/replies are dropped by the relay; error acks are retried by the client (never final). |
| A second game on an unchanged roster loses the config tie-break to the old game about half the time | **Fixed:** the admin bases a config on a fresh no-op roster when a config already used the head roster (§4.6 item 1). |
| Reload after the end re-announces the end; end dialog blocks the next setup; partial mission votes lost on a cancel; offline device blames others | **Fixed** (§11.2 note above, §5.12, §7.8). |

## Appendix B. Constants

**Domain-separation tags**

| Tag | Use |
|---|---|
| `avalon-p2p/v1/gen` | generators `S`, `J`, `H₀`, `H_i` (messages `ot-S`, `ot-J`, `shuffle-H`, `shuffle-H/<i>`) |
| `avalon-p2p/v1/card` | card points |
| `avalon-p2p/v1/fs/<proofType>` | Fiat-Shamir challenges |
| `avalon-p2p/v1/shuffle-u` | shuffle challenge vector |
| `avalon-p2p/v1/derive` | HKDF salt for per-game secrets |
| `avalon-p2p/v1/msg\0` | msgId |
| `avalon-p2p/v1/sig\0` | signature input |
| `avalon-p2p/v1/step\0` | digest chain |
| `avalon-p2p/v1/seed\0` | beacon seed commitment |
| `avalon-p2p/v1/beacon\0` | first-proposer beacon |
| `avalon-p2p/v1/pvote\0` | proposal-vote commitment |

**Timing (UI only)**

| Constant | Value |
|---|---|
| Reconnect backoff | 1, 2, 4, 8, then 15 s |
| Presence interval / online window | 10 s / 30 s |
| Re-ask while pending | after 10 s pending, every 15 s |
| Own pending message re-put | every 30 s until echoed |
| Clock resync | every 10 min |
| Step warning / cancel emphasis / shuffle soft limit | 10 s / 60 s / 45 s |
| Abort start (admin) | 30 s |
| Human step actor offline hint | 3 min |
| `GAME_ENDED` without all reveals | 20 s |
| Log write without all reveals | 120 s |
| Admin takeover offer | 60 s |
| Lobby code probe / join discovery | 1.5 s / 3 s |

**Limits:** 5 ≤ n ≤ 10; names `/^[A-Z]{1,20}$/`, not a role name; value
≤ 64 KiB; relay message ≤ 256 KiB, 50 puts/s (burst 200) per connection.
