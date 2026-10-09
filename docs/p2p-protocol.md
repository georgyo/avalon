# Avalon over GUN: peer-to-peer protocol (DRAFT)

Status: draft for adversarial review. This replaces Firebase (Auth, Firestore,
Cloud Functions) and the authoritative Express game server with a fully
peer-to-peer design: **no party, including the relay server, ever holds secret
game state**. Every client runs the same deterministic game state machine over
a shared, signed action log stored in GUN.

## 1. Goals and threat model

Players in a lobby must know everything they are entitled to know, and nothing
else, until the game is over:

| Information | Who may know it during the game |
|---|---|
| Lobby membership, seat order, roles in play, options | everyone in the lobby |
| Own role (and the assassin flag) | the player only |
| "Sees" list (e.g. Merlin sees evil except Mordred; Percival sees Merlin+Morgana; evil see evil except Oberon) | the player only, computed from `common/avalonlib.ts` `ROLES[].sees` |
| Team proposals | everyone |
| Proposal approve/reject votes | nobody until every player has voted; then everyone (simultaneous reveal) |
| Mission success/fail votes | only the number of fails, once all team members voted; individual votes at game end |
| All roles, all individual votes | everyone, after the game ends |

Adversaries:

* **Curious player** (devtools, reads all GUN data, runs modified code passively):
  must learn nothing beyond the table above. This must hold even for a coalition
  of players, except for what the coalition legitimately knows together.
* **Cheating player** (actively deviates: wrong shuffle, lies in the sight
  exchange, fails a mission while good, equivocates): every deviation must be
  either **prevented** by a zero-knowledge proof checked by every client before
  it is used, or **detected and attributed** by the end-of-game audit. The
  outcome screen then shows "Game invalid: <player> cheated (<reason>)".
  Prevention is required where a deviation would leak secrets (shuffles, the
  receiver side of the sight exchange); audit is acceptable where it only
  corrupts the game (lying sender in the sight exchange, good player failing).
* **Relay / outsider**: sees only public data and ciphertexts. May drop or delay
  messages (liveness), cannot forge (all writes are SEA-signed in user space).
* **Stalling player**: can stop the game from progressing (refuses a step). The
  lobby admin can cancel; timeouts are surfaced in the UI.

Non-goals: preventing players from talking out of band; anonymity of lobby
membership; protecting against a player who controls every other seat.

## 2. Building blocks

* **Identity**: anonymous device keys only. Each browser creates a SEA key pair
  on first visit (persisted in `localStorage`) and authenticates GUN with it
  (`gun.user().auth(pair)`). A player's id (`uid`) is their SEA `pub`. Every
  protocol message is written by its author into their own user space
  (`~<pub>/avalon/...`), so GUN/SEA guarantee authorship and integrity.
* **Group**: ristretto255 via `@noble/curves` (`ristretto255.Point`), hashes via
  `@noble/hashes` (SHA-512 / SHA-256). Domain-separated hash-to-curve for card
  points and transcript hashes. All randomness from `crypto.getRandomValues`.
