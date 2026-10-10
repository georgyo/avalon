/**
 * Public relays (docs/p2p-protocol.md §7.1): a client dials the own relay and
 * the public relays it advertises. Clients on different relays still see each
 * other's messages (a client connected to both forwards between them), and a
 * client keeps publishing and receiving through a public relay while its own
 * relay is down, then redials the own relay.
 */
import { TestRelay } from './relayHarness.ts';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { isPeerUrl, relayInfo, sanitizePeers, silenceGunLog, MAX_PUBLIC_PEERS } from './gun.ts';
import { GunTransport } from './gunTransport.ts';

silenceGunLog();

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** A well-shaped (unsigned) lobby envelope value: the filtered relay checks shapes (§8). */
const value = (): string => 'AV1.' + Buffer.from(JSON.stringify({ v: 1, type: 'lobby.join', pad: randomBytes(40).toString('base64url') })).toString('base64url')
  + '.' + randomBytes(64).toString('base64url');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 10000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(20);
  }
}

describe('public relay URLs', () => {
  it('accepts https/wss anywhere and http/ws only on loopback', () => {
    assert.equal(isPeerUrl('https://relay.example.org/gun'), true);
    assert.equal(isPeerUrl('wss://relay.example.org/gun'), true);
    assert.equal(isPeerUrl('http://127.0.0.1:8765/gun'), true);
    assert.equal(isPeerUrl('ws://localhost:8765/gun'), true);
    assert.equal(isPeerUrl('http://relay.example.org/gun'), false);
    assert.equal(isPeerUrl('ftp://relay.example.org/gun'), false);
    assert.equal(isPeerUrl('https://user:pw@relay.example.org/gun'), false);
    assert.equal(isPeerUrl('https://relay.example.org/gun?x=1'), false);
    assert.equal(isPeerUrl('javascript:alert(1)'), false);
    assert.equal(isPeerUrl('https://' + 'a'.repeat(300) + '.org/gun'), false);
    assert.equal(isPeerUrl(42), false);
  });

  it('sanitizes an untrusted list: valid, distinct, bounded', () => {
    assert.deepEqual(sanitizePeers('https://a.org/gun'), []);
    assert.deepEqual(sanitizePeers(['https://a.org/gun', 'https://a.org/gun', 'nope', 7, 'https://b.org/gun']), ['https://a.org/gun', 'https://b.org/gun']);
    const many = Array.from({ length: 20 }, (_, i) => `https://r${i}.org/gun`);
    assert.equal(sanitizePeers(many).length, MAX_PUBLIC_PEERS);
  });
});

describe('GunTransport with a public relay', () => {
  let own: TestRelay;
  let pub: TestRelay;
  const transports: GunTransport[] = [];
  const mk = (relayUrl: string, extraPeers: string[] = []): GunTransport => {
    const t = new GunTransport({ relayUrl, extraPeers });
    transports.push(t);
    return t;
  };
  const pubPeer = (): string => pub.url + '/gun';

  before(async () => {
    pub = await TestRelay.start({ filter: false });
    own = await TestRelay.start({ peers: [] });
    own.peers = [pubPeer()];
  });
  after(async () => {
    for (const t of transports) t.close();
    await own.close();
    await pub.close();
  });

  it('/api/relay-info carries the advertised public relays', async () => {
    const info = await relayInfo(own.url);
    assert.deepEqual(info.peers, [pubPeer()]);
  });

  it('clients on different relays see each other; the own relay goes down and comes back', async () => {
    const soul = 'avalon/v1/lobby/BCDF#';
    // a: own relay + public relay. b: public relay only. c: own relay only.
    const a = mk(own.url, [pubPeer()]);
    const b = mk(pub.url);
    const c = mk(own.url);
    const gotA = new Map<string, string>();
    const gotB = new Map<string, string>();
    const gotC = new Map<string, string>();
    a.subscribe(soul, (k, v) => gotA.set(k, v));
    b.subscribe(soul, (k, v) => gotB.set(k, v));
    c.subscribe(soul, (k, v) => gotC.set(k, v));
    await until(() => a.peers().every((p) => p.open) && b.connected() && c.connected(), 8000, 'connections');
    assert.deepEqual(a.peers().map((p) => [p.own, p.url]), [[true, own.url + '/gun'], [false, pubPeer()]]);

    // b publishes on the public relay only: a receives it there and forwards it to the own relay, where c sees it.
    const v1 = value();
    await b.publish(soul, sha(v1), v1);
    await until(() => gotA.get(sha(v1)) === v1 && gotC.get(sha(v1)) === v1, 8000, 'b -> a -> c');

    // c publishes on the own relay only: a forwards it to the public relay, where b sees it.
    const v2 = value();
    await c.publish(soul, sha(v2), v2);
    await until(() => gotA.get(sha(v2)) === v2 && gotB.get(sha(v2)) === v2, 8000, 'c -> a -> b');

    // The own relay goes down: a stays connected through the public relay and keeps playing with b.
    await own.stop();
    await until(() => !a.peers()[0].open, 5000, 'own relay closed');
    assert.equal(a.connected(), true);
    const v3 = value();
    await a.publish(soul, sha(v3), v3);
    await until(() => gotB.get(sha(v3)) === v3, 8000, 'a -> b during the outage');
    const v4 = value();
    await b.publish(soul, sha(v4), v4);
    await until(() => gotA.get(sha(v4)) === v4, 8000, 'b -> a during the outage');

    // The own relay comes back (same disk): a redials it on its own backoff (2, 4, 8 s).
    await own.restart({ emptyDisk: false });
    const deadline = Date.now() + 25000;
    while (!a.peers()[0].open) {
      if (Date.now() > deadline) throw new Error('own relay was not redialed');
      a.redialMissing();
      await sleep(100);
    }
    assert.equal(a.peers().every((p) => p.open), true);
  });

  it('addPeers() dials a relay learned later and survives rebuild()', async () => {
    const soul = 'avalon/v1/lobby/CDFG#';
    const a = mk(own.url);
    const b = mk(pub.url);
    const gotA = new Map<string, string>();
    a.subscribe(soul, (k, v) => gotA.set(k, v));
    await until(() => a.connected() && b.connected(), 8000, 'connections');
    assert.equal(a.peers().length, 1);
    a.addPeers(['not a url', pubPeer()]);
    await until(() => a.peers().length === 2 && a.peers().every((p) => p.open), 8000, 'public relay dialed');
    a.rebuild();
    await until(() => a.peers().length === 2 && a.peers().every((p) => p.open), 8000, 'public relay redialed after rebuild');
    const v = value();
    await b.publish(soul, sha(v), v);
    await until(() => gotA.get(sha(v)) === v, 8000, 'b -> a after rebuild');
  });
});
