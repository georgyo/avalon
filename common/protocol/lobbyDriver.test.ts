import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex32 } from '../crypto/types.ts';
import { decodeEnvelope, lobbySoul, type Signer } from './envelope.ts';
import { checkConfig, reduceLobby, type LobbyState } from './lobby.ts';
import { LobbyDriver } from './lobbyDriver.ts';
import { FakeRelay, makeMsg, MemJournal, testSigner } from './lobbyTestkit.ts';

const CODE = 'MNPQ';
const NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN', 'FRANK', 'GRACE', 'HEIDI', 'IVAN', 'JUDY', 'KEN', 'LEO'];
const SIGNERS = NAMES.map((_, i) => testSigner(200 + i));

interface Peer { name: string; signer: Signer; driver: LobbyDriver; journal: MemJournal; states: LobbyState[] }

let fakeNow = 1760000000000;

function peer(relay: FakeRelay, i: number, lobbyId: Hex32 | null, journal = new MemJournal(), openAdmission = true): Peer {
  const states: LobbyState[] = [];
  const driver = new LobbyDriver({
    code: CODE, lobbyId, signer: SIGNERS[i], transport: relay.peer(), journal, onState: (s) => states.push(s), now: () => fakeNow++,
    openAdmission,
  });
  driver.start();
  return { name: NAMES[i], signer: SIGNERS[i], driver, journal, states };
}

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const until = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > until) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const names = (s: LobbyState | null): string[] => s?.head.members.map((m) => m.name) ?? [];

test('create, admit, reject (name taken, full), and every peer converges on the same state', async () => {
  const relay = new FakeRelay();
  const alice = peer(relay, 0, null);
  const lobbyId = await alice.driver.create('ALICE');
  assert.deepEqual(names(alice.driver.state), ['ALICE']);
  assert.equal(alice.driver.state?.head.seq, 1);

  const bob = peer(relay, 1, lobbyId);
  assert.equal(bob.driver.state, null);
  await bob.driver.join('BOB');                      // waits for the lobby to arrive first
  assert.deepEqual(names(bob.driver.state), ['ALICE', 'BOB']);

  const carol = peer(relay, 2, lobbyId);
  await waitFor(() => carol.driver.state !== null, 'carol sees the lobby');
  await assert.rejects(carol.driver.join('BOB'), /^Error: Name taken$/);
  await carol.driver.join('CAROL');

  const others = [3, 4, 5, 6, 7, 8, 9].map((i) => peer(relay, i, lobbyId));
  await waitFor(() => others.every((p) => p.driver.state !== null), 'joiners see the lobby');
  await Promise.all(others.map((p) => p.driver.join(p.name)));
  assert.equal(alice.driver.state?.head.members.length, 10);
  const late = peer(relay, 10, lobbyId);
  await waitFor(() => late.driver.state !== null, 'late joiner sees the lobby');
  await assert.rejects(late.driver.join('KEN'), /^Error: Lobby full$/);

  // Every peer reduces the same messages to the same head.
  await waitFor(() => [bob, carol, ...others, late].every((p) => p.driver.state?.head.rosterId === alice.driver.state?.head.rosterId), 'convergence');
  // Candidates for the code.
  assert.deepEqual(late.driver.candidates().map((c) => c.lobbyId), [lobbyId]);
  assert.equal(late.driver.candidates()[0].members.length, 10);
  for (const p of [alice, bob, carol, ...others, late]) p.driver.stop();
});

