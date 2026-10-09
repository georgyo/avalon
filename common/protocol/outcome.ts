/**
 * End of game (docs/p2p-protocol.md §5.12-5.13, §3.7 rule 5a): roles and
 * mission votes from the reveals, elimination, audit, and the outcome label
 * and message of a terminal GameEval.
 */
import { findLabel, labelEq } from '../crypto/cards.ts';
import { decScalar, G, mod, mulPub, O, type Point, type Scalar } from '../crypto/group.ts';
import type { CardLabel, Hex32 } from '../crypto/types.ts';
import { dpt, finalA, Lru, pendingVoteReveals, revealKeyOk, type GameEval, type Terminal } from './machine.ts';
import { deriveDeck, distinctLabels, teamOf } from './rules.ts';
import type { Bodies, GameConfig, StoredMsg } from './types.ts';
import type { GameOutcome, RoleAssignment } from './views.ts';

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function compareHex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ballot value v (0 success, 1 fail) of b − r·Y, or null if it is neither O nor G. */
function openWith(b: Point, rY: Point): 0 | 1 | null {
  const X = b.subtract(rY);
  if (X.equals(O)) return 0;
  if (X.equals(G)) return 1;
  return null;
}

interface Revealed { x: Scalar; votes: Map<number, 0 | 1>; msgId: Hex32 }

/**
 * Valid reveals by seat (§5.12): x·G = y_j and every listed ballot entry of a
 * mission on the natural chain opens this seat's ballot. Returns the valid
 * reveal of each seat and the seats whose reveals are all invalid.
 */
