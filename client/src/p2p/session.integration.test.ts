/**
 * GUN integration (docs/p2p-protocol.md §12, WP-D acceptance): an in-process
 * relay (server/relay.ts with gun/sea and the relay filter) and 5 P2PSessions
 * (in-memory KV, GunTransport, SeatDrivers) play a full game through the
 * session API: lobby create/join, start, setup, proposals, votes, missions,
 * assassination, reveals. During the game the relay is down for 40 s (clients
 * reconnect through the watchdog) and later restarts with an empty disk
 * (clients detect the new bootId and republish the whole transcript).
 *
 * AVALON_OUTAGE_MS shortens the outage for local iteration (default 40000).
 */
import { TestRelay } from './relayHarness.ts';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { gameSoul, type Hex32, type LobbyData, type RoleDoc, type Verdict } from '@avalon/common/protocol';
import { memoCrypto } from '@avalon/common/testing';
import { silenceGunLog } from './gun.ts';
import { GunTransport } from './gunTransport.ts';
import { P2PSession, type SessionStatus } from './session.ts';
import { MemoryKV } from './store.ts';

silenceGunLog();

const OUTAGE_MS = Number(process.env.AVALON_OUTAGE_MS ?? '40000');
const NAMES = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

interface Player {
  name: string;
  session: P2PSession;
  lobby: LobbyData | null;
  role: RoleDoc | null;
  status: SessionStatus;
  statuses: string[];
  kv: MemoryKV;
}

/** Plays the human steps through the session API, like a user clicking (§7.7: only from UI calls). */
class AutoPlayer {
  private readonly acted = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly errors: string[] = [];
  paused = false;

  constructor(private readonly players: Player[]) {}