test('startGame: config accepted by every seat; joins rejected while the game is active; leave deferred', async () => {
  const relay = new FakeRelay();
  const ps: Peer[] = [peer(relay, 0, null)];
  const lobbyId = await ps[0].driver.create('ALICE');
  for (let i = 1; i < 5; i++) {
    const p = peer(relay, i, lobbyId);
    await waitFor(() => p.driver.state !== null, 'state');
    await p.driver.join(p.name);
    ps.push(p);
  }
  const admin = ps[0].driver;
  await assert.rejects(ps[1].driver.startGame([], [], { inGameLog: false }), /Not lobby admin/);
  await assert.rejects(admin.startGame(ps.slice(0, 4).map((p) => ({ pub: p.signer.pub, name: p.name })), ['MERLIN'], { inGameLog: false }), /Bad number of players/);
  const seats = [...ps].reverse().map((p) => ({ pub: p.signer.pub, name: p.name }));
  const configId = await admin.startGame(seats, ['MERLIN', 'PERCIVAL', 'MORGANA'], { inGameLog: true });
  await waitFor(() => ps.every((p) => p.driver.state?.currentConfig?.configId === configId), 'config everywhere');
  for (let i = 0; i < 5; i++) {
    const s = ps[i].driver.state;
    assert.ok(s);
    assert.deepEqual(checkConfig(s, ps[i].signer.pub, { activeGameIds: [] }), { ok: true, seat: 4 - i });
  }
  // A join while the config is pending: rejected-only roster, acceptance unaffected.
  const frank = peer(relay, 5, lobbyId);
  await waitFor(() => frank.driver.state !== null, 'frank sees the lobby');
  await assert.rejects(frank.driver.join('FRANK'), /^Error: Cannot join while game is in progress$/);
  await waitFor(() => ps[1].driver.state?.head.rosterId === admin.state?.head.rosterId, 'bob sees the rejection roster');
  const sBob = ps[1].driver.state;
  assert.ok(sBob);
  assert.equal(checkConfig(sBob, ps[1].signer.pub, { activeGameIds: [] }).ok, true);
  await assert.rejects(admin.kick(ps[2].signer.pub), /Cancel game first/);

  // Carol leaves during the game: she stays in the roster until the game is over.
  await ps[2].driver.leave();
  ps[2].driver.stop();
  await waitFor(() => admin.state?.leaves.has(ps[2].signer.pub) === true, 'admin sees the leave');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(names(admin.state), ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN']);
  admin.setGameActive(false);
  await waitFor(() => names(admin.state).join() === 'ALICE,BOB,DAVE,ERIN', 'carol removed after the game');
  // Now Frank can join, and Carol can come back from the same device.
  await frank.driver.join('FRANK');
  const carol2 = peer(relay, 2, lobbyId, ps[2].journal);
  await waitFor(() => carol2.driver.state !== null, 'carol2 state');
  await carol2.driver.join('CAROL');
  assert.deepEqual(names(admin.state), ['ALICE', 'BOB', 'DAVE', 'ERIN', 'FRANK', 'CAROL']);
  await admin.kick(frank.signer.pub);
  assert.deepEqual(names(admin.state), ['ALICE', 'BOB', 'DAVE', 'ERIN', 'CAROL']);
  await assert.rejects(admin.kick(admin.state?.head.admin ?? ''), /Can't kick yourself/);
  for (const p of [...ps, frank, carol2]) p.driver.stop();
});

test('admin leaving hands off; the last member closes the lobby', async () => {
  const relay = new FakeRelay();
  const alice = peer(relay, 0, null);
  const lobbyId = await alice.driver.create('ALICE');
  const bob = peer(relay, 1, lobbyId);
  const carol = peer(relay, 2, lobbyId);
  await waitFor(() => bob.driver.state !== null && carol.driver.state !== null, 'state');
  await bob.driver.join('BOB');
  await carol.driver.join('CAROL');
  await alice.driver.leave();
  alice.driver.stop();
  await waitFor(() => bob.driver.state?.head.admin === bob.signer.pub, 'bob is admin');
  assert.deepEqual(names(bob.driver.state), ['BOB', 'CAROL']);
  await carol.driver.leave();
  carol.driver.stop();
  await waitFor(() => names(bob.driver.state).join() === 'BOB', 'bob removes carol');
  await bob.driver.leave();
  await waitFor(() => bob.driver.state?.head.closed === true, 'closed');
  assert.deepEqual(bob.driver.candidates(), []);
  const dave = peer(relay, 3, lobbyId);
  await waitFor(() => dave.driver.state !== null, 'dave state');
  await assert.rejects(dave.driver.join('DAVE'), /closed/);
  bob.driver.stop();
  dave.driver.stop();
});

test('takeover and reclaim; journal republish restores lost relay data', async () => {
  const relay = new FakeRelay();
  const aliceJournal = new MemJournal();
  const alice = peer(relay, 0, null, aliceJournal);
  const lobbyId = await alice.driver.create('ALICE');
  const bob = peer(relay, 1, lobbyId);
  await waitFor(() => bob.driver.state !== null, 'state');
  await bob.driver.join('BOB');
  alice.driver.stop();                       // the admin goes away
  await bob.driver.takeOver();
  assert.equal(bob.driver.state?.head.admin, bob.signer.pub);
  // Alice comes back (same journal, fresh driver): she reclaims as the incumbent.
  const alice2 = peer(relay, 0, lobbyId, aliceJournal);
  await waitFor(() => alice2.driver.state?.head.admin === alice2.signer.pub, 'reclaim');
  await waitFor(() => bob.driver.state?.head.admin === alice2.signer.pub, 'bob sees the reclaim');
  assert.deepEqual(names(bob.driver.state), ['ALICE', 'BOB']);
  // A fresh relay (lost disk): Alice's driver republishes her journal on start.
  const relay2 = new FakeRelay();
  const alice3 = peer(relay2, 0, lobbyId, aliceJournal);
  await waitFor(() => relay2.values(lobbySoul(CODE)).length >= 3, 'republish');
  const msgs = relay2.values(lobbySoul(CODE)).map((v) => decodeEnvelope(v)).filter((d) => !('error' in d));
  assert.ok(msgs.some((d) => 'env' in d && d.env.type === 'lobby.create'));
  for (const p of [bob, alice2, alice3]) p.driver.stop();
});

test('ingest drops garbage, wrong souls, other codes and forged messages', async () => {
  const relay = new FakeRelay();
  const alice = peer(relay, 0, null);
  const lobbyId = await alice.driver.create('ALICE');
  const soul = lobbySoul(CODE);
  const good = makeMsg(SIGNERS[1], 'lobby.join', { lobby: lobbyId, t: 1 }, { name: 'BOB' });
  assert.equal(alice.driver.ingest(soul, good.key, good.value), true);
  assert.equal(alice.driver.ingest(soul, good.key, good.value), false, 'duplicate');
  assert.equal(alice.driver.ingest('avalon/v1/lobby/ZZZZ#', good.key, good.value), false, 'other soul');
  assert.equal(alice.driver.ingest(soul, 'ab'.repeat(32), good.value), false, 'wrong key');
  assert.equal(alice.driver.ingest(soul, 'x', 'garbage'), false);
  const otherCode = makeMsg(SIGNERS[1], 'lobby.create', { t: 1 }, { code: 'ZZZZ', name: 'BOB', nonce: 'AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(alice.driver.ingest(soul, otherCode.key, otherCode.value), false, 'create for another code');
  const game = makeMsg(SIGNERS[1], 'vote.commit', { lobby: lobbyId, game: 'AAAAAAAAAAAAAAAAAAAAAA', step: 'vc/0/0', prev: lobbyId }, { commit: lobbyId });
  assert.equal(alice.driver.ingest(soul, game.key, game.value), false, 'game message in a lobby soul');
  // The pending join from the ingested message is admitted by the admin automation.
  await waitFor(() => names(alice.driver.state).includes('BOB'), 'bob admitted');
  const s = reduceLobby(lobbyId, alice.driver.messages());
  assert.deepEqual(names(s), ['ALICE', 'BOB']);
  alice.driver.stop();
});
