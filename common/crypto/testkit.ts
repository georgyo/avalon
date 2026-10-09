/**
 * Deterministic fixtures for the crypto tests and bench (not exported from index.ts).
 * Simulates the cryptographic core of a game: keys, the shuffle chain, dealing,
 * and the sight exchange, using only common/crypto.
 */
import { ROLES } from '../avalonlib.ts';
import { concat, hexEncode, sha256, u32, utf8, type RandomSource } from './bytes.ts';
import { G, O, mul, type Point, type Scalar } from './group.ts';
import { deriveStream, type SeedRef } from './derive.ts';
import { proveSigma, type ProofContext } from './sigma.ts';
import type { Ct } from './elgamal.ts';
import { cardPoint, findLabel, labelEq } from './cards.ts';
import { initialDeck, proveShuffle, type ShuffleOutput } from './shuffle.ts';
import { dealStatement, otProfileStatement, otEqStatement, otRecvStatement, pokStatement } from './statements.ts';
import { otChoice, otSenderMessages } from './ot.ts';
import type { CardLabel, SigmaProofE } from './types.ts';

/** Deterministic byte source: SHA-256 in counter mode over a numeric seed. */
export function seededRandom(seed: number): RandomSource {
  let counter = 0;
  return (n: number): Uint8Array => {
    const parts: Uint8Array[] = [];
    let have = 0;
    while (have < n) {
      const blk = sha256(utf8('test-rng'), u32(seed), u32(counter++));
      parts.push(blk);
      have += blk.length;
    }
    return concat(...parts).slice(0, n);
  };
}

export const CONFIG_ID = hexEncode(sha256(utf8('test-config')));
export const GAME_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

export function seedFor(seat: number, gameId: string = GAME_ID): SeedRef {
  return { gameSeed: sha256(utf8('test-game-seed'), u32(seat)), gameId };
}

export function ctxFor(stepId: string, seat: number): ProofContext {
  return { configId: CONFIG_ID, stepId, prover: `PUB${seat}.${'x'.repeat(40)}` };
}

/** Name-only sight rule (§5.1), a test-local copy of what rules.ts (WP-B) provides. */
export function seen(viewer: string, target: string): boolean {
  const r = ROLES.find((x) => x.name === viewer);
  if (r === undefined) throw new Error(`unknown role ${viewer}`);
  return r.sees.includes(target);
}

export function teamOf(role: string): 'good' | 'evil' {
  const r = ROLES.find((x) => x.name === role);
  if (r === undefined) throw new Error(`unknown role ${role}`);
  return r.team;
}

/** Distinct labels in first-occurrence order (Λ). */
export function distinctLabels(deck: readonly CardLabel[]): CardLabel[] {
  const out: CardLabel[] = [];
  for (const l of deck) if (!out.some((x) => labelEq(x, l))) out.push(l);
  return out;
}

/** Distinct role names in ROLES order (N_roles). */
export function roleNamesInPlay(deck: readonly CardLabel[]): string[] {
  return ROLES.map((r) => r.name).filter((name) => deck.some((l) => l.role === name));
}

const lf = (role: string, assassin = false): CardLabel => ({ role, assassin });

