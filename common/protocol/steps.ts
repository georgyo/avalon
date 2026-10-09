/**
 * Game steps (docs/p2p-protocol.md §3.5): from each public state the rules give
 * the next step id, its message type, its required author set Req(k) and its
 * kind. Pure; no secrets.
 */
import type { GameMsgType } from './types.ts';
import type { Cursor, PublicState } from './machine.ts';

export type StepKind = 'setup' | 'human' | 'automatic' | 'assassination';

export interface StepDef { id: string; type: GameMsgType; req: number[] | 'assassin'; kind: StepKind }

function allSeats(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** The step a cursor designates (null for the terminal cursor). */
export function stepOf(cursor: Cursor, state: Pick<PublicState, 'n' | 'missions'>): StepDef | null {
  const n = state.n;
  switch (cursor.t) {
    case 'key': return { id: 'key', type: 'key', req: allSeats(n), kind: 'setup' };
    case 'shuf': return { id: `shuf/${cursor.j}`, type: 'shuffle', req: [cursor.j], kind: 'setup' };
    case 'deal': return { id: 'deal', type: 'deal', req: allSeats(n), kind: 'setup' };
    case 'otR': return { id: 'otR', type: 'ot.recv', req: allSeats(n), kind: 'setup' };
    case 'otS': return { id: 'otS', type: 'ot.send', req: allSeats(n), kind: 'setup' };
    case 'p': {
      const proposer = state.missions[cursor.m].proposals[cursor.p].proposer;
      return { id: `p/${cursor.m}/${cursor.p}`, type: 'propose', req: [proposer], kind: 'human' };
    }
    case 'vc': return { id: `vc/${cursor.m}/${cursor.p}`, type: 'vote.commit', req: allSeats(n), kind: 'human' };
    case 'vr': return { id: `vr/${cursor.m}/${cursor.p}`, type: 'vote.reveal', req: allSeats(n), kind: 'automatic' };
    case 'mv': {
      const team = state.missions[cursor.m].team;
      if (team === null) throw new Error(`mv/${cursor.m}: no approved team`);
      return { id: `mv/${cursor.m}`, type: 'ballot', req: [...team], kind: 'human' };
    }
    case 'mt': return { id: `mt/${cursor.m}`, type: 'tally', req: allSeats(n), kind: 'automatic' };
    case 'as': return { id: 'as', type: 'assassinate', req: 'assassin', kind: 'assassination' };
    case 'end': return null;
  }
}

/** The next step of the natural chain from `state`, or null when the state is terminal (§3.5). */
export function nextStep(state: PublicState): StepDef | null {
  return stepOf(state.cursor, state);
}

/** The kind of a step id (for cancels and UI), or null if the id is malformed. */
export function stepKindOf(stepId: string): StepKind | null {
  if (stepId === 'key' || stepId === 'deal' || stepId === 'otR' || stepId === 'otS' || /^shuf\/\d+$/.test(stepId)) return 'setup';
  if (/^(p|vc)\/\d+\/\d+$/.test(stepId) || /^mv\/\d+$/.test(stepId)) return 'human';
  if (/^vr\/\d+\/\d+$/.test(stepId) || /^mt\/\d+$/.test(stepId)) return 'automatic';
  if (stepId === 'as') return 'assassination';
  return null;
}