export function collectReveals(config: GameConfig, ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>):
  { revealed: Map<number, Revealed>; invalid: number[] } {
  const s = ev.state;
  const revealed = new Map<number, Revealed>();
  const bad = new Set<number>();
  if (s.y === null || s.Y === null) return { revealed, invalid: [] };
  const Y = dpt(s.Y);
  const list = [...msgs.values()]
    .filter((m) => m.env.type === 'reveal' && m.env.game === config.gameId)
    .sort((a, b) => compareHex(a.msgId, b.msgId));
  for (const m of list) {
    const seat = config.seats.findIndex((x) => x.pub === m.env.author);
    if (seat < 0 || revealed.has(seat)) continue;
    if (!revealKeyOk(m, s.y[seat])) {
      bad.add(seat);
      continue;
    }
    const body = m.env.body as Bodies['reveal'];
    const votes = new Map<number, 0 | 1>();
    let ok = true;
    for (const e of body.ballots) {
      const ms = s.missions[e.m];
      if (ms === undefined || ms.team === null || ms.ballots === null) continue;
      const i = ms.team.indexOf(seat);
      if (i < 0) continue;
      try {
        const r = decScalar(e.r);
        const ballot = ms.ballots[i];
        const v = mulPub(G, r).equals(dpt(ballot.a)) ? openWith(dpt(ballot.b), mulPub(Y, r)) : null;
        if (v === null) ok = false;
        else votes.set(e.m, v);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      bad.add(seat);
      continue;
    }
    revealed.set(seat, { x: decScalar(body.x), votes, msgId: m.msgId });
  }
  return { revealed, invalid: [...bad].filter((j) => !revealed.has(j)).sort((a, b) => a - b) };
}

export interface Resolution {
  /** Whether cards exist (all shuffles done): seat i holds card i. */
  cards: boolean;
  labels: (CardLabel | null)[];
  /** Team per seat: known label, or inferred from one-team unresolved labels (§5.12). */
  teams: ('good' | 'evil' | null)[];
  unresolved: CardLabel[];
  /** votes[m][seat] (0 success, 1 fail) for missions whose ballots are on the chain. */
  votes: Map<number, 0 | 1>[];
  revealed: Map<number, Revealed>;
  invalidReveals: number[];
  audit: { seat: number; reason: string }[];
}

function multisetMinus(deck: readonly CardLabel[], known: readonly CardLabel[]): CardLabel[] | null {
  const rest = deck.map((l) => ({ ...l }));
  for (const k of known) {
    const i = rest.findIndex((l) => labelEq(l, k));
    if (i < 0) return null;
    rest.splice(i, 1);
  }
  return rest;
}

/** §5.12: labels, teams and votes from the reveals, with elimination and audit. */
export function resolveReveals(config: GameConfig, ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>): Resolution {
  const s = ev.state;
  const n = s.n;
  const deck = deriveDeck(n, config.selectedRoles);
  const labelsAll = distinctLabels(deck);
  const { revealed, invalid } = collectReveals(config, ev, msgs);
  const audit: { seat: number; reason: string }[] = [];
  const A = finalA(s);
  const labels: (CardLabel | null)[] = new Array<CardLabel | null>(n).fill(null);
  // Cards exist once the final deck's shuffles are all verified (the deal gate): before that, a
  // structurally complete but unproven deck may decrypt to anything.
  const cards = A !== null && ev.shufflesVerified;
  const allX = revealed.size === n ? mod([...revealed.values()].reduce((acc, r) => acc + r.x, 0n)) : null;
  if (A !== null && cards) {
    for (let j = 0; j < n; j++) {
      const r = revealed.get(j);
      let P: Point | null = null;
      if (r !== undefined && s.C !== null) P = dpt(s.C[j]).subtract(mulPub(dpt(A[j]), r.x));
      else if (allX !== null) {
        const fin = s.decks[n - 1][j];
        P = dpt(fin.b).subtract(mulPub(dpt(fin.a), allX));
      }
      if (P !== null) {
        const l = findLabel(P, labelsAll);
        if (l === null) audit.push({ seat: -1, reason: 'audit: card does not decrypt to a label' });
        labels[j] = l;
      }
    }
    // A false assassination claim (§5.10) opened its author's card publicly: C_a − O_a is its label.
    for (const f of ev.terminal?.faults ?? []) {
      if (f.reason !== 'false assassination claim' || s.C === null) continue;
      const m = msgs.get(f.evidence[0]);
      if (m === undefined || m.env.type !== 'assassinate') continue;
      let l: CardLabel | null;
      try {
        l = findLabel(dpt(s.C[f.seat]).subtract(dpt((m.env.body as Bodies['assassinate']).open)), labelsAll);
      } catch {
        l = null;
      }
      if (l === null) continue;
      const known = labels[f.seat];
      if (known === null) labels[f.seat] = l;
      else if (!labelEq(known, l)) audit.push({ seat: -1, reason: 'audit: assassination claim opening does not match' });
    }
    if (s.assassination !== null) {
      const a = s.assassination.assassin;
      const lam = deck.find((l) => l.assassin) ?? null;
      if (lam !== null) {
        if (labels[a] === null) labels[a] = { ...lam };
        else if (!labelEq(labels[a] as CardLabel, lam)) audit.push({ seat: a, reason: 'audit: assassin opening does not match' });
      }
    }
  }
  let unresolved: CardLabel[] = [];
  const teams: ('good' | 'evil' | null)[] = labels.map((l) => (l === null ? null : teamOf(l.role)));
  if (cards) {
    const known = labels.filter((l): l is CardLabel => l !== null);
    const rest = multisetMinus(deck, known);
    if (rest === null) {
      audit.push({ seat: -1, reason: 'audit: revealed cards do not match the deck' });
    } else {
      unresolved = rest;
      const unknown = labels.map((l, j) => (l === null ? j : -1)).filter((j) => j >= 0);
      if (unknown.length > 0 && rest.length === unknown.length) {
        const same = rest.every((l) => labelEq(l, rest[0]));
        if (same) {
          for (const j of unknown) {
            labels[j] = { ...rest[0] };
            teams[j] = teamOf(rest[0].role);
          }
          unresolved = [];
        } else {
          const t = teamOf(rest[0].role);
          if (rest.every((l) => teamOf(l.role) === t)) for (const j of unknown) teams[j] = t;
        }
      }
    }
  }

  // Votes (§5.12): own r, all keys, or elimination with the tally.
  const votes: Map<number, 0 | 1>[] = [];
  const Y = s.Y === null ? null : dpt(s.Y);
  s.missions.forEach((ms, m) => {
    if (ms.team === null || ms.ballots === null) return;
    const vm = new Map<number, 0 | 1>();
    ms.team.forEach((seat, i) => {
      const r = revealed.get(seat);
      const v = r?.votes.get(m);
      if (v !== undefined) vm.set(seat, v);
      else if (allX !== null && Y !== null) {
        const b = ms.ballots?.[i];
        if (b !== undefined) {
          const X = dpt(b.b).subtract(mulPub(dpt(b.a), allX));
          const w = X.equals(O) ? 0 : X.equals(G) ? 1 : null;
          if (w !== null) vm.set(seat, w);
        }
      }
    });
    const unknown = ms.team.filter((seat) => !vm.has(seat));
    if (unknown.length === 1 && ms.numFails !== null) {
      let known = 0;
      for (const v of vm.values()) known += v;
      const v = ms.numFails - known;
      if (v === 0 || v === 1) vm.set(unknown[0], v);
      else audit.push({ seat: -1, reason: 'audit: mission votes inconsistent with the tally' });
    }
    if (ms.numFails !== null && vm.size === ms.team.length) {
      let sum = 0;
      for (const v of vm.values()) sum += v;
      if (sum !== ms.numFails) audit.push({ seat: -1, reason: 'audit: mission votes inconsistent with the tally' });
    }
    for (const [seat, v] of vm) {
      const l = labels[seat];
      if (v === 1 && l !== null && teamOf(l.role) === 'good') audit.push({ seat, reason: 'audit: good player failed a mission' });
    }
    votes[m] = vm;
  });
  return { cards, labels, teams, unresolved, votes, revealed, invalidReveals: invalid, audit };
}

const CANCEL_TEXT: Record<string, (name: string) => string> = {
  cancel: (name) => `Canceled by ${name}`,
  leave: (name) => `${name} left the game`,
  abort: (name) => `${name} aborted the start`,
  lost: (name) => `${name} lost their game keys`,
};

const outcomeCache = new Lru<string, GameOutcome>(256);

/** The outcome of a terminal game (§5.13), or null while the game is not terminal. */
export function computeOutcome(config: GameConfig, ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>): GameOutcome | null {
  const term = ev.terminal;
  if (term === null) return null;
  // The outcome is a function of the evaluation and of the game's reveals and vote reveals (rule 5a).
  const extra: Hex32[] = [];
  for (const m of msgs.values()) {
    if (m.env.game === config.gameId && (m.env.type === 'reveal' || (m.env.type === 'vote.reveal' && m.env.prev === ev.head))) extra.push(m.msgId);
  }
  const key = [config.gameId, ev.head, String(ev.shufflesVerified), term.kind, term.atStep, String(term.by), term.basis.join(','),
    term.faults.map((f) => `${f.seat}:${f.reason}`).join(','), JSON.stringify(term.cancel ?? null), extra.sort().join(',')].join('|');
  const hit = outcomeCache.get(key);
  if (hit !== undefined) return structuredClone(hit);
  const out = computeOutcomeUncached(config, ev, msgs, term);
  outcomeCache.set(key, out);
  return structuredClone(out);
}

function computeOutcomeUncached(config: GameConfig, ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>, term: Terminal): GameOutcome {
  const s = ev.state;
  const names = config.seats.map((x) => x.name);
  const res = resolveReveals(config, ev, msgs);
  const cheaters: { name: string; reason: string }[] = [];
  for (const f of term.kind === 'invalid' ? term.faults : []) cheaters.push({ name: names[f.seat], reason: f.reason });
  for (const j of res.invalidReveals) cheaters.push({ name: names[j], reason: 'invalid reveal' });
  for (const a of res.audit) if (a.seat >= 0) cheaters.push({ name: names[a.seat], reason: a.reason });

  const roles: RoleAssignment[] = res.cards
    ? names.map((name, j) => {
      const l = res.labels[j];
      return { name, role: l === null ? 'UNKNOWN' : l.role, assassin: l === null ? false : l.assassin };
    })
    : [];
  const votes: Record<string, boolean>[] = res.votes.map((vm) => {
    const out: Record<string, boolean> = {};
    for (const [seat, v] of [...vm.entries()].sort((a, b) => a[0] - b[0])) out[names[seat]] = v === 0;
    return out;
  });
  const unrevealedSet = new Set<number>();
  if (res.cards) res.labels.forEach((l, j) => { if (l === null) unrevealedSet.add(j); });
  s.missions.forEach((ms, m) => {
    if (ms.team === null || ms.ballots === null) return;
    for (const seat of ms.team) if (!(res.votes[m]?.has(seat) ?? false)) unrevealedSet.add(seat);
  });
  const unrevealed = [...unrevealedSet].sort((a, b) => a - b).map((j) => names[j]);

  let state: GameOutcome['state'] = 'CANCELED';
  let message = '';
  let assassinated: string | undefined;
  let canceledBy: string | undefined;
  let stalled: string[] | undefined;

  const unknownSeatNames = (): string => joinNames(res.labels.map((l, j) => (l === null ? names[j] : null)).filter((x): x is string => x !== null));

  if (term.kind === 'natural') {
    if (s.result !== null) {
      state = s.result.state;
      message = s.result.message;
    } else if (s.assassination !== null) {
      const target = s.assassination.target;
      assassinated = names[target];
      const tl = res.labels[target];
      const merlinUnresolved = res.unresolved.some((l) => l.role === 'MERLIN');
      if (tl !== null) {
        if (tl.role === 'MERLIN') {
          state = 'EVIL_WIN';
          message = 'Merlin assassinated';
        } else {
          state = 'GOOD_WIN';
          message = 'Three successful missions';
        }
      } else if (res.cards && !merlinUnresolved) {
        state = 'GOOD_WIN';
        message = 'Three successful missions';
      } else {
        const t = res.teams[target];
        const base = `Assassination unresolved: ${unknownSeatNames()} did not reveal`;
        if (t !== null && res.unresolved.every((l) => teamOf(l.role) === t)) {
          state = t === 'good' ? 'EVIL_WIN' : 'GOOD_WIN';
          message = `${base}; ${t} forfeits`;
        } else {
          state = 'CANCELED';
          message = base;
        }
      }
    }
  } else if (term.kind === 'canceled') {
    const info = term.cancel;
    const by = term.by ?? 0;
    const stalledSeats = info?.stalled ?? [];
    const restored = info === undefined ? null : restoreWithheld(config, ev, msgs, res, term.atStep, stalledSeats.map((j) => names[j]));
    if (restored !== null) {
      state = restored.state;
      message = restored.message;
    } else {
      state = 'CANCELED';
      const text = CANCEL_TEXT[info?.reason ?? 'cancel'] ?? CANCEL_TEXT.cancel;
      message = text(names[by]);
      const others = stalledSeats.filter((j) => j !== by).map((j) => names[j]);
      if (info?.withholding === true) message += term.atStep.startsWith('mt/') ? ' while withholding the mission result' : ' while withholding the vote';
      if (others.length > 0) message += ', waiting for ' + others.join(', ');
    }
    canceledBy = names[by];
    if (stalledSeats.length > 0) stalled = stalledSeats.map((j) => names[j]);
  } else {
    const by = term.by ?? term.faults[0]?.seat ?? 0;
    const fault = term.faults.find((f) => f.seat === by) ?? term.faults[0];
    const reason = fault?.reason ?? 'invalid';
    const team = res.cards ? res.teams[by] : null;
    if (team !== null) {
      state = team === 'evil' ? 'GOOD_WIN' : 'EVIL_WIN';
      message = `${names[by]} cheated (${reason}); ${team} forfeits`;
    } else {
      state = 'CANCELED';
      message = `Game invalid: ${names[by]} cheated (${reason})`;
    }
  }

  const final = res.cards ? unrevealed.length === 0 : true;
  const out: GameOutcome = { state, message, roles, votes, final, unrevealed, cheaters: dedupeCheaters(cheaters) };
  if (assassinated !== undefined) out.assassinated = assassinated;
  if (canceledBy !== undefined) out.canceledBy = canceledBy;
  if (stalled !== undefined) out.stalled = stalled;
  return out;
}

function dedupeCheaters(cs: { name: string; reason: string }[]): { name: string; reason: string }[] {
  const seenKeys = new Set<string>();
  return cs.filter((c) => {
    const k = c.name + '\u0000' + c.reason;
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });
}

/** §3.7 rule 5a: a withheld decisive tally (from the opened ballots) or a decided fifth rejection. */
function restoreWithheld(config: GameConfig, ev: GameEval, msgs: ReadonlyMap<Hex32, StoredMsg>, res: Resolution,
                         atStep: string, stalledNames: string[]): { state: 'GOOD_WIN' | 'EVIL_WIN'; message: string } | null {
  const s = ev.state;
  const suffix = (what: string): string => (stalledNames.length > 0 ? ` (${joinNames(stalledNames)} withheld the ${what})` : '');
  const mt = /^mt\/(\d+)$/.exec(atStep);
  if (mt !== null) {
    const m = Number(mt[1]);
    const cur = s.cursor;
    if (cur.t !== 'mt' || cur.m !== m) return null;
    const ms = s.missions[m];
    if (ms.team === null) return null;
    const vm = res.votes[m];
    if (vm === undefined || ms.team.some((seat) => !vm.has(seat))) return null;
    let k = 0;
    for (const seat of ms.team) k += vm.get(seat) ?? 0;
    const failed = k >= ms.failsRequired;
    const fails = s.failed + (failed ? 1 : 0);
    const succ = s.succeeded + (failed ? 0 : 1);
    if (fails === 3) return { state: 'EVIL_WIN', message: 'Three failed missions' + suffix('tally') };
    if (succ === 3 && !s.merlin) return { state: 'GOOD_WIN', message: 'Three missions succeeded' + suffix('tally') };
    return null;
  }
  const vr = /^vr\/(\d+)\/4$/.exec(atStep);
  if (vr !== null) {
    const cur = s.cursor;
    if (cur.t !== 'vr' || cur.m !== Number(vr[1]) || cur.p !== 4) return null;
    const reveals = pendingVoteReveals(config, ev, msgs);
    if (reveals === null) return null;
    let rejections = 0;
    for (const a of reveals.values()) if (!a) rejections++;
    const n = s.n;
    if (rejections >= n - (n >> 1)) return { state: 'EVIL_WIN', message: 'Five team proposals in a row rejected' + suffix('vote') };
  }
  return null;
}
