/**
 * Game rules (docs/p2p-protocol.md §5.1, §5.6, Appendix B) and the RULES
 * descriptor whose hash every config carries (§4.6).
 *
 * The rule-relevant fields of ROLES are snapshotted at module load: the client
 * toggles `ROLES[i].selected` in place, which must never change the rules.
 */
import { ROLES, type Team } from '../avalonlib.ts';
import { canon, hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import { allPossibleLabels, cardPoint } from '../crypto/cards.ts';
import { encPoint, G, GEN } from '../crypto/group.ts';
import type { CardLabel, Hex32 } from '../crypto/types.ts';

export { ROLES } from '../avalonlib.ts';

export const LOBBY_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ';
export const LOBBY_CODE_RE = /^[A-HJ-NP-TV-Z]{4}$/;
export const NAME_RE = /^[A-Z]{1,20}$/;
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const NUM_MISSIONS = 5;
export const MAX_PROPOSALS = 5;
export const MISSIONS_TO_WIN = 3;

interface RoleRule {
  readonly name: string;
  readonly team: Team;
  readonly sees: readonly string[];
  readonly filler: boolean;
  readonly selectable: boolean;
  readonly assassinationPriority: number;
}

const ROLE_RULES: readonly RoleRule[] = Object.freeze(ROLES.map((r) => Object.freeze({
  name: r.name,
  team: r.team,
  sees: Object.freeze([...r.sees]),
  filler: r.filler === true,
  selectable: r.selectable,
  assassinationPriority: r.assassinationPriority ?? 0,
})));

const ROLE_BY_NAME: ReadonlyMap<string, RoleRule> = new Map(ROLE_RULES.map((r) => [r.name, r]));

const NUM_EVIL_TABLE: Readonly<Record<number, number>> = Object.freeze({ 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 });
const MISSION_SIZES_TABLE: Readonly<Record<number, readonly number[]>> = Object.freeze({
  5: Object.freeze([2, 3, 2, 3, 3]),
  6: Object.freeze([2, 3, 4, 3, 4]),
  7: Object.freeze([2, 3, 3, 4, 4]),
  8: Object.freeze([3, 4, 4, 5, 5]),
  9: Object.freeze([3, 4, 4, 5, 5]),
  10: Object.freeze([3, 4, 4, 5, 5]),
});

function checkN(n: number): void {
  if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) throw new RangeError(`invalid number of players: ${n}`);
}

function roleRule(name: string): RoleRule {
  const r = ROLE_BY_NAME.get(name);
  if (r === undefined) throw new RangeError(`unknown role: ${name}`);
  return r;
}

export function isRoleName(name: string): boolean {
  return ROLE_BY_NAME.has(name);
}

export function numEvil(n: number): number {
  checkN(n);
  return NUM_EVIL_TABLE[n];
}

export function missionSizes(n: number): number[] {
  checkN(n);
  return [...MISSION_SIZES_TABLE[n]];
}

/** 2 for mission index 3 when n ≥ 7, else 1 (§5.6). */
export function failsRequired(n: number, mission: number): number {
  checkN(n);
  if (!Number.isInteger(mission) || mission < 0 || mission >= NUM_MISSIONS) throw new RangeError(`invalid mission: ${mission}`);
  return mission === 3 && n >= 7 ? 2 : 1;
}

/** A proposal is approved iff approvers ≥ floor(n/2) + 1 (§5.6). */
export function approvalsRequired(n: number): number {
  checkN(n);
  return (n >> 1) + 1;
}

/** The seat after `seat` (proposer rotation, §5.6). */
export function nextSeat(seat: number, n: number): number {
  checkN(n);
  if (!Number.isInteger(seat) || seat < 0 || seat >= n) throw new RangeError(`invalid seat: ${seat}`);
  return seat + 1 === n ? 0 : seat + 1;
}

export function teamOf(role: string): 'good' | 'evil' {
  return roleRule(role).team;
}

/** Sight rule (§5.1): depends on role names only; the assassin flag never changes visibility. */
export function seen(viewerRole: string, targetRole: string): boolean {
  roleRule(targetRole);
  return roleRule(viewerRole).sees.includes(targetRole);
}

/** Error text or null (§3.3, Appendix B: /^[A-Z]{1,20}$/ and not a role name). */
export function validateName(name: string): string | null {
  if (typeof name !== 'string' || !NAME_RE.test(name) || ROLE_BY_NAME.has(name)) return 'Invalid name';
  return null;
}

/** `selected` ⊆ selectable role names, unique, in ROLES order (§4.6). */
export function validateSelectedRoles(selected: readonly string[]): boolean {
  if (!Array.isArray(selected)) return false;
  let last = -1;
  for (const name of selected) {
    if (typeof name !== 'string') return false;
    const idx = ROLE_RULES.findIndex((r) => r.name === name);
    if (idx < 0 || !ROLE_RULES[idx].selectable || idx <= last) return false;
    last = idx;
  }
  return true;
}

