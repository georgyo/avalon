/**
 * In-process GUN relay for the WP-D integration tests (docs/p2p-protocol.md
 * §12 "GUN integration"): the server's relay module (`createRelay` +
 * `installRelayFilter`, SEA loaded) on a local HTTP server that also answers
 * `GET /api/relay-info`. It can be stopped (an outage) and restarted on the
 * same port, with its disk kept or emptied (a new bootId either way).
 * Test-only: imports node modules and server/.
 */
import './testShim.ts';
// `gun` in node is lib/server.js: it registers the websocket server (lib/wire) the relay needs
import 'gun';
import 'gun/sea';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/** The parts of server/relay.ts used here (loaded dynamically: the server sources are type-checked by the server package). */
export interface RelayFilter { readonly stats: { accepted: number; dropped: number; reasons: Record<string, number> } }
interface RelayModule {
  createRelay(web: Server, file: string): object;
  installRelayFilter(gun: object): RelayFilter;
}

function isRelayModule(m: unknown): m is RelayModule {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return typeof r.createRelay === 'function' && typeof r.installRelayFilter === 'function';
}

let relayModule: RelayModule | null = null;

async function loadRelayModule(): Promise<RelayModule> {
  if (relayModule !== null) return relayModule;
  const path = new URL('../../../server/relay.ts', import.meta.url).href;
  const m: unknown = await import(path);
  if (!isRelayModule(m)) throw new Error('server/relay.ts does not export createRelay/installRelayFilter');
  relayModule = m;
  return m;
}

interface RelayRoot {
  opt: { ws?: { web?: { clients?: Set<{ terminate(): void }>; close(): void } } };
  graph: Record<string, Record<string, unknown> | undefined>;
}

export interface TestRelayOptions {
  /** Install the relay's input filter (default true). false: a plain GUN relay, like a public community relay. */
  filter?: boolean;
  /** Public relays advertised in /api/relay-info (§7.1). */
  peers?: string[];
}

export class TestRelay {
  port = 0;
  /** Public relays advertised in /api/relay-info; may change between requests. */
  peers: string[];
  private readonly withFilter: boolean;
  bootId = '';
  filter: RelayFilter | null = null;
  /** Static files served by the relay's HTTP server (browser tests: same origin as /gun and /api). */
  readonly files = new Map<string, { type: string; body: string | Buffer }>();
  private server: Server | null = null;
  private root: RelayRoot | null = null;
  private dir: string;
  private readonly dirs: string[] = [];

  private constructor(o: TestRelayOptions) {
    this.dir = this.newDir();
    this.withFilter = o.filter !== false;
    this.peers = o.peers ?? [];
  }

  private newDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'avalon-wpd-relay-'));
    this.dirs.push(d);
    return d;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get running(): boolean {
    return this.server !== null;
  }

  static async start(o: TestRelayOptions = {}): Promise<TestRelay> {
    const r = new TestRelay(o);
    await r.listen(0);
    return r;
  }

  private async listen(port: number): Promise<void> {
    this.bootId = randomBytes(16).toString('base64url');
    const server = createServer((req, res) => {
      if (req.url !== undefined && req.url.startsWith('/api/relay-info')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ bootId: this.bootId, now: Date.now(), peers: this.peers }));
        return;
      }
      const f = this.files.get((req.url ?? '/').split('?')[0]);
      if (f !== undefined) {
        res.setHeader('content-type', f.type);
        res.end(f.body);
        return;
      }
      if (process.env.AVALON_DEBUG) console.log('relay 404', req.method, req.url, JSON.stringify(req.headers));
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    const relay = await loadRelayModule();
    const gun = relay.createRelay(server, join(this.dir, 'radata'));
    this.filter = this.withFilter ? relay.installRelayFilter(gun) : null;
    this.root = (gun as unknown as { _: RelayRoot })._;
    this.server = server;
  }

  /** The relay's in-memory graph value. */
  stored(soul: string, key: string): unknown {
    return this.root?.graph[soul]?.[key];
  }

  /** Number of keys the relay holds for a soul. */
  count(soul: string): number {
    const node = this.root?.graph[soul];
    return node === undefined ? 0 : Object.keys(node).filter((k) => k !== '_').length;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const root = this.root;
    this.server = null;
    this.root = null;
    if (server === null) return;
    const wss = root?.opt.ws?.web;
    for (const c of wss?.clients ?? []) c.terminate();
    wss?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Restarts on the same port (new bootId); `emptyDisk` starts from a fresh radisk directory. */
  async restart(o: { emptyDisk: boolean }): Promise<void> {
    await this.stop();
    if (o.emptyDisk) this.dir = this.newDir();
    await this.listen(this.port);
  }

  async close(): Promise<void> {
    await this.stop();
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
  }
}
