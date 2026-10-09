// Smoke test of a running relay with two node GUN clients (WP-E acceptance).
//
//   tsx server/smoke.ts http://127.0.0.1:8001 [seconds=60]
//
// For the whole duration both clients publish valid content-addressed lobby
// values and SEA-signed presence; each must see every value of the other
// within a few seconds. A forged write (value under a wrong hash key, sent raw
// past the client's own SEA) must never reach the other client. Exit status 1
// on any failure.

import './gun-shim';
import Gun from 'gun';
import 'gun/sea';
import type { ISEAPair } from 'gun';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PRESENCE_KEY, VALUE_PREFIX } from './relay';

interface Ack { err?: string }
interface Chain {
  get(key: string): Chain;
  put(value: string, cb?: (ack: Ack) => void): Chain;
  map(): Chain;
  on(cb: (data: unknown, key: string) => void): Chain;
}
interface UserChain extends Chain {
  auth(pair: ISEAPair, cb: (ack: Ack) => void): void;
}
interface ClientInternals {
  opt: {
    peers: Record<string, { url?: string; defer?: ReturnType<typeof setTimeout>; wire?: { readyState?: number; close?: () => void } | null } | undefined>;
    mesh?: { say(msg: Record<string, unknown>): unknown };
  };
}
interface Client extends Chain {
  user(): UserChain;
  _: ClientInternals;
}

interface SeaApi { pair(): Promise<ISEAPair> }

export interface SmokeReport {
  seconds: number;
  published: number;
  delivered: number;
  maxLatencyMs: number;
  presenceUpdates: number;
  forgedSent: number;
  forgedSeen: number;
  failures: string[];
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ';
const DELIVERY_DEADLINE_MS = 5000;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function envelopeLike(): string {
  return VALUE_PREFIX + randomBytes(200).toString('base64url') + '.' + randomBytes(64).toString('base64url');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function client(relayUrl: string): Client {
  const factory = Gun as unknown as (o: Record<string, unknown>) => Client;
  return factory({
    peers: [relayUrl.replace(/\/$/, '') + '/gun'],
    localStorage: false,
    radisk: false,
    rfs: false,
    // In node `import 'gun'` makes every instance a super peer, which never dials out.
    super: false,
    multicast: false,
    axe: false,
    stats: false,
  });
}

function close(c: Client): void {
  for (const [k, peer] of Object.entries(c._.opt.peers)) {
    delete c._.opt.peers[k];
    if (!peer) continue;
    clearTimeout(peer.defer);
    try {
      peer.wire?.close?.();
    } catch {
      // already closed
    }
  }
}

/** Authenticates `c`'s user with `pair`. (A GUN chain is thenable, so it is not the resolved value.) */
function auth(c: Client, pair: ISEAPair): Promise<void> {
  const user = c.user();
  return new Promise((resolve, reject) => {
    user.auth(pair, (ack) => (ack.err ? reject(new Error(ack.err)) : resolve()));
  });
}

export async function runSmoke(relayUrl: string, seconds: number): Promise<SmokeReport> {
  const SEA = (Gun as unknown as { SEA: SeaApi }).SEA;
  const report: SmokeReport = {
    seconds, published: 0, delivered: 0, maxLatencyMs: 0, presenceUpdates: 0, forgedSent: 0, forgedSeen: 0, failures: [],
  };

  const info = await fetch(relayUrl.replace(/\/$/, '') + '/api/relay-info').then((r) => r.json() as Promise<unknown>);
  if (typeof info !== 'object' || info === null || typeof (info as { bootId?: unknown }).bootId !== 'string') {
    report.failures.push('/api/relay-info did not return a bootId');
  }

  const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  const soul = `avalon/v1/lobby/${code}#`;
  const a = client(relayUrl);
  const b = client(relayUrl);
  const clients = [a, b];

  // sent[i]: values published by client i, with their publish time.
  const sent: Map<string, number>[] = [new Map(), new Map()];
  const seen: Set<string>[] = [new Set(), new Set()];
  const forged = new Set<string>();

  clients.forEach((c, i) => {
    c.get(soul).map().on((data, key) => {
      if (typeof data !== 'string') return;
      if (forged.has(key)) report.forgedSeen++;
      const other = sent[1 - i];
      const t = other.get(data);
      if (t !== undefined && !seen[i].has(data)) {
        seen[i].add(data);
        report.delivered++;
        report.maxLatencyMs = Math.max(report.maxLatencyMs, Date.now() - t);
      }
    });
  });

  const [pairA, pairB] = await Promise.all([SEA.pair(), SEA.pair()]);
  await Promise.all([auth(a, pairA), auth(b, pairB)]);
  const userA = a.user();
  const userB = b.user();
  b.get('~' + pairA.pub).get(PRESENCE_KEY).on((v) => { if (typeof v === 'string') report.presenceUpdates++; });
  a.get('~' + pairB.pub).get(PRESENCE_KEY).on((v) => { if (typeof v === 'string') report.presenceUpdates++; });

  const end = Date.now() + seconds * 1000;
  let tick = 0;
  let seq = 0;
  while (Date.now() < end) {
    const i = tick % 2;
    const value = envelopeLike();
    sent[i].set(value, Date.now());
    clients[i].get(soul).get(sha256Hex(value)).put(value);
    report.published++;
    if (tick % 8 === 0) {
      seq++;
      userA.get(PRESENCE_KEY).put(JSON.stringify({ seq, vis: 1 }));
      userB.get(PRESENCE_KEY).put(JSON.stringify({ seq, vis: 1 }));
    }
    if (tick % 20 === 10) {
      // Forged: a valid-looking value under a key that is not its hash, sent
      // raw (a's own SEA would refuse a normal put).
      const v = envelopeLike();
      const k = sha256Hex(v + '!');
      forged.add(k);
      a._.opt.mesh?.say({
        '#': randomBytes(9).toString('base64url'),
        put: { [soul]: { _: { '#': soul, '>': { [k]: Gun.state() } }, [k]: v } },
      });
      report.forgedSent++;
    }
    tick++;
    await sleep(250);
  }

  // Let the last values arrive.
  const deadline = Date.now() + DELIVERY_DEADLINE_MS;
  while (Date.now() < deadline && report.delivered < report.published) await sleep(100);

  if (report.delivered !== report.published) {
    report.failures.push(`delivered ${report.delivered} of ${report.published} values`);
  }
  if (report.maxLatencyMs > DELIVERY_DEADLINE_MS) report.failures.push(`max latency ${report.maxLatencyMs} ms`);
  if (report.forgedSeen > 0) report.failures.push(`${report.forgedSeen} forged values reached a client`);
  if (report.presenceUpdates === 0) report.failures.push('no presence update was delivered');

  close(a);
  close(b);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2] ?? 'http://127.0.0.1:8001';
  const seconds = Number(process.argv[3] ?? 60);
  const report = await runSmoke(url, seconds);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.failures.length === 0 ? 0 : 1);
}