  start(): void {
    this.timer = setInterval(() => this.step(), 100);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  private act(p: Player, key: string, f: () => Promise<void>): void {
    if (this.acted.has(key)) return;
    this.acted.add(key);
    f().catch((e: unknown) => {
      this.errors.push(`${p.name} ${key}: ${e instanceof Error ? e.message : String(e)}`);
      this.acted.delete(key);
    });
  }

  private step(): void {
    if (this.paused) return;
    for (const p of this.players) {
      const d = p.session.currentDriver;
      const ev = d?.evaluation;
      if (d === null || d === undefined || ev === null || ev === undefined || ev.terminal !== null || ev.pending === null) continue;
      if (ev.pendingReveals.length > 0) continue;
      const step = ev.pending.step;
      const seat = d.seat;
      const names = d.config.seats.map((s) => s.name);
      const key = `${p.name}/${step.id}`;
      if (step.type === 'propose' && step.req !== 'assassin' && step.req[0] === seat) {
        const cur = ev.state.cursor;
        const size = cur.t === 'p' ? ev.state.missions[cur.m].teamSize : 0;
        // the proposer and the next seats
        const team = Array.from({ length: size }, (_, i) => names[(seat + i) % names.length]);
        this.act(p, key, () => p.session.proposeTeam(team));
      } else if (step.type === 'vote.commit' && ev.pending.missing.includes(seat)) {
        this.act(p, key, () => p.session.voteTeam(true));
      } else if (step.type === 'ballot' && step.req !== 'assassin' && step.req.includes(seat) && ev.pending.missing.includes(seat)) {
        this.act(p, key, () => p.session.doMission(true));
      } else if (step.type === 'assassinate' && p.role?.assassin === true) {
        const target = names.find((n) => n !== p.name && !(p.role?.sees ?? []).includes(n)) ?? names[(seat + 1) % names.length];
        this.act(p, key, () => p.session.assassinate(target));
      }
    }
  }
}

describe('five P2PSessions over GUN with an in-process relay', () => {
  let relay: TestRelay;
  const players: Player[] = [];
  const memo = new Map<Hex32, Verdict>();
  const crypto = memoCrypto(memo);
  let observer: GunTransport | null = null;

  before(async () => {
    relay = await TestRelay.start();
    for (const name of NAMES) {
      const kv = new MemoryKV();
      const session = await P2PSession.open({
        relayUrl: relay.url, kv, locks: null, crypto, window: null, document: null, wakeLock: null, gunClock: false,
        discoveryMs: 2000, probeMs: 500,
      });
      const p: Player = { name, session, lobby: null, role: null, status: session.status, statuses: [], kv };
      session.onLobby((l) => {
        p.lobby = l;
      });
      session.onRole((r) => {
        p.role = r;
      });
      session.onStatus((s) => {
        p.status = s;
        p.statuses.push(s.kind);
      });
      players.push(p);
    }
  });

  after(async () => {
    observer?.close();
    for (const p of players) p.session.close();
    await relay.close();
  });

  it('lobby: create, discover and join by code, admin admits, names are unique', async () => {
    for (const p of players) await p.session.createIdentity();
    for (const p of players) assert.ok(p.session.profile !== null);
    const { lobby: code } = await players[0].session.createLobby(NAMES[0]);
    assert.match(code, /^[A-HJ-NP-TV-Z]{4}$/);
    const found = await players[1].session.findLobbies(code);
    assert.equal(found.length, 1);
    assert.equal(found[0].adminName, 'ALICE');
    await Promise.all(players.slice(1).map((p) => p.session.joinLobby(p.name, code)));
    await until(() => players.every((p) => p.lobby !== null && Object.keys(p.lobby.users).length === 5), 20000, 'everyone in the lobby');
    for (const p of players) {
      assert.equal(p.session.profile?.lobby, code);
      assert.equal(p.lobby?.admin.name, 'ALICE');
    }
    // a second device with a taken name is rejected by the admin's roster
    const intruder = await P2PSession.open({
      relayUrl: relay.url, kv: new MemoryKV(), locks: null, crypto, window: null, document: null, wakeLock: null, gunClock: false,
      discoveryMs: 2000, probeMs: 500,
    });
    try {
      await intruder.createIdentity();
      await assert.rejects(intruder.joinLobby('BOB', code), /Name taken/);
      await assert.rejects(intruder.joinLobby('ZED', 'XXXX'), /not found/);
    } finally {
      intruder.close();
    }
  });

  it('plays a full game through a 40 s relay outage and an empty-disk relay restart', { timeout: 600000 }, async () => {
    const admin = players[0].session;
    await assert.rejects(players[1].session.startGame(NAMES, ['MERLIN'], { inGameLog: false }), /Only the admin/);
    await admin.startGame(NAMES, ['MERLIN'], { inGameLog: false });
    const auto = new AutoPlayer(players);
    auto.start();
    try {
      await until(() => players.every((p) => p.lobby?.game.state === 'ACTIVE' && p.role !== null), 120000, 'setup complete');
      for (const p of players) {
        assert.equal(p.lobby?.game.players.length, 5);
        assert.ok(p.role?.sees !== undefined, 'sees known');
        assert.ok(p.statuses.includes('STARTING') || p.statuses.includes('SETUP'), 'setup statuses shown: ' + p.statuses.join(','));
      }
      const gameId = players[0].session.currentDriver?.config.gameId ?? '';
      const setupSoul = gameSoul(gameId, 'setup');
      const playSoul = gameSoul(gameId, 'play');

      // --- outage: the relay is down for OUTAGE_MS while players keep acting (their puts wait)
      await until(() => (players[0].lobby?.game.missions[0].proposals.length ?? 0) > 0, 60000, 'first proposal');
      await relay.stop();
      await until(() => players.every((p) => !p.session.connected), 10000, 'disconnect seen');
      await sleep(OUTAGE_MS);
      await relay.restart({ emptyDisk: false });
      await until(() => players.every((p) => p.session.connected), 30000, 'watchdog reconnect');
      assert.ok(players.every((p) => p.session.reconnects > 0));
      await until(() => players.every((p) => p.lobby?.game.missions[0].state !== 'PENDING'), 60000, 'mission 0 after the outage');

      // --- relay restart with an empty disk: clients see a new bootId and republish everything
      auto.paused = true;
      await sleep(1500);
      const before = players[0].session.currentDriver?.messages().length ?? 0;
      await relay.restart({ emptyDisk: true });
      assert.equal(relay.count(setupSoul), 0);
      await until(() => players.every((p) => p.session.connected), 30000, 'reconnect after restart');
      await until(() => relay.count(setupSoul) + relay.count(playSoul) >= before, 30000, 'transcript republished to the empty relay');
      // a fresh client sees the whole game
      observer = new GunTransport({ relayUrl: relay.url });
      const seen = new Set<string>();
      observer.subscribe(setupSoul, (k) => seen.add(k));
      observer.subscribe(playSoul, (k) => seen.add(k));
      await until(() => seen.size >= before, 20000, 'fresh client sees the transcript');
      auto.paused = false;

      await until(() => players.every((p) => p.lobby?.game.state === 'ENDED'), 240000, 'game end');
      await until(() => players.every((p) => p.lobby?.game.outcome?.final === true), 60000, 'all reveals');
      const outcomes = players.map((p) => JSON.stringify(p.lobby?.game.outcome));
      assert.ok(outcomes.every((o) => o === outcomes[0]), 'same outcome everywhere');
      const out = players[0].lobby?.game.outcome;
      assert.ok(out !== undefined && (out.state === 'GOOD_WIN' || out.state === 'EVIL_WIN'), 'natural outcome: ' + out?.state);
      assert.equal(out.cheaters.length, 0);
      // identical transcripts
      const ids = players.map((p) => (p.session.currentDriver?.messages() ?? []).map((m) => m.msgId).sort().join());
      assert.ok(ids.every((x) => x === ids[0]), 'same transcript everywhere');
      await until(() => players.every((p) => p.status.kind === 'ENDED'), 10000, 'status ENDED');
      for (const p of players) {
        const stats = await p.session.userStats();
        assert.equal(stats.games, 1, p.name + ' stats');
      }
      const errs = players.flatMap((p) => p.session.errors.map((e) => p.name + ': ' + e));
      console.log('auto-player errors:', auto.errors.length, auto.errors.slice(0, 5), 'session errors:', errs.slice(0, 10));
      assert.deepEqual(errs.filter((e) => !/stale|no longer pending|Waiting|Stopped/i.test(e)), []);
    } finally {
      auto.stop();
    }
  });
});
