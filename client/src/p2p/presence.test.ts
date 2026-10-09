/** Presence (docs/p2p-protocol.md §7.6) with a fake clock and a fake user-space transport. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Presence, PRESENCE_KEY, parsePresence, type PresenceTransport, type WakeLockLike, type WakeLockSentinelLike } from './presence.ts';
import { FakeEvents, FakeTimers } from './testkit.ts';

class FakeUserSpace implements PresenceTransport {
  readonly writes: string[] = [];
  private readonly watchers = new Map<string, Set<(v: string) => void>>();
  async putUser(key: string, value: string): Promise<void> {
    assert.equal(key, PRESENCE_KEY);
    this.writes.push(value);
  }
  watchUser(pub: string, _key: string, cb: (v: string) => void): () => void {
    let s = this.watchers.get(pub);
    if (s === undefined) {
      s = new Set();
      this.watchers.set(pub, s);
    }
    s.add(cb);
    const set = s;
    return () => set.delete(cb);
  }
  deliver(pub: string, v: string): void {
    for (const cb of this.watchers.get(pub) ?? []) cb(v);
  }
  watching(pub: string): number {
    return this.watchers.get(pub)?.size ?? 0;
  }
}

class FakeWakeLock implements WakeLockLike {
  held = 0;
  requests = 0;
  async request(): Promise<WakeLockSentinelLike> {
    this.requests++;
    this.held++;
    let released = false;
    return {
      get released() {
        return released;
      },
      release: async () => {
        released = true;
        this.held--;
      },
    };
  }
}

describe('Presence', () => {
  it('heartbeats every 10 s and on visibility changes with increasing seq and nothing role-dependent', async () => {
    const timers = new FakeTimers();
    const doc = new FakeEvents();
    const t = new FakeUserSpace();
    const p = new Presence({ transport: t, timers, document: doc, wakeLock: null, seqStart: 100 });
    p.setState({ lobby: 'L'.repeat(64), game: 'G', head: '0123456789abcdef' });
    p.start();
    await timers.advance(1);
    await timers.advance(10000);
    await timers.advance(10000);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    await timers.advance(1);
    const vals = t.writes.map((w) => parsePresence(w));
    assert.equal(vals.length, 4);
    assert.deepEqual(vals.map((v) => v?.seq), [100, 101, 102, 103]);
    assert.deepEqual(vals.map((v) => v?.vis), [1, 1, 1, 0]);
    assert.deepEqual(Object.keys(vals[0] ?? {}).sort(), ['game', 'head', 'lobby', 'seq', 'vis']);
    assert.equal(vals[0]?.head, '01234567');
    assert.equal(t.writes[0], '{"game":"G","head":"01234567","lobby":"' + 'L'.repeat(64) + '","seq":100,"vis":1}');
    p.stop();
  });

  it('a member is online while a new seq arrived within 30 s of local receipt', async () => {
    const timers = new FakeTimers();
    const t = new FakeUserSpace();
    const p = new Presence({ transport: t, timers, document: null, wakeLock: null });
    const changes: string[] = [];
    p.onChange((pub) => changes.push(pub));
    p.watch(['A', 'B']);
    assert.equal(p.isOnline('A'), false);
    const hb = (seq: number): string => JSON.stringify({ game: '', head: '', lobby: 'x', seq, vis: 1 });
    t.deliver('A', hb(1));
    assert.equal(p.isOnline('A'), true);
    await timers.advance(29000);
    assert.equal(p.isOnline('A'), true);
    t.deliver('A', hb(1)); // same seq: not new
    await timers.advance(2000);
    assert.equal(p.isOnline('A'), false);
    t.deliver('A', hb(2));
    assert.equal(p.isOnline('A'), true);
    assert.equal(p.info('A').value?.lobby, 'x');
    t.deliver('B', 'garbage');
    assert.equal(p.isOnline('B'), false);
    assert.deepEqual(changes, ['A', 'A']);
    p.watch(['B']);
    assert.equal(t.watching('A'), 0);
    assert.equal(p.isOnline('A'), false);
  });

  it('holds a screen wake lock while wanted, re-acquired when the page becomes visible', async () => {
    const timers = new FakeTimers();
    const doc = new FakeEvents();
    const wl = new FakeWakeLock();
    const p = new Presence({ transport: new FakeUserSpace(), timers, document: doc, wakeLock: wl });
    p.start();
    p.setWakeLock(true);
    await timers.advance(1);
    assert.equal(wl.held, 1);
    // the browser releases it when hidden
    doc.visibilityState = 'hidden';
    const s = wl.held;
    wl.held = 0;
    doc.dispatch('visibilitychange');
    await timers.advance(1);
    assert.equal(wl.held, 0);
    assert.equal(s, 1);
    // force the sentinel to look released, as browsers do on hide
    (p as unknown as { sentinel: WakeLockSentinelLike | null }).sentinel = { released: true, release: async () => undefined };
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    await timers.advance(1);
    assert.equal(wl.held, 1);
    p.setWakeLock(false);
    await timers.advance(1);
    assert.equal(wl.held, 0);
    p.stop();
  });
});
