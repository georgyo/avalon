/**
 * GunTransport against an in-process relay (docs/p2p-protocol.md §12, GUN
 * integration): relay echo, subscribe-before-exists delivery, forged and
 * overwrite writes rejected, synced(), rebuild() and presence over user space.
 */
import { TestRelay } from './relayHarness.ts';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import Gun from 'gun';
import { createGun, silenceGunLog, type GunAck, type GunHandle, type SeaPair } from './gun.ts';
import { GunTransport } from './gunTransport.ts';
import { isOwnSignedUserValue } from './subscriptions.ts';
import { newPair } from './identity.ts';
import { PRESENCE_KEY } from './presence.ts';

silenceGunLog();

interface SeaApi { sign(data: unknown, pair: SeaPair, cb: undefined, opt: { raw: 1 }): Promise<{ m: unknown; s: string }> }
const sea = (Gun as unknown as { SEA: SeaApi }).SEA;

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** A well-shaped (unsigned) lobby envelope value: the relay checks shapes (§8), clients signatures. */
const value = (): string => 'AV1.' + Buffer.from(JSON.stringify({ v: 1, type: 'lobby.join', pad: randomBytes(40).toString('base64url') })).toString('base64url')
  + '.' + randomBytes(64).toString('base64url');
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
    // through the transport: SEA refuses the put; the error ack is not trusted as final (it could be
    // forged), so the put stays unechoed and keeps retrying with backoff
    const v = value();
    let settled = false;
    void a.publish(soul, sha(v + 'x'), v).then(() => { settled = true; }, () => { settled = true; });
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
    assert.equal(relay.stored(soul, sha(v + 'x')), undefined);
    assert.equal(settled, false);
    assert.equal(a.isEchoed(sha(v + 'x'), soul), false);
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

  it('presence: a value signed by another key and carrying "*" (SEA cert path) is refused by the relay and by watchers', async () => {
    const a = mk();
    const b = mk();
    const c = mk();
    await until(() => a.connected() && b.connected() && c.connected(), 5000, 'connect');
    const victim = newPair();
    const attacker = newPair();
    await a.auth(victim);
    const values: string[] = [];
    b.watchUser(victim.pub, PRESENCE_KEY, (v) => values.push(v));
    await a.putUser(PRESENCE_KEY, '{"seq":1}');
    await until(() => values.includes('{"seq":1}'), 5000, 'presence 1');
    // The attacker signs a put into the victim's space with its own key and names itself in '*'.
    const soul = '~' + victim.pub;
    const state = Date.now() + 2000;
    const data = '{"lobby":"FORGED","seq":999999999}';
    const signed = await sea.sign({ '#': soul, '.': PRESENCE_KEY, ':': data, '>': state }, attacker, undefined, { raw: 1 });
    const raw = JSON.stringify({ ':': data, '~': signed.s, '*': attacker.pub });
    c.handle.say({ put: { [soul]: { _: { '#': soul, '>': { [PRESENCE_KEY]: state } }, [PRESENCE_KEY]: raw } } });
    await sleep(800);
    assert.ok(!values.includes(data), 'forged presence delivered');
    assert.notEqual(relay.stored(soul, PRESENCE_KEY), raw, 'relay stored the forged presence');
    assert.equal(relay.filter?.stats.reasons['presence value is not SEA-signed'] ?? 0, 1);
    // Client side too: a raw value with '*' in the local graph is never reported.
    assert.equal(isOwnSignedUserValue(raw), false);
    assert.equal(isOwnSignedUserValue(JSON.stringify({ ':': data, '~': signed.s })), true);
    assert.equal(isOwnSignedUserValue('SEA' + JSON.stringify({ ':': data, '~': signed.s, '+': 'cert' })), false);
  });

  it('a forged error ack from another peer neither fails nor stalls a publish', async () => {
    const a = mk();
    const b = mk();
    await until(() => a.connected() && b.connected(), 5000, 'connect');
    const soul = 'avalon/v1/lobby/WXYZ#';
    // b watches the soul and answers every put it sees with a forged SEA rejection.
    b.subscribe(soul, () => undefined);
    let forged = 0;
    const wire = Object.values(b.handle.root.opt.peers).find((p) => p?.wire)?.wire as unknown as
      { on(ev: 'message', cb: (d: unknown) => void): void; send(s: string): void } | undefined;
    assert.ok(wire !== undefined);
    wire.on('message', (d) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(d));
      } catch {
        return;
      }
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
        if (typeof msg !== 'object' || msg === null) continue;
        const m = msg as Record<string, unknown>;
        const put = m.put;
        if (typeof put !== 'object' || put === null || !(soul in put) || typeof m['#'] !== 'string') continue;
        forged++;
        wire.send(JSON.stringify({ '#': 'f' + forged, '@': m['#'], err: 'Data hash not same as hash!' }));
      }
    });
    await sleep(300);
    const v = value();
    await a.publish(soul, sha(v), v);
    assert.equal(a.isEchoed(sha(v), soul), true);
    assert.equal(relay.stored(soul, sha(v)), v);
    await until(() => forged > 0, 3000, 'the attacker saw the put');
    assert.ok((relay.filter?.stats.reasons['ack from a client'] ?? 0) > 0, 'the relay dropped the forged ack');
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

describe('GunTransport acknowledgements (fake handle)', () => {
  /** A GUN handle whose puts are answered with the given acks in order (then ok). */
  function fakeHandle(acks: GunAck[]): { handle: GunHandle; puts: () => number } {
    let puts = 0;
    const chain = {
      get: () => chain,
      map: () => chain,
      on: () => chain,
      put: (_v: string, cb?: (ack: GunAck) => void) => {
        puts++;
        const ack = acks.shift() ?? { ok: 1 };
        setTimeout(() => cb?.(ack), 1);
        return chain;
      },
    };
    const handle = {
      gun: { ...chain, user: () => ({ ...chain, auth: () => undefined, leave: () => undefined }), opt: () => undefined, _: { opt: { peers: {} }, graph: {}, on: () => undefined } },
      root: { opt: { peers: {} }, graph: {}, on: () => undefined },
      peerUrl: 'http://fake/gun',
      connected: () => true,
      onHi: () => () => undefined,
      onBye: () => () => undefined,
      onIn: () => () => undefined,
      reconnect: () => undefined,
      say: () => undefined,
      reask: () => 'id',
      auth: async () => undefined,
      authed: false,
      close: () => undefined,
    } satisfies GunHandle;
    return { handle, puts: () => puts };
  }

  it('an error ack (possibly forged) is retried with backoff, never treated as final', async () => {
    const f = fakeHandle([{ err: 'Data hash not same as hash!' }, { err: 'Signature fail.' }]);
    const timers = { now: () => Date.now(), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 5)), clearTimeout: (h: ReturnType<typeof setTimeout> | null) => { if (h !== null) clearTimeout(h); } };
    const t = new GunTransport({ relayUrl: 'http://fake', createHandle: () => f.handle, timers });
    const v = value();
    await t.publish('avalon/v1/lobby/BCDF#', sha(v), v);
    assert.equal(f.puts(), 3);
    assert.equal(t.isEchoed(sha(v)), true);
    t.close();
  });
});