/** Deck derivation (§5.1): exact port of the legacy assignRoles, canonical order evil then good. */
export function deriveDeck(n: number, selected: readonly string[]): CardLabel[] {
  const nEvil = numEvil(n);
  const makeTeam = (size: number, team: Team): string[] => {
    const teamRoles = ROLE_RULES.filter((r) => r.team === team);
    const specials = teamRoles.filter((r) => selected.includes(r.name)).slice(0, size);
    const filler = teamRoles.find((r) => r.filler);
    if (filler === undefined) throw new Error(`no filler role for team ${team}`);
    const out = specials.map((r) => r.name);
    while (out.length < size) out.push(filler.name);
    return out;
  };
  const evil: CardLabel[] = makeTeam(nEvil, 'evil').map((role) => ({ role, assassin: false }));
  const good: CardLabel[] = makeTeam(n - nEvil, 'good').map((role) => ({ role, assassin: false }));
  if (selected.includes('MERLIN')) {
    // lodash _.maxBy: the first maximum wins
    let best = 0;
    evil.forEach((l, i) => {
      if (roleRule(l.role).assassinationPriority > roleRule(evil[best].role).assassinationPriority) best = i;
    });
    evil[best].assassin = true;
  }
  return [...evil, ...good];
}

/** Λ: distinct labels of the deck in first-occurrence order (§5.1). */
export function distinctLabels(deck: readonly CardLabel[]): CardLabel[] {
  const out: CardLabel[] = [];
  for (const l of deck) {
    if (!out.some((o) => o.role === l.role && o.assassin === l.assassin)) out.push({ role: l.role, assassin: l.assassin });
  }
  return out;
}

/** N_roles: distinct role names in play, in ROLES order (§5.1). */
export function roleNamesInPlay(deck: readonly CardLabel[]): string[] {
  return ROLE_RULES.filter((r) => deck.some((l) => l.role === r.name)).map((r) => r.name);
}

/** Whether MERLIN is in play (assassination phase after three successes). */
export function merlinInPlay(deck: readonly CardLabel[]): boolean {
  return deck.some((l) => l.role === 'MERLIN');
}

// ---------------------------------------------------------------- RULES descriptor

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

const N_RANGE = [5, 6, 7, 8, 9, 10];

/**
 * Canonical descriptor of every rule constant, domain-separation tag and
 * generator (by label and by value), so two builds with different rules,
 * tags or card points get different RULES_HASH values (§4.6, version skew).
 */
export const RULES = deepFreeze({
  protocol: 'avalon-p2p/v1',
  players: { min: MIN_PLAYERS, max: MAX_PLAYERS },
  roles: ROLE_RULES.map((r) => ({
    name: r.name, team: r.team, sees: [...r.sees], filler: r.filler, selectable: r.selectable,
    assassinationPriority: r.assassinationPriority,
  })),
  numEvil: N_RANGE.map((n) => [n, NUM_EVIL_TABLE[n]]),
  missionSizes: N_RANGE.map((n) => [n, [...MISSION_SIZES_TABLE[n]]]),
  failsRequired: { default: 1, mission: 3, minPlayers: 7, value: 2 },
  approval: 'approvers >= floor(n/2) + 1',
  maxProposals: MAX_PROPOSALS,
  missionsToWin: MISSIONS_TO_WIN,
  deck: 'evil: selected evil roles in ROLES order, sliced to numEvil, then EVIL MINION filler; ' +
    'good: likewise with LOYAL FOLLOWER; MERLIN selected: the first evil card with the highest ' +
    'assassinationPriority is the assassin; canonical order evil then good',
  sight: 'seen(viewer, target) = ROLES[viewer.role].sees includes target.role (names only)',
  goodCannotFail: true,
  assassination: 'three successes with MERLIN in play; EVIL_WIN iff the target is MERLIN',
  lobby: { alphabet: LOBBY_ALPHABET, codeLength: 4, name: '^[A-Z]{1,20}$', maxMembers: MAX_PLAYERS },
  limits: { maxValueBytes: 65536 },
  tags: {
    gen: 'avalon-p2p/v1/gen',
    card: 'avalon-p2p/v1/card',
    fs: 'avalon-p2p/v1/fs/<proofType>',
    shuffleU: 'avalon-p2p/v1/shuffle-u',
    derive: 'avalon-p2p/v1/derive',
    msg: 'avalon-p2p/v1/msg\\0',
    sig: 'avalon-p2p/v1/sig\\0',
    step: 'avalon-p2p/v1/step\\0',
    seed: 'avalon-p2p/v1/seed\\0',
    beacon: 'avalon-p2p/v1/beacon\\0',
    pvote: 'avalon-p2p/v1/pvote\\0',
  },
  generators: {
    labels: { S: 'ot-S', J: 'ot-J', H0: 'shuffle-H', H: GEN.H.map((_, i) => 'shuffle-H/' + i) },
    G: encPoint(G),
    S: encPoint(GEN.S),
    J: encPoint(GEN.J),
    H0: encPoint(GEN.H0),
    H: GEN.H.map((P) => encPoint(P)),
  },
  cards: allPossibleLabels().map((l) => ({ role: l.role, assassin: l.assassin, point: encPoint(cardPoint(l)) })),
});

export type Rules = typeof RULES;

/** hex(SHA256(utf8(canon(RULES)))), pinned by rules.test.ts. */
export const RULES_HASH: Hex32 = hexEncode(sha256(utf8(canon(RULES))));
