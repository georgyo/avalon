/** Store (docs/p2p-protocol.md §3.9) over the in-memory KV; identity (§3.3). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEnvelope, encodeEnvelope, type Envelope, type HistoryEntry } from '@avalon/common/protocol';
import { loadIdentity, loadOrCreateIdentity, newPair, resetIdentity } from './identity.ts';
import { createStore, MemoryKV, type GameRecord } from './store.ts';

const H = (c: string): string => c.repeat(64);

describe('store', () => {
  it('journal: get/put, atomic putIfAbsent, all(scope) in slot order and per scope', async () => {
    const st = createStore(new MemoryKV());
    assert.equal(await st.journal.get(H('a'), 'key'), null);
    await st.journal.put(H('a'), 'key', 'v1');
    assert.equal(await st.journal.get(H('a'), 'key'), 'v1');
    // two concurrent writers of one slot: exactly one value wins and both learn it
    const [x, y] = await Promise.all([st.journal.putIfAbsent(H('a'), 'shuf/0', 'X'), st.journal.putIfAbsent(H('a'), 'shuf/0', 'Y')]);
    assert.equal(x, 'X');
    assert.equal(y, 'X');
    await st.journal.put(H('b'), 'key', 'other');
    await st.journal.put(H('a'), 'deal', 'v3');
    assert.deepEqual(await st.journal.all(H('a')), ['v3', 'v1', 'X']);
    assert.deepEqual(await st.journal.all(H('b')), ['other']);
  });

  it('profile, games, transcript by scope, verdicts, history', async () => {
    const st = createStore(new MemoryKV());
    assert.deepEqual(await st.profile.get(), { name: null, lobbyCode: null, lobbyId: null });
    await st.profile.put({ name: 'ALICE', lobbyCode: 'ABCD', lobbyId: H('1') });
    assert.equal((await st.profile.get()).lobbyCode, 'ABCD');
    const rec: GameRecord = {
      gameId: 'AAAAAAAAAAAAAAAAAAAAAA', lobbyId: H('1'), configId: H('2'), seat: 3, seed: 'x'.repeat(43), status: 'active', startedAt: 5,
    };
    assert.deepEqual(await st.games.putIfAbsent(rec), rec);
    assert.deepEqual(await st.games.putIfAbsent({ ...rec, seed: 'y'.repeat(43) }), rec, 'first record wins');
    await st.games.put({ ...rec, status: 'ended', endedAt: 9 });
    assert.equal((await st.games.get(rec.gameId))?.status, 'ended');
    assert.equal((await st.games.all()).length, 1);
    await st.transcript.add(H('3'), { soul: 's', key: H('4'), value: 'AV1.x', scope: 'g1' });
    await st.transcript.add(H('5'), { soul: 's', key: H('6'), value: 'AV1.y', scope: 'g2' });
    await st.transcript.add(H('3'), { soul: 's', key: H('4'), value: 'AV1.changed', scope: 'g1' });
    assert.deepEqual((await st.transcript.forScope('g1')).map((r) => r.value), ['AV1.x']);
    assert.equal((await st.transcript.get(H('5')))?.value, 'AV1.y');
    await st.verdicts.put(H('7'), { ok: true });
    await st.verdicts.put(H('8'), { ok: false, reason: 'bad proof' });
    const vs = await st.verdicts.getMany([H('7'), H('8'), H('9')]);
    assert.deepEqual([...vs], [[H('7'), { ok: true }], [H('8'), { ok: false, reason: 'bad proof' }]]);
    const h: HistoryEntry = {
      gameId: rec.gameId, myName: 'ALICE', startedAt: 1000, endedAt: 61000,
      outcome: { state: 'GOOD_WIN', message: 'm', roles: [], votes: [], final: true, unrevealed: [], cheaters: [] },
    };
    await st.history.put(h);
    assert.deepEqual(await st.history.all(), [h]);
    await st.clearAll();
    assert.equal(await st.games.get(rec.gameId), null);
    assert.deepEqual(await st.history.all(), []);
  });

  it('values are copied in and out (like IndexedDB structured clone)', async () => {
    const st = createStore(new MemoryKV());
    const p = { name: 'A', lobbyCode: null, lobbyId: null };
    await st.profile.put(p);
    p.name = 'B';
    assert.equal((await st.profile.get()).name, 'A');
  });

  it('every storage error is reported (LOST_SECRETS) and rethrown', async () => {
    const kv = new MemoryKV();
    const errors: unknown[] = [];
    const st = createStore(kv, (e) => errors.push(e));
    assert.equal(st.failed, false);
    kv.failWith = new Error('QuotaExceededError');
    await assert.rejects(st.journal.put('s', 'k', 'v'), /Quota/);
    assert.equal(st.failed, true);
    assert.equal(errors.length, 1);
  });
});

describe('identity', () => {
  it('creates a SEA-shaped pair once, signs envelopes the protocol verifies, and resets everything', async () => {
    const st = createStore(new MemoryKV());
    assert.equal(await loadIdentity(st), null);
    const id = await loadOrCreateIdentity(st);
    assert.match(id.pair.pub, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    assert.match(id.pair.epub, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    assert.match(id.pair.priv, /^[A-Za-z0-9_-]{43}$/);
    const again = await loadOrCreateIdentity(st);
    assert.equal(again.pub, id.pub);
    const env: Envelope<'lobby.create'> = {
      v: 1, type: 'lobby.create', lobby: '', game: '', step: '', author: id.pub, prev: '', t: 1, body: { code: 'ABCD', name: 'ALICE', nonce: 'A'.repeat(22) },
    };
    const enc = encodeEnvelope(env, id.signer);
    const dec = decodeEnvelope(enc.value, enc.key);
    assert.ok(!('error' in dec), JSON.stringify(dec));
    assert.equal(dec.msgId, enc.msgId);
    await st.games.put({ gameId: 'g', lobbyId: H('1'), configId: H('2'), seat: 0, seed: 's', status: 'active', startedAt: 1 });
    await resetIdentity(st);
    assert.equal(await loadIdentity(st), null);
    assert.deepEqual(await st.games.all(), []);
  });

  it('pairs are fresh', () => {
    assert.notEqual(newPair().pub, newPair().pub);
  });
});
