/**
 * Assertions shared by the simulation tests (docs/p2p-protocol.md §12).
 */
import assert from 'node:assert/strict';
import { seen, teamOf } from '../protocol/rules.ts';
import { msgMap, outcomeOf } from './transcript.ts';
import type { SimResult } from './simulate.ts';
import type { GameOutcome } from '../protocol/views.ts';

/** Every listed seat sees the same outcome (the non-listed ones are adversaries or gone). */
export function assertAgreement(r: SimResult, seats?: number[]): GameOutcome {
  const list = seats ?? r.seats.map((s) => s.seat);
  const first = r.seats[list[0]].outcome;
  assert.ok(first !== null, `seat ${list[0]} has no outcome (pending ${r.seats[list[0]].ev?.pending?.step.id})`);
  for (const j of list) assert.deepEqual(r.seats[j].outcome, first, `seat ${j} disagrees`);
  return first;
}

/** The outcome recomputed from the relay's transcript alone equals the seats' outcome (order independence). */
export function assertTranscriptOutcome(r: SimResult, expected: GameOutcome): void {
  const msgs = msgMap(r.transcript, r.config.gameId);
  const { outcome } = outcomeOf(r.config, r.configId, msgs, { configAuthor: r.signers[0].pub });
  assert.deepEqual(outcome, expected);
}

/** An honest, complete game: roles equal the deal, sight lists follow the name-only rule, votes are consistent. */
export function assertHonestGame(r: SimResult): GameOutcome {
  assert.deepEqual(r.errors, []);
  const out = assertAgreement(r);
  assert.equal(out.final, true, 'outcome not final: ' + JSON.stringify(out));
  assert.deepEqual(out.unrevealed, []);
  assert.deepEqual(out.cheaters, []);
  const names = r.config.seats.map((s) => s.name);
  assert.deepEqual(out.roles.map((x) => x.name), names);
  out.roles.forEach((x, j) => {
    const l = r.labels[j];
    assert.ok(l !== null);
    assert.equal(x.role, l.role);
    assert.equal(x.assassin, l.assassin);
  });
  // Sight (§5.1): names of the other seats whose role name the viewer's role sees, in seat order.
  r.seats.forEach((s, j) => {
    const l = r.labels[j];
    assert.ok(l !== null);
    const expected = names.filter((_, k) => k !== j && seen(l.role, (r.labels[k] as { role: string }).role));
    assert.deepEqual(s.view?.role?.sees, expected, `sees of seat ${j}`);
    assert.equal(s.view?.role?.role.name, l.role);
    assert.equal(s.view?.role?.assassin, l.assassin);
  });
  // Votes: good players never fail; fail counts match the tallies.
  const ev = r.ev;
  assert.ok(ev !== null);
  out.votes.forEach((vm, m) => {
    const ms = ev.state.missions[m];
    let fails = 0;
    for (const [name, success] of Object.entries(vm)) {
      const j = names.indexOf(name);
      if (!success) {
        fails++;
        assert.equal(teamOf(out.roles[j].role), 'evil', `${name} (good) failed`);
      }
    }
    if (ms.numFails !== null) assert.equal(fails, ms.numFails);
  });
  // Every seat revealed and logged (GOOD_WIN / EVIL_WIN).
  for (const s of r.seats) {
    assert.ok(s.published.has('reveal'), `seat ${s.seat} did not reveal`);
    if (out.state !== 'CANCELED') assert.ok(s.published.has('log'), `seat ${s.seat} did not log`);
  }
  assertTranscriptOutcome(r, out);
  return out;
}