* **Proofs** (non-interactive, Fiat-Shamir with a transcript that binds the game
  id, the step, and the prover's pub):
  * Schnorr proof of knowledge of a secret key.
  * Chaum-Pedersen DLEQ (correct partial decryption).
  * CDS disjunctive (OR) proofs of DLEQ statements.
  * Cut-and-choose proof of a correct shuffle (re-encryption + permutation),
    soundness >= 2^-40.
* **Exponential ElGamal** under the joint game key for votes; **ElGamal on card
  points** for the deck.
* **Private messages** (e.g. decryption shares for a single seat): SEA ECDH
  (`SEA.secret(recipient.epub, myPair)`) + `SEA.encrypt`, published in the
  sender's user space at a slot only the recipient can decrypt.

## 3. Lobbies

* A lobby is created by its admin: a fresh random 4-letter code (alphabet
  without ambiguous letters). The lobby record lives in the admin's user space
  `~admin/avalon/lobbies/<code>`; a public index `avalon/lobby/<code>` lists
  candidate admin pubs (anyone can write it, so clients verify each candidate's
  signed lobby record and pick the most recently active one that is not ended).
* Joining: the player writes a signed join record in their own space and
  announces their pub under `avalon/lobby/<code>/<admin>/members/<pub>`. The
  member list is computed from those announcements minus leaves (signed by the
  member) and kicks (signed by the admin). Names are unique per lobby (first
  join wins, deterministic tie-break on pub).
* Presence: periodic heartbeat in the member's own space; UI shows offline
  players; admin succession if the admin is offline for a while (deterministic:
  next member in join order).
* Starting a game: the admin publishes `GameConfig` = {gameId, seats (ordered
  list of {name, pub, epub}), roles in play, options, configHash}. Every later
  message carries `configHash`.

## 4. Game protocol

Notation: `n` seats, `G` the ristretto base point, `H(...)` domain-separated hash.

### 4.1 Key setup
Each seat `j` picks `x_j`, publishes `y_j = x_j G` with a Schnorr proof.
Joint key `Y = sum y_j`. (Rogue-key attacks are prevented by the PoK.)

### 4.2 Deck and dealing
1. The role list (from the config) becomes `n` card points
   `M = HashToCurve("avalon/card", role, isAssassin)`. Exactly one card carries
   the assassin flag: the evil role with the highest `assassinationPriority`
   when MERLIN is in play (first such card in config order).
2. Initial deck: `(0, M_i)` in canonical order. Seats shuffle in seat order:
   seat `j` permutes and re-encrypts under `Y`, publishing the new deck and a
   shuffle proof. Every client verifies every shuffle proof before continuing.
3. Card `i` of the final deck belongs to seat `i`. Every other seat `j`
   publishes `d_{j,i} = x_j A_i` with a DLEQ proof, encrypted to seat `i` (SEA).
   Seat `i` computes `M_i = B_i - sum_j d_{j,i} - x_i A_i`, identifies its role,
   and verifies the DLEQ proofs. Nobody else can decrypt card `i` (it needs
   `x_i`).
4. A sanity check: the multiset of roles cannot be verified before the end, but
   the shuffle proofs guarantee the final deck is a permutation of the initial
   one.

### 4.3 Sight exchange (who sees whom)
For every ordered pair (viewer `Q`, target `P`), `Q` must learn
`seen(role_Q, role_P)` = `role_P in ROLES[role_Q].sees` (with the assassin card
counting as ASSASSIN) and nothing else; `P` must learn nothing about `role_Q`.
This is a 1-out-of-R oblivious transfer (Chou-Orlandi style over ristretto255)
where `P` is the sender with messages `m_r = seen(r, role_P)` for every role `r`
in play, and `Q` chooses `r = role_Q`.

* Receiver binding (prevents a Loyal Follower from choosing "Merlin" to learn
  the evil team): together with its OT choice, `Q` publishes a CDS OR-proof that
  for the chosen index `c`, (its card decrypts to `M_c`, proven as a DLEQ using
  its own key `x_Q` and the published shares) AND (the OT message encodes `c`).
  The shares `d_{j,Q}` needed for this proof are published in the clear for this
  purpose (they do not help decrypt without `x_Q`). Senders verify the proof
  before answering.
* Sender honesty (an evil player claiming not to be seen) is checked by the
  audit: at the end every sender reveals its OT secrets.
* The resulting `sees` list is shuffled locally before display, as today.

### 4.4 First proposer
`H(transcript of all shuffles) mod n` (unbiasable unless the last shuffler
grinds; acceptable).

### 4.5 Team proposal
The proposer publishes `{mission, proposal, team, prevHash}` signed in their
space. Validity is checked by every client (right proposer, right size, members
exist, phase). `prevHash` chains each action to the state it responds to, so a
rewritten proposal invalidates later votes and is flagged as equivocation.

### 4.6 Proposal vote (simultaneous reveal)
Commit-reveal: every seat publishes `commit = H(vote, nonce, slot)`; once all `n`
commits are visible, each seat publishes `(vote, nonce)`. A vote is counted only
if it matches its commit. The approvers become public (`proposal.votes`) as
today; rejected/approved and the 5-rejections rule follow the existing server
logic.

### 4.7 Mission vote (only the fail count is revealed)
Each team member publishes `E = (rG, vG + rY)` with `v in {0,1}` (1 = fail), plus:
* an OR-proof that `v in {0,1}`;
* SHOULD: an OR-proof that (`v = 0`) OR (its card decrypts to an evil card), so a
  good player cannot fail. If too expensive, the audit catches it instead.
Once all team members voted, every seat publishes a DLEQ-proven share of the
homomorphic sum's decryption; clients brute-force `k` in `0..teamSize` from
`kG` = number of fails. Individual votes stay hidden until the audit.

### 4.8 Assassination
As in the board game, the assassin reveals themselves: they publish the target
and open their own card (publishing their share with a DLEQ proof), proving
they hold the assassin card. The target's role is learned at the reveal.

### 4.9 End of game, reveal and audit
The game ends (3 fails, 3 successes without Merlin, 5 rejections, assassination
or cancel). Every seat then publishes `x_j` and its OT sender secrets. Each
client recomputes: all cards, all mission votes, all OT answers, and checks
every rule. Outcome = today's `GameOutcome` (`state`, `message`, `assassinated`,
`roles`, `votes`) plus `cheaters: {name, reason}[]`. If a seat never reveals,
the outcome lists it as "did not reveal".

### 4.10 Cancel / leave
The admin (or any player leaving an active game) publishes a cancel; then the
reveal happens as above (roles are shown, as today on cancel).

## 5. Replacing the rest of Firebase

* `users/{uid}`: local only (name, current lobby) plus the player's own history
  in their user space.
* Logs: each finished game's public outcome is written to `avalon/logs/<gameId>`
  (and indexed under the players' spaces).
* Stats: per-user stats computed client-side from the user's own history; global
  stats computed client-side from the public logs index (bounded).
* The Express server becomes a static file host + GUN relay peer (radisk). It
  holds no secrets and runs no game logic. `firebase/`, `firebase-admin`,
  `firebase` (client), the REST API and `server/avalon-server.ts` are removed;
  the game rules move to `common/` so every client runs them.

## 6. Code layout (proposed)

* `common/crypto/`: group, hashing, ElGamal, proofs, shuffle, OT, tally.
* `common/protocol/`: message types, deterministic state machine
  (`(config, messages) -> GameView` per seat), validation, audit, stats.
* `client/src/p2p/`: GUN wiring (identity, lobby, transport, protocol driver
  that performs this seat's steps automatically) behind the existing
  `AvalonGame` API used by the Vue components.
* `server/`: relay + static hosting.
* Tests: unit tests for crypto and protocol (including cheating scenarios),
  Playwright e2e of full games through the relay.
