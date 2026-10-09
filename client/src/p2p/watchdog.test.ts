/** Watchdog (docs/p2p-protocol.md §7.2, §7.4) with a fake clock and a fake connection. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Listeners } from './env.ts';
import { FakeEvents, FakeTimers } from './testkit.ts';
import { Watchdog, type WatchdogTarget } from './watchdog.ts';

class FakeTarget implements WatchdogTarget {
  up = true;
  attempts: number[] = [];
  readonly hi = new Listeners<void>();
  readonly bye = new Listeners<void>();
  constructor(private readonly timers: FakeTimers) {}
  connected(): boolean {
    return this.up;
  }
  onHi(cb: () => void): () => void {
    return this.hi.add(cb);
  }
  onBye(cb: () => void): () => void {
    return this.bye.add(cb);
  }
  reconnect(): void {
    this.attempts.push(this.timers.now());
  }
  drop(): void {
    this.up = false;
    this.bye.emit();
  }
  restore(): void {
    this.up = true;
    this.hi.emit();
  }
}

function setup(o: { boot?: () => string } = {}) {
  const timers = new FakeTimers();
  const target = new FakeTarget(timers);
  const win = new FakeEvents();
  const doc = new FakeEvents();
  const calls = { hi: 0, boot: 0, clock: 0 };
  let boot = 'boot-1';
  const wd = new Watchdog({
    target, timers, window: win, document: doc, random: () => 0.5,
    relayInfo: async () => ({ bootId: o.boot?.() ?? boot, now: 1000, rtt: 10 }),
    onClock: () => {
      calls.clock++;
    },
    onHi: () => {
      calls.hi++;
    },
    onNewBoot: () => {
      calls.boot++;
    },
  });
  return { timers, target, win, doc, calls, wd, setBoot: (b: string) => { boot = b; } };
}

describe('Watchdog', () => {
  it('republishes and syncs the clock at start and on every hi', async () => {
    const { timers, target, calls, wd } = setup();
    wd.start();
    await timers.advance(1);
    assert.equal(calls.hi, 1);
    assert.equal(calls.clock, 1);
    target.drop();
    target.restore();
    await timers.advance(1);
    assert.equal(calls.hi, 2);
    assert.equal(calls.clock, 2);
    // clock resync every 10 minutes
    await timers.advance(10 * 60 * 1000);
    assert.equal(calls.clock, 3);
    wd.stop();
  });

  it('reconnects after 2 s down with backoff 1, 2, 4, 8, then every 15 s, forever', async () => {
    const { timers, target, wd } = setup();
    wd.start();
    await timers.advance(100);
    const t0 = timers.now();
    target.drop();
    await timers.advance(120000);
    const rel = target.attempts.map((t) => t - t0);
    // first attempt once 2 s passed (checked every 500 ms)
    assert.ok(rel[0] >= 2000 && rel[0] <= 2500, 'first attempt ' + rel[0]);
    const gaps = rel.slice(1).map((t, i) => t - rel[i]);
    const expect = [1000, 2000, 4000, 8000, 15000, 15000, 15000];
    expect.forEach((g, i) => assert.ok(gaps[i] >= g && gaps[i] <= g + 500, `gap ${i}: ${gaps[i]} vs ${g}`));
    assert.ok(target.attempts.length >= 10);
    // once up again, no more attempts; a later outage starts from 1 s again
    target.restore();
    const n = target.attempts.length;
    await timers.advance(60000);
    assert.equal(target.attempts.length, n);
    assert.equal(wd.downSince, null);
    wd.stop();
  });

  it('online, pageshow and visibilitychange to visible reconnect at once', async () => {
    const { timers, target, win, doc, wd } = setup();
    wd.start();
    target.drop();
    await timers.advance(600);
    assert.equal(target.attempts.length, 0);
    win.dispatch('online');
    assert.equal(target.attempts.length, 1);
    win.dispatch('pageshow');
    assert.equal(target.attempts.length, 2);
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    assert.equal(target.attempts.length, 2);
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    assert.equal(target.attempts.length, 3);
    wd.stop();
    assert.equal(win.count('online'), 0);
    assert.equal(doc.count('visibilitychange'), 0);
  });

  it('a new bootId triggers a full republish after a random 0-5 s delay', async () => {
    const { timers, target, calls, wd, setBoot } = setup();
    wd.start();
    await timers.advance(10);
    assert.equal(wd.lastBootId, 'boot-1');
    assert.equal(calls.boot, 0);
    target.drop();
    setBoot('boot-2');
    target.restore();
    await timers.advance(10);
    assert.equal(wd.lastBootId, 'boot-2');
    assert.equal(calls.boot, 0, 'delayed');
    await timers.advance(2500);
    assert.equal(calls.boot, 1);
    // same boot again: nothing
    target.drop();
    target.restore();
    await timers.advance(6000);
    assert.equal(calls.boot, 1);
    wd.stop();
  });
});
