/**
 * Browser test entry (not part of the app): bundled by browser.test.ts and
 * loaded in Chromium, it exposes the browser-only code paths of the runtime
 * (IndexedDB, the module worker, Web Locks, P2PSession with its defaults) to
 * the test through `window.avalonTest`.
 */
import { runJobs, type VerifyJob } from '@avalon/common/protocol';
import { P2PSession } from './session.ts';
import { createStore, IndexedDbKV } from './store.ts';
import { WorkerPool } from './workerPool.ts';

const sessions: P2PSession[] = [];

function current(): P2PSession {
  const s = sessions[sessions.length - 1];
  if (s === undefined) throw new Error('no session');
  return s;
}

function revealJob(i: number): VerifyJob {
  const G = '4gJ7oWhEPdF7VvYH_3YQcGcbJ_EebKmmzk7Kt8wWg24';
  return { id: i.toString(16).padStart(64, '0'), kind: 'reveal', x: 'A'.repeat(43), y: G, Y: G, ballots: [] };
}

const api = {
  /** IndexedDB KV and the typed store in a scratch database. */
  async idb(): Promise<Record<string, unknown>> {
    const kv = await IndexedDbKV.open(indexedDB, 'avalon-test-' + Math.random().toString(36).slice(2));
    const st = createStore(kv);
    const race = await Promise.all([st.journal.putIfAbsent('S', 'key', 'first'), st.journal.putIfAbsent('S', 'key', 'second')]);
    await st.journal.put('S', 'deal', 'd');
    await st.journal.put('S', 'shuf/0', 's0');
    await st.journal.put('T', 'key', 'other');
    await st.transcript.add('a'.repeat(64), { soul: 'x', key: 'b'.repeat(64), value: 'AV1.1', scope: 'g1' });
    await st.transcript.add('c'.repeat(64), { soul: 'x', key: 'd'.repeat(64), value: 'AV1.2', scope: 'g2' });
    await st.verdicts.put('e'.repeat(64), { ok: false, reason: 'bad' });
    const verdicts = [...(await st.verdicts.getMany(['e'.repeat(64), 'f'.repeat(64)]))];
    const out = {
      race,
      journal: await st.journal.all('S'),
      other: await st.journal.all('T'),
      scope: (await st.transcript.forScope('g1')).map((r) => r.value),
      verdicts,
      profile: await st.profile.get(),
    };
    await st.clearAll();
    return { ...out, afterClear: await st.journal.all('S') };
  },

  /** The real module worker pool against in-page verification. */
  async worker(): Promise<Record<string, unknown>> {
    const pool = new WorkerPool({ size: 2 });
    const jobs = [revealJob(1), revealJob(2), revealJob(3)];
    const viaWorker = await pool.verify(jobs);
    let proveError = '';
    try {
      await pool.prove({ kind: 'nonsense' });
    } catch (e) {
      proveError = e instanceof Error ? e.message : String(e);
    }
    pool.terminate();
    return { same: JSON.stringify(viaWorker) === JSON.stringify(runJobs(jobs)), n: viaWorker.length, proveError, log: pool.log.length };
  },

  /** P2PSession with every browser default (IndexedDB, navigator.locks, WorkerPool, location.origin). */
  async open(): Promise<string> {
    const s = await P2PSession.open();
    sessions.push(s);
    return s.status.kind;
  },
  async createIdentity(): Promise<string | null> {
    await current().createIdentity();
    return current().profile?.uid ?? null;
  },
  async createLobby(name: string): Promise<string> {
    return (await current().createLobby(name)).lobby;
  },
  status(): string {
    return current().status.kind;
  },
  profile(): unknown {
    return current().profile;
  },
  connected(): boolean {
    return current().connected;
  },
  peers(): unknown {
    const root = current().transport.handle.root;
    return Object.entries(root.opt.peers).map(([k, p]) => [k, p?.wire?.readyState ?? null]);
  },
  async useHere(): Promise<string> {
    await current().useHere();
    return current().status.kind;
  },
  async tryCreateIdentity(): Promise<string> {
    try {
      await current().createIdentity();
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
};

(globalThis as unknown as Record<string, unknown>).avalonTest = api;
export type AvalonTestApi = typeof api;
