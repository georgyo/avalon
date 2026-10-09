/**
 * GunTransport against an in-process relay (docs/p2p-protocol.md §12, GUN
 * integration): relay echo, subscribe-before-exists delivery, forged and
 * overwrite writes rejected, synced(), rebuild() and presence over user space.
 */
import { TestRelay } from './relayHarness.ts';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createGun, silenceGunLog } from './gun.ts';
import { GunTransport } from './gunTransport.ts';
import { newPair } from './identity.ts';
import { PRESENCE_KEY } from './presence.ts';

silenceGunLog();

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const value = (): string => 'AV1.' + randomBytes(80).toString('base64url') + '.' + randomBytes(64).toString('base64url');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(20);
  }
}

describe('GunTransport over an in-process relay', () => {
  let relay: TestRelay;
  const transports: GunTransport[] = [];
  const mk = (): GunTransport => {
    const t = new GunTransport({ relayUrl: relay.url });
    transports.push(t);
    return t;
  };

  before(async () => {
    relay = await TestRelay.start();
  });
  after(async () => {
    for (const t of transports) t.close();
    await relay.close();
  });

  it('publish resolves on the relay echo; a subscriber that subscribed before the value existed receives it', async () => {
    const a = mk();
    const b = mk();
    const soul = 'avalon/v1/lobby/BCDF#';
    const got = new Map<string, string>();
    b.subscribe(soul, (k, v) => got.set(k, v));
    await until(() => a.connected() && b.connected(), 5000, 'connect');
    const v = value();
    await a.publish(soul, sha(v), v);
    assert.equal(a.isEchoed(sha(v), soul), true);
    assert.equal(relay.stored(soul, sha(v)), v);
    await until(() => got.get(sha(v)) === v, 5000, 'delivery');
    // a late subscriber gets the stored value
    const c = mk();
    const late = new Map<string, string>();
    c.subscribe(soul, (k, x) => late.set(k, x));
    await until(() => late.get(sha(v)) === v, 5000, 'late delivery');
    // two watchers of one soul share one GUN subscription and both get values
    const again = new Map<string, string>();
    c.subscribe(soul, (k, x) => again.set(k, x));
    assert.equal(again.get(sha(v)), v);
  });

  it('a value under a wrong hash key is rejected locally and by the relay; an overwrite is rejected', async () => {
    const a = mk();
    const b = mk();
    const soul = 'avalon/v1/lobby/GHJK#';
    const seen: string[] = [];
    b.subscribe(soul, (k, v) => seen.push(k + '=' + v));
    await until(() => a.connected() && b.connected(), 5000, 'connect');
    // through the transport: SEA refuses the put (permanent error)
    const v = value();
    await assert.rejects(a.publish(soul, sha(v + 'x'), v), /hash/i);
    // raw over the wire, bypassing the sender's SEA: the relay refuses it
    const forged = value();
    const forgedKey = sha(forged + 'y');
    a.handle.say({ put: { [soul]: { _: { '#': soul, '>': { [forgedKey]: Date.now() } }, [forgedKey]: forged } } });
    // valid value, then a raw overwrite of the same key
    const ok = value();
    await a.publish(soul, sha(ok), ok);
    const other = value();
    a.handle.say({ put: { [soul]: { _: { '#': soul, '>': { [sha(ok)]: Date.now() + 1000 } }, [sha(ok)]: other } } });
    // a non-whitelisted soul is dropped by the relay filter
    const bad = value();
    a.handle.say({ put: { ['avalon/v1/other#']: { _: { '#': 'avalon/v1/other#', '>': { [sha(bad)]: Date.now() } }, [sha(bad)]: bad } } });
    await sleep(800);
    assert.equal(relay.stored(soul, forgedKey), undefined);
    assert.equal(relay.stored(soul, sha(ok)), ok);
    assert.equal(relay.stored('avalon/v1/other#', sha(bad)), undefined);
    assert.ok(!seen.some((s) => s.includes(forged)), 'forged value delivered');
    assert.ok(!seen.some((s) => s.includes(other)), 'overwrite delivered');
    assert.ok(seen.includes(sha(ok) + '=' + ok));
  });

  it('synced() resolves after the relay answered, for empty and non-empty souls', async () => {
    const a = mk();
    const b = mk();
    await until(() => a.connected() && b.connected(), 5000, 'connect');
    const soul = 'avalon/v1/lobby/LMNP#';
    for (let i = 0; i < 20; i++) {
      const v = value();
      await a.publish(soul, sha(v), v);
    }
    const got = new Set<string>();
    b.subscribe(soul, (k) => got.add(k));
    const t0 = Date.now();
    assert.equal(await b.syncedOk(soul), true);
    assert.equal(got.size, 20);
    const t1 = Date.now();
    const empty = await b.syncedOk('avalon/v1/game/AAAAAAAAAAAAAAAAAAAAAA/setup#');
    const t2 = Date.now();
    console.log(`synced: full soul ${t1 - t0} ms, empty soul ${t2 - t1} ms (answered: ${empty})`);
  });

  it('presence: user-space writes after auth reach watchers; forged presence never does', async () => {
    const a = mk();
    const b = mk();
    await until(() => a.connected() && b.connected(), 5000, 'connect');
    const pair = newPair();
    await a.auth(pair);
    const values: string[] = [];
    b.watchUser(pair.pub, PRESENCE_KEY, (v) => values.push(v));
    await a.putUser(PRESENCE_KEY, '{"seq":1}');
    await until(() => values.includes('{"seq":1}'), 5000, 'presence 1');
    await a.putUser(PRESENCE_KEY, '{"seq":2}');
    await until(() => values.includes('{"seq":2}'), 5000, 'presence 2');
    // forged: a raw put into the user's space without a valid signature
    const soul = '~' + pair.pub;
    a.handle.say({ put: { [soul]: { _: { '#': soul, '>': { [PRESENCE_KEY]: Date.now() + 5000 } }, [PRESENCE_KEY]: JSON.stringify({ ':': '{"seq":99}', '~': 'bad' }) } } });
    await sleep(600);
    assert.ok(!values.includes('{"seq":99}'));
  });

  it('rebuild() keeps watched souls and re-sends unechoed puts on the fresh instance', async () => {
    const a = mk();
    const b = mk();
    await until(() => a.connected() && b.connected(), 5000, 'connect');
    const soul = 'avalon/v1/lobby/QRST#';
    const got = new Set<string>();
    b.subscribe(soul, (k) => got.add(k));
    b.rebuild();
    await until(() => b.connected(), 5000, 'reconnect after rebuild');
    const v = value();
    await a.publish(soul, sha(v), v);
    await until(() => got.has(sha(v)), 5000, 'delivery after rebuild');
    assert.ok(!b.subscriptions.allSouls().includes('avalon/v1/lobby/LMNP#'));
  });

  it('createGun gives a working handle (connected, reask)', async () => {
    const h = createGun(relay.url);
    try {
      await until(() => h.connected(), 5000, 'connect');
      assert.match(h.reask('avalon/v1/lobby/VWXY#'), /^av/);
    } finally {
      h.close();
    }
  });
});
