/**
 * Regression tests for the second review round (docs/p2p-protocol.md §3.4,
 * §3.7, §4.6, §5.12): mass equivocation keeps the forfeit and every reveal
 * valid; a reveal citing a made-up msgId cannot veto the assassination; votes
 * cast before a cancel during MISSION_VOTE are decoded; non-seat junk is
 * dropped before the signature check; a second game in an unchanged lobby
 * always becomes current.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex32 } from '../crypto/types.ts';
import { localCrypto, SeatDriver } from './driver.ts';
import { decodeEnvelope, encodeEnvelope, lobbySoul, soulOf } from './envelope.ts';
import { runProve } from './jobs.ts';
import { LobbyDriver } from './lobbyDriver.ts';
import { FakeRelay, MemJournal as LobbyJournal, testSigner } from './lobbyTestkit.ts';
import { computeOutcome } from './outcome.ts';
import type { GameEval } from './machine.ts';
import type { BuildCtx } from './build.ts';
import type { Journal, StoredMsg, Transport } from './types.ts';
import { MemJournal, SIM_LOBBY_CODE } from '../testing/simulate.ts';
import { dealOf, randomHex, seatWith } from '../testing/cheatkit.ts';
import {
  before, cancelMsg, digestBefore, evalFull, gameMsg, positionOf, recordGame, revealMsg, stepMsgs, withMsgs, type Recorded,
} from '../testing/transcript.ts';

const OPTS = { n: 5, roles: ['MERLIN', 'ASSASSIN'], seed: 7, strategy: 'good-wins' as const };
let memo: Promise<Recorded> | null = null;
function rec(): Promise<Recorded> {
  memo ??= recordGame(OPTS);
  return memo;
}

const silent: Transport = { publish: async () => undefined, subscribe: () => () => undefined };

function seatOf(R: Recorded, m: StoredMsg): number {
  return R.t.config.seats.findIndex((s) => s.pub === m.env.author);
}

function driverFor(R: Recorded, seat: number, journal: Journal): SeatDriver {
  return new SeatDriver({
    config: R.t.config, configId: R.t.configId, lobbyId: R.t.lobbyId, lobbyCode: SIM_LOBBY_CODE, seat, signer: R.t.signers[seat],
    secrets: R.t.secrets[seat], transport: silent, journal, crypto: localCrypto(),
    now: () => 1, onView: () => undefined, configAuthor: R.t.signers[0].pub,
  });
}

function feed(d: SeatDriver, msgs: Iterable<StoredMsg>): void {
  for (const m of msgs) d.ingest(soulOf(m.env, SIM_LOBBY_CODE), m.key, m.value);
}

async function journalOwn(R: Recorded, seat: number, msgs: Iterable<StoredMsg>): Promise<MemJournal> {
  const j = new MemJournal();
  for (const m of msgs) if (seatOf(R, m) === seat) await j.put(R.t.configId, m.env.step, m.value);
  return j;
}

test('mass equivocation: the evidence is bounded, every honest seat reveals, the cheater\'s team forfeits', async () => {
  const R = await rec();
  const labels = dealOf(OPTS);
  const evil = seatWith(labels, (l) => l.assassin);
  const prior = before(R, 'vc/0/0');
  const D = digestBefore(R.ev, R.t.configId, positionOf(R.ev, 'vc/0/0'));
  const flood: StoredMsg[] = [];
  for (let i = 0; i < 300; i++) flood.push(gameMsg(R.t, evil, 'vote.commit', 'vc/0/0', D, { commit: randomHex('flood/' + i) }));
  const all = withMsgs(prior, ...flood);
  const ev = evalFull(R.t.config, R.t.configId, all);
  assert.equal(ev.terminal?.kind, 'invalid');
  assert.deepEqual(ev.terminal?.faults.map((f) => [f.seat, f.reason]), [[evil, 'equivocation']]);
  assert.ok((ev.terminal?.basis.length ?? 0) <= 2 * R.t.config.seats.length, `basis of ${ev.terminal?.basis.length}`);
  // Every seat's driver reveals (the basis fits the reveal schema), and the outcome is the forfeit.
  const reveals: StoredMsg[] = [];
  for (let j = 0; j < R.t.config.seats.length; j++) {
    const journal = await journalOwn(R, j, prior.values());
    const d = driverFor(R, j, journal);
    await d.start();
    feed(d, all.values());
    await d.idle();
    const r = await journal.get(R.t.configId, 'reveal');
    assert.ok(r !== null, `seat ${j} revealed`);
    const dec = decodeEnvelope(r);
    assert.ok(!('error' in dec));
    if (!('error' in dec)) reveals.push(dec);
    d.stop();
  }
  const final = withMsgs(all, ...reveals);
  const out = computeOutcome(R.t.config, evalFull(R.t.config, R.t.configId, final), final);
  assert.equal(out?.state, 'GOOD_WIN');
  assert.match(out?.message ?? '', /cheated \(equivocation\); evil forfeits/);
  assert.equal(out?.roles.length, R.t.config.seats.length, 'roles disclosed');
});

test('a reveal citing a made-up msgId cannot veto the assassination', async () => {
  const R = await rec();
  const labels = dealOf(OPTS);
  const assassin = seatWith(labels, (l) => l.assassin);
  const merlin = seatWith(labels, (l) => l.role === 'MERLIN');
  const prior = before(R, 'as');
  const evPrior = evalFull(R.t.config, R.t.configId, prior);
  assert.equal(evPrior.pending?.step.id, 'as');
  const bogus = revealMsg(R.t, merlin, ['ff'.repeat(32)], evPrior.head);
  const d = driverFor(R, assassin, await journalOwn(R, assassin, prior.values()));
  await d.start();
  feed(d, [...prior.values(), bogus]);
  await d.idle();
  assert.equal(d.evaluation?.pendingReveals.length, 1, 'the reveal is pending (its basis is unknown)');
  assert.equal(d.evaluation?.terminal, null);
  await d.assassinate(merlin);
  await d.idle();
  const ev = d.evaluation as GameEval;
  assert.equal(ev.terminal?.kind, 'natural');
  assert.equal(ev.terminal?.atStep, 'as');
  // The builder agrees: a pending reveal does not suspend the assassination, but still suspends other steps.
  const ctx: BuildCtx = {
    config: R.t.config, configId: R.t.configId, lobbyId: R.t.lobbyId, seat: assassin, me: R.t.signers[assassin].pub,
    ev: { ...evPrior, jobs: [], pendingReveals: [bogus.msgId] }, secrets: R.t.secrets[assassin], priv: d.privateView, now: 1,
  };
  assert.doesNotThrow(() => runProve({ kind: 'build', fn: 'assassinate', ctx, target: merlin }));
  d.stop();
});

test('ballots cast before a cancel during MISSION_VOTE are decoded from the reveals', async () => {
  const R = await rec();
  const k = positionOf(R.ev, 'mv/0');
  const ballots = stepMsgs(R, 'mv/0');
  const voters = [...ballots.keys()].sort((a, b) => a - b);
  assert.ok(voters.length >= 2);
  const cast = voters.slice(0, -1);          // the last team member never voted
  const absent = voters[voters.length - 1];
  const evMid = evalFull(R.t.config, R.t.configId, before(R, 'mv/0'));
  const canceller = R.t.config.seats.findIndex((_, j) => !voters.includes(j));
  const cancel = cancelMsg(R.t, evMid, canceller, 'mv/0');
  let msgs = withMsgs(before(R, 'mv/0'), ...cast.map((j) => ballots.get(j) as StoredMsg), cancel);
  const ev = evalFull(R.t.config, R.t.configId, msgs);
  assert.equal(ev.terminal?.kind, 'canceled');
  msgs = withMsgs(msgs, ...R.t.config.seats.map((_, j) => revealMsg(R.t, j, [cancel.msgId], ev.head)));
  const out = computeOutcome(R.t.config, evalFull(R.t.config, R.t.configId, msgs), msgs);
  assert.equal(out?.state, 'CANCELED');
  // The true votes, from the full game.
  const full = computeOutcome(R.t.config, R.ev, R.msgs);
  const names = R.t.config.seats.map((s) => s.name);
  for (const j of cast) assert.equal(out?.votes[0]?.[names[j]], full?.votes[0]?.[names[j]], `vote of ${names[j]}`);
  assert.equal(out?.votes[0]?.[names[absent]], undefined, 'no vote for the seat that did not vote');
  assert.equal(k, positionOf(R.ev, 'mv/0'));
});

test('game messages by non-seats are dropped before the signature check and never kept', async () => {
  const R = await rec();
  const outsider = testSigner(999);
  // A key message of the game, signed by an outsider (valid signature, wrong author).
  const keyMsg = [...R.msgs.values()].find((m) => m.env.type === 'key') as StoredMsg;
  const forged = encodeEnvelope({ ...keyMsg.env, author: outsider.pub }, outsider);
  let verified = 0;
  const d = decodeEnvelope(forged.value, forged.key, (e) => {
    verified++;
    return R.t.config.seats.some((s) => s.pub === e.author);
  });
  assert.deepEqual(d, { error: 'not admitted' });
  assert.equal(verified, 1);
  // A bad signature by a non-seat is refused as "not admitted" (no ECDSA work spent on it).
  const broken = forged.value.slice(0, -4) + 'AAAA';
  assert.deepEqual(decodeEnvelope(broken, undefined, () => false), { error: 'not admitted' });
  const drv = driverFor(R, 1, new MemJournal());
  await drv.start();
  assert.equal(drv.ingest(soulOf(keyMsg.env, SIM_LOBBY_CODE), forged.key, forged.value), false);
  assert.equal(drv.messages().some((m) => m.env.author === outsider.pub), false);
  drv.stop();
});

test('a second game in an unchanged lobby always becomes the current config', async () => {
  const relay = new FakeRelay();
  const signers = [0, 1, 2, 3, 4].map((i) => testSigner(700 + i));
  const names = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN'];
  let now = 1;
  const drivers = signers.map((signer) => new LobbyDriver({
    code: 'WXYZ', lobbyId: null, signer, transport: relay.peer(), journal: new LobbyJournal(), onState: () => undefined,
    now: () => now++, openAdmission: true,
  }));
  drivers[0].start();
  const lobbyId = await drivers[0].create(names[0]);
  const joined = drivers.slice(1).map((_, i) => new LobbyDriver({
    code: 'WXYZ', lobbyId, signer: signers[i + 1], transport: relay.peer(), journal: new LobbyJournal(), onState: () => undefined,
    now: () => now++, openAdmission: true,
  }));
  for (const [i, d] of joined.entries()) {
    d.start();
    await d.join(names[i + 1]);
  }
  const admin = drivers[0];
  const seats = signers.map((s, i) => ({ pub: s.pub, name: names[i] }));
  const seen = new Set<Hex32>();
  for (let g = 0; g < 8; g++) {
    const id = await admin.startGame(seats, ['MERLIN', 'ASSASSIN'], { inGameLog: false });
    assert.ok(!seen.has(id));
    seen.add(id);
    assert.equal(admin.state?.currentConfig?.configId, id, `game ${g + 1} is current on the admin`);
    // Every member converges on it.
    for (let w = 0; w < 200 && !joined.every((d) => d.state?.currentConfig?.configId === id); w++) await new Promise((r) => setTimeout(r, 2));
    for (const d of joined) assert.equal(d.state?.currentConfig?.configId, id, `game ${g + 1} is current on every member`);
    admin.setGameActive(false);   // the game ended
  }
  assert.ok(relay.values(lobbySoul('WXYZ')).length > 0);
  for (const d of [admin, ...joined]) d.stop();
});