/** Sample decks in canonical order (evil first), per player count. */
export function sampleDeck(n: number): CardLabel[] {
  switch (n) {
    case 5: return [lf('MORGANA', true), lf('EVIL MINION'), lf('MERLIN'), lf('PERCIVAL'), lf('LOYAL FOLLOWER')];
    case 6: return [lf('MORDRED', true), lf('EVIL MINION'), lf('MERLIN'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER')];
    case 7: return [lf('MORGANA'), lf('OBERON'), lf('ASSASSIN', true), lf('MERLIN'), lf('PERCIVAL'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER')];
    case 8: return [lf('EVIL MINION', true), lf('EVIL MINION'), lf('EVIL MINION'), lf('MERLIN'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER')];
    case 9: return [lf('MORGANA'), lf('MORDRED'), lf('ASSASSIN'), lf('PERCIVAL'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER')];
    case 10: return [lf('MORGANA'), lf('MORDRED'), lf('OBERON'), lf('ASSASSIN', true), lf('MERLIN'), lf('PERCIVAL'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER'), lf('LOYAL FOLLOWER')];
    default: throw new Error(`no sample deck for n = ${n}`);
  }
}

export interface Keys { x: Scalar[]; y: Point[]; Y: Point; pok: SigmaProofE[]; seeds: SeedRef[] }

export function makeKeys(n: number): Keys {
  const seeds = Array.from({ length: n }, (_, j) => seedFor(j));
  const x = seeds.map((s) => deriveStream(s, 'x').scalar());
  const y = x.map((xi) => mul(G, xi));
  const pok = y.map((yj, j) => proveSigma(pokStatement(ctxFor('key', j), yj), 0, [x[j]], seeds[j]));
  const Y = y.reduce((acc, p) => acc.add(p), O);
  return { x, y, Y, pok, seeds };
}

export interface Table {
  n: number;
  labels: CardLabel[];
  Lambda: CardLabel[];
  roleNames: string[];
  keys: Keys;
  shuffles: ShuffleOutput[];
  inputs: Ct[][];
  final: Ct[];
  d: (Point | null)[][];
  dealProofs: SigmaProofE[];
  C: Point[];
  seatLabel: CardLabel[];
}

/** Keys, the full shuffle chain and the dealing for a sample deck. */
export function setupTable(n: number, labels: CardLabel[] = sampleDeck(n), shufflers: number = n): Table {
  const keys = makeKeys(n);
  const inputs: Ct[][] = [initialDeck(labels)];
  const shuffles: ShuffleOutput[] = [];
  for (let j = 0; j < shufflers; j++) {
    const out = proveShuffle(ctxFor(`shuf/${j}`, j), keys.Y, inputs[j], keys.seeds[j]);
    shuffles.push(out);
    inputs.push(out.deck);
  }
  const final = inputs[inputs.length - 1];
  const A = final.map((c) => c.a);
  const d = keys.x.map((xj, j) => A.map((Ai, i) => (i === j ? null : mul(Ai, xj))));
  const dealProofs = d.map((dj, j) => proveSigma(dealStatement(ctxFor('deal', j), keys.y[j], A, dj), 0, [keys.x[j]], keys.seeds[j]));
  const C = final.map((ct, i) => {
    let acc = ct.b;
    for (let j = 0; j < n; j++) {
      const share = d[j][i];
      if (j !== i && share !== null) acc = acc.subtract(share);
    }
    return acc;
  });
  const seatLabel = C.map((Ci, i) => {
    const l = findLabel(Ci.subtract(mul(A[i], keys.x[i])), labels);
    if (l === null) throw new Error(`seat ${i} could not decrypt its card`);
    return l;
  });
  const Lambda = distinctLabels(labels);
  return { n, labels, Lambda, roleNames: roleNamesInPlay(labels), keys, shuffles, inputs, final, d, dealProofs, C, seatLabel };
}

export interface OtRecv { beta: Scalar; c: number; U: Point; proof: SigmaProofE }

export function otRecv(t: Table, Q: number): OtRecv {
  const seed = t.keys.seeds[Q];
  const lab = t.seatLabel[Q];
  const beta = deriveStream(seed, 'ot-beta').scalar();
  const c = t.roleNames.indexOf(lab.role);
  const U = otChoice(beta, c);
  const st = otRecvStatement(ctxFor('otR', Q), t.keys.y[Q], t.final[Q].a, t.C[Q], U,
    t.Lambda.map(cardPoint), t.Lambda.map((l) => t.roleNames.indexOf(l.role)));
  const real = t.Lambda.findIndex((l) => labelEq(l, lab));
  const proof = proveSigma(st, real, [t.keys.x[Q], beta], seed);
  return { beta, c, U, proof };
}

export function seenRows(t: Table): (0 | 1)[][] {
  return t.Lambda.map((l) => t.roleNames.map((nu): 0 | 1 => (seen(nu, l.role) ? 1 : 0)));
}

export interface OtSend { F: Ct[]; E: (Ct[] | null)[]; profile: SigmaProofE; eq: SigmaProofE }

export function otSend(t: Table, P: number, U: (Point | null)[]): OtSend {
  const seed = t.keys.seeds[P];
  const lab = t.seatLabel[P];
  const bits = t.roleNames.map((nu): 0 | 1 => (seen(nu, lab.role) ? 1 : 0));
  const Uo = U.map((u, i) => (i === P ? null : u));
  const m = otSenderMessages(seed, bits, Uo, P);
  const profSt = otProfileStatement(ctxFor('otS', P), t.keys.y[P], t.final[P].a, t.C[P], m.F, t.Lambda.map(cardPoint), seenRows(t));
  const profile = proveSigma(profSt, t.Lambda.findIndex((l) => labelEq(l, lab)), [t.keys.x[P], ...m.f], seed);
  const eqSt = otEqStatement(ctxFor('otS', P), m.F, m.E, Uo);
  const kFlat: Scalar[] = [];
  for (const row of m.k) if (row !== null) kFlat.push(...row);
  const eq = proveSigma(eqSt, 0, [...m.f, ...kFlat], seed);
  return { F: m.F, E: m.E, profile, eq };
}
