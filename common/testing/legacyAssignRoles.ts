/**
 * Verbatim port of the pre-P2P server's `assignRoles` (server/avalon-server.ts before
 * WP-E removed it), with lodash inlined and the CSPRNG replaced by an injectable
 * `rng() ∈ [0, 1)`. It is the golden reference for rules.ts `deriveDeck` and `seen`
 * (docs/p2p-protocol.md §5.1, §12). Test-only: never used by protocol code.
 */
import { ROLES, getNumEvilForGameSize, type Role } from '../avalonlib.ts';

export interface LegacyPlayerRole { role: string; assassin: boolean; sees: string[] }

interface Assignment {
  name: string;
  role: Role & { assassin?: boolean };
  sees?: string[];
}

/** Fisher-Yates exactly like the legacy secureShuffle (`randomInt(i + 1)` ↦ `floor(rng() · (i + 1))`). */
export function legacyShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** lodash _.zip for two arrays (length = the longer one, missing entries undefined). */
function zip<A, B>(a: readonly A[], b: readonly B[]): [A | undefined, B | undefined][] {
  const len = Math.max(a.length, b.length);
  const out: [A | undefined, B | undefined][] = [];
  for (let i = 0; i < len; i++) out.push([a[i], b[i]]);
  return out;
}

/** lodash _.maxBy: the first element with the greatest defined key. */
function maxBy<T>(arr: readonly T[], key: (v: T) => number | undefined): T | undefined {
  let best: T | undefined;
  let bestKey: number | undefined;
  for (const v of arr) {
    const k = key(v);
    if (k !== undefined && (bestKey === undefined || k > bestKey)) {
      best = v;
      bestKey = k;
    }
  }
  return best;
}

export function legacyAssignRoles(playerList: string[], roles: string[], rng: () => number): Record<string, LegacyPlayerRole> {
  const makeTeam = function (teamList: string[], team: 'good' | 'evil'): Assignment[] {
    const teamRoles = ROLES.filter((r) => r.team == team);
    const specialRoles = teamRoles.filter((r) => roles.includes(r.name)).slice(0, teamList.length);
    const fillerRole = teamRoles.find((r) => r.filler);
    if (fillerRole === undefined) throw new Error('no filler role');
    return zip(teamList, specialRoles).map(([name, role]) => {
      if (name === undefined) throw new Error('more special roles than players');
      return { name, role: Object.assign({}, role ?? fillerRole) };
    });
  };

  const shuffled = legacyShuffle(playerList, rng);
  const numEvil = getNumEvilForGameSize(shuffled.length);
  if (numEvil === undefined) throw new Error('invalid number of players');
  const evilPlayers = shuffled.slice(0, numEvil);
  const goodPlayers = shuffled.slice(numEvil);

  const evilAssignments = makeTeam(evilPlayers, 'evil');
  if (roles.includes('MERLIN')) {
    const assassin = maxBy(evilAssignments, (p) => p.role.assassinationPriority);
    if (assassin === undefined) throw new Error('no assassin');
    assassin.role.assassin = true;
  }

  const assignments = evilAssignments.concat(makeTeam(goodPlayers, 'good'));

  assignments.forEach((r) => {
    r.sees = legacyShuffle(
      r.role.sees.flatMap((seenRole) => assignments.filter((r2) => r2.role.name == seenRole && r2.name != r.name).map((r2) => r2.name)),
      rng);
  });

  const out: Record<string, LegacyPlayerRole> = {};
  for (const p of assignments) {
    out[p.name] = { role: p.role.name, assassin: p.role.assassin ? p.role.assassin : false, sees: p.sees ?? [] };
  }
  return out;
}
