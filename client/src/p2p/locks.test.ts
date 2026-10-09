/**
 * Single writer (docs/p2p-protocol.md §3.9): the Web Locks semantics (faked in
 * node) and two P2PSessions on one store contending for the driver lock.
 */
import { TestRelay } from './relayHarness.ts';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { silenceGunLog } from './gun.ts';
import { acquireDriverLock, MemoryLockManager } from './locks.ts';
import { P2PSession } from './session.ts';
import { MemoryKV } from './store.ts';

silenceGunLog();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(20);
  }
}

describe('driver lock', () => {
  it('ifAvailable, steal (AbortError for the holder), queueing and hand-back', async () => {
    const locks = new MemoryLockManager();
    const a = await acquireDriverLock({ locks });
    const b = await acquireDriverLock({ locks });
    assert.equal(a.held, true);
    assert.equal(b.held, false);
    const changes: string[] = [];
    a.onChange((h) => changes.push('a' + (h ? '+' : '-')));
    b.onChange((h) => changes.push('b' + (h ? '+' : '-')));
    await b.steal();
    await sleep(1);
    assert.equal(b.held, true);
    assert.equal(a.held, false);
    // a waits in line and gets the lock back when b goes away
    b.release();
    await until(() => a.held, 1000, 'hand-back');
    assert.deepEqual(changes, ['b+', 'a-', 'b-', 'a+']);
    a.release();
    await sleep(1);
    assert.equal(locks.holderOf('avalon-driver'), null);
  });

  it('without the Web Locks API the tab is the writer', async () => {
    const s = await acquireDriverLock({ locks: null });
    assert.equal(s.held, true);
  });
});

describe('two P2PSessions on one store', () => {
  let relay: TestRelay;
  const sessions: P2PSession[] = [];

  before(async () => {
    relay = await TestRelay.start();
  });
  after(async () => {
    for (const s of sessions) s.close();
    await relay.close();
  });

  it('only the lock holder acts; Use here moves the writer; closing hands it back', async () => {
    const kv = new MemoryKV();
    const locks = new MemoryLockManager();
    const open = async (): Promise<P2PSession> => {
      const s = await P2PSession.open({
        relayUrl: relay.url, kv, locks, window: null, document: null, wakeLock: null, gunClock: false, probeMs: 300,
      });
      sessions.push(s);
      return s;
    };
    const first = await open();
    await first.createIdentity();
    const { lobby: code } = await first.createLobby('ALICE');
    await until(() => first.status.kind === 'LOBBY', 5000, 'first in lobby');

    const second = await open();
    assert.equal(second.status.kind, 'READ_ONLY_OTHER_TAB');
    await assert.rejects(second.createIdentity(), /another tab/);
    await assert.rejects(second.leaveLobby(), /another tab/);

    const lobbies: (string | null)[] = [];
    second.onLobby((l) => lobbies.push(l === null ? null : l.name));
    await second.useHere();
    assert.notEqual(second.status.kind, 'READ_ONLY_OTHER_TAB');
    await until(() => first.status.kind === 'READ_ONLY_OTHER_TAB', 2000, 'first drops to read-only');
    // the same identity and lobby, loaded from the shared store
    assert.equal(second.profile?.uid, first.profile?.uid);
    assert.equal(second.profile?.lobby, code);
    await until(() => lobbies.includes(code), 10000, 'second shows the lobby');
    await assert.rejects(first.takeOverAdmin(), /another tab/);
    await assert.rejects(first.kickPlayer('BOB'), /another tab/);

    // the read-only tab never published: the admin roster is still the only one
    second.close();
    await until(() => first.status.kind !== 'READ_ONLY_OTHER_TAB', 5000, 'first takes the lock back');
    await until(() => first.lobbyStateSnapshot !== null, 10000, 'first reloads the lobby');
    assert.equal(first.lobbyStateSnapshot?.head.seq, 1);
    assert.equal(first.lobbyStateSnapshot?.head.members[0].name, 'ALICE');
  });
});
