/**
 * Projections to the shapes the Vue components already use (docs/p2p-protocol.md
 * §11.3): GameData, RoleDoc and SetupProgress. Pure functions of public data
 * (projectGame, projectProgress) and of this seat's private view (projectRole).
 */
import { ROLES, type Role } from '../avalonlib.ts';
import type { GameEval, MissionState } from './machine.ts';
import type { PrivateView } from './private.ts';
import type { GameConfig, SetupProgress } from './types.ts';
import type { GameData, GameOutcome, Mission, Proposal, RoleDoc } from './views.ts';

function seatNames(config: GameConfig, seats: readonly number[]): string[] {
  return [...seats].sort((a, b) => a - b).map((j) => config.seats[j].name);
}

function missionOf(config: GameConfig, ev: GameEval, ms: MissionState, m: number): Mission {
  const cur = ev.state.cursor;
  const pending = ev.pending;
  const n = config.seats.length;
  const present = (): number[] => {
    if (pending === null || pending.step.req === 'assassin') return [];
    const miss = new Set(pending.step.req.length === 0 ? [] : pending.missing);
    return pending.step.req.filter((j) => !miss.has(j));
  };
  let team: string[] = [];
  if (ms.state !== 'PENDING' && ms.team !== null) team = seatNames(config, ms.team);
  else if (cur.t === 'mv' && cur.m === m && pending !== null && pending.step.type === 'ballot') team = seatNames(config, present());
  else if (cur.t === 'mt' && cur.m === m && ms.team !== null) team = seatNames(config, ms.team);
  const proposals: Proposal[] = ms.proposals.map((pr, p) => {
    let votes: string[] = [];
    if (pr.approvers !== null) votes = seatNames(config, pr.approvers);
    else if (cur.t === 'vc' && cur.m === m && cur.p === p && pending !== null && pending.step.type === 'vote.commit') votes = seatNames(config, present());
    else if (cur.t === 'vr' && cur.m === m && cur.p === p) votes = seatNames(config, Array.from({ length: n }, (_, j) => j));
    return {
      proposer: config.seats[pr.proposer].name,
      team: pr.team === null ? [] : seatNames(config, pr.team),
      votes,
      state: pr.state,
    };
  });
  return { state: ms.state, team, teamSize: ms.teamSize, failsRequired: ms.failsRequired, numFails: ms.numFails ?? 0, proposals };
}

/** GameData of §11.3: INIT with `setup` during setup, ACTIVE with the legacy phases, ENDED with the outcome. */
export function projectGame(config: GameConfig, ev: GameEval, outcome: GameOutcome | null): GameData {
  const s = ev.state;
  const data: GameData = {
    state: 'INIT',
    phase: '',
    players: config.seats.map((x) => x.name),
    roles: s.deck.map((l) => l.role),
    missions: s.missions.map((ms, m) => missionOf(config, ev, ms, m)),
    options: { inGameLog: config.options.inGameLog },
  };
  if (ev.terminal !== null && outcome !== null) {
    data.state = 'ENDED';
    data.phase = s.phase === 'SETUP' ? '' : s.phase;
    data.outcome = outcome;
    return data;
  }
  if (s.phase === 'SETUP') {
    const setup = projectProgress(config, ev);
    if (setup !== null) data.setup = setup;
    return data;
  }
  data.state = 'ACTIVE';
  data.phase = s.phase;
  return data;
}

/** The role sheet of this seat (§11.3): `sees` once the sight exchange is decoded, names in seat order. */
export function projectRole(config: GameConfig, priv: PrivateView | null): RoleDoc | null {
  if (priv === null) return null;
  const r = ROLES.find((x) => x.name === priv.label.role);
  if (r === undefined) return null;
  const role: Role = { ...r, sees: [...r.sees] };
  const doc: RoleDoc = { role, assassin: priv.label.assassin };
  if (priv.sightKnown) doc.sees = priv.seesSeats.map((j) => config.seats[j].name);
  return doc;
}

/** Setup progress (§7.8, §11.2), or null outside setup. */
export function projectProgress(config: GameConfig, ev: GameEval): SetupProgress | null {
  if (ev.terminal !== null || ev.state.phase !== 'SETUP' || ev.pending === null) return null;
  const n = config.seats.length;
  const p = ev.pending;
  const waiting = (): string[] => p.missing.map((j) => config.seats[j].name);
  switch (p.step.type) {
    case 'key': return { stage: 'keys', done: n - p.missing.length, total: n, waitingFor: waiting() };
    case 'shuffle': {
      const j = p.step.req === 'assassin' ? 0 : p.step.req[0];
      return { stage: 'shuffle', done: j, total: n, waitingFor: [config.seats[j].name] };
    }
    case 'deal': return { stage: 'deal', done: n - p.missing.length, total: n, waitingFor: waiting() };
    case 'ot.recv':
    case 'ot.send': return { stage: 'sight', done: n - p.missing.length, total: n, waitingFor: waiting() };
    default: return null;
  }
}
