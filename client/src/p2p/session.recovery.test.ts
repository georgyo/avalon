/**
 * Session lifecycle over an in-process relay (docs/p2p-protocol.md §3.10,
 * §4.5, §7): kick, reload mid-game (startup recovery from the store), lost
 * storage (LOST_SECRETS, cancel with reason 'lost'), leave and takeover.
 */
import { TestRelay } from './relayHarness.ts';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Hex32, LobbyData, RoleDoc, Verdict } from '@avalon/common/protocol';
import { memoCrypto } from '@avalon/common/testing';
import { silenceGunLog } from './gun.ts';
import { P2PSession, type LocalProfile, type SessionStatus } from './session.ts';
import { MemoryKV } from './store.ts';

silenceGunLog();

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
  kv: MemoryKV;
  session: P2PSession;
  lobby: LobbyData | null;
  role: RoleDoc | null;
  profile: LocalProfile | null;
  status: SessionStatus;
  statuses: string[];
}

describe('session lifecycle', () => {
  let relay: TestRelay;
  const memo = new Map<Hex32, Verdict>();
  const crypto = memoCrypto(memo);
  const players = new Map<string, Player>();
  let code = '';

  const open = async (name: string, kv: MemoryKV): Promise<Player> => {
    const session = await P2PSession.open({
      relayUrl: relay.url, kv, locks: null, crypto, window: null, document: null, wakeLock: null, gunClock: false,
      discoveryMs: 2000, probeMs: 300,
    });
    const p: Player = { name, kv, session, lobby: null, role: null, profile: null, status: session.status, statuses: [] };
    session.onLobby((l) => {
      p.lobby = l;
    });
    session.onRole((r) => {
      p.role = r;
    });
    session.onProfile((x) => {
      p.profile = x;
    });
    session.onStatus((s) => {
      p.status = s;
      p.statuses.push(s.kind);
    });
    players.set(name, p);
    return p;
  };
  const P = (name: string): Player => {
    const p = players.get(name);
    if (p === undefined) throw new Error(name);
    return p;
  };
  const playing = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN'];

  before(async () => {
    relay = await TestRelay.start();
    for (const name of [...playing, 'FRANK']) {
      const p = await open(name, new MemoryKV());
      await p.session.createIdentity();
    }
  });

  after(async () => {
    for (const p of players.values()) p.session.close();
    await relay.close();
  });

  it('kick: the kicked member is disconnected from the lobby', async () => {
    ({ lobby: code } = await P('ALICE').session.createLobby('ALICE'));
    for (const n of [...playing.slice(1), 'FRANK']) await P(n).session.joinLobby(n, code);
    await until(() => [...players.values()].every((p) => Object.keys(p.lobby?.users ?? {}).length === 6), 20000, 'six members');
    await assert.rejects(P('BOB').session.kickPlayer('FRANK'), /Only the admin/);
    await P('ALICE').session.kickPlayer('FRANK');
    await until(() => P('FRANK').profile?.lobby === null, 10000, 'FRANK disconnected');
    await until(() => playing.every((n) => Object.keys(P(n).lobby?.users ?? {}).length === 5), 10000, 'five members');
    assert.equal(P('FRANK').session.status.kind, 'LOBBY');
  });

  it('reload mid-game resumes from the store; lost storage gives LOST_SECRETS and a lost cancel', { timeout: 300000 }, async () => {
    await P('ALICE').session.startGame(playing, [], { inGameLog: true });
    await until(() => playing.every((n) => P(n).lobby?.game.state === 'ACTIVE' && P(n).role !== null), 120000, 'game active');
    await assert.rejects(P('ALICE').session.kickPlayer('BOB'), /Cancel game first/);
    await assert.rejects(P('ALICE').session.resetIdentity(), /during a game/);
    const bobRole = JSON.stringify(P('BOB').role);
    const gameId = P('BOB').session.currentDriver?.config.gameId;

    // --- reload BOB: a fresh session over the same store
    P('BOB').session.close();
    const bob = await open('BOB', P('BOB').kv);
    assert.equal(bob.profile?.lobby, code);
    await until(() => bob.lobby?.game.state === 'ACTIVE' && bob.role !== null, 60000, 'BOB resumed');
    assert.equal(JSON.stringify(bob.role), bobRole, 'same role after reload');
    assert.equal(bob.session.currentDriver?.config.gameId, gameId);
    assert.equal(bob.session.currentDriver?.privateView === null, false);

    // the game goes on after the reload: the first proposer proposes
    const d = bob.session.currentDriver;
    assert.ok(d !== null);
    await until(() => d.evaluation?.pending?.step.type === 'propose', 10000, 'proposal step');
    const proposerSeat = d.evaluation?.pending?.step.req;
    assert.ok(Array.isArray(proposerSeat));
    const proposer = playing[proposerSeat[0]];
    await P(proposer).session.proposeTeam(playing.slice(0, 2));
    await until(() => playing.every((n) => P(n).lobby?.game.phase === 'PROPOSAL_VOTE'), 20000, 'proposal vote');
    await assert.rejects(P(proposer).session.proposeTeam(playing.slice(0, 2)), /Not in team proposal phase/);

    // --- CAROL loses her game records (but keeps her identity): LOST_SECRETS, never keys again
    P('CAROL').session.close();
    const kv = P('CAROL').kv;
    await kv.clear(['games', 'journal', 'transcript', 'verdicts']);
    const carol = await open('CAROL', kv);
    await until(() => carol.status.kind === 'LOST_SECRETS', 30000, 'LOST_SECRETS');
    await assert.rejects(carol.session.voteTeam(true), /lost the secret keys/);
    // the observer-first acceptance never produced a second key for CAROL (§3.10: x_j is never regenerated)
    const keys = (P('ALICE').session.currentDriver?.messages() ?? []).filter((m) => m.env.type === 'key');
    assert.equal(keys.length, 5);
    await carol.session.cancelGame();
    await until(() => playing.every((n) => P(n).lobby?.game.state === 'ENDED'), 30000, 'canceled everywhere');
    const out = P('ALICE').lobby?.game.outcome;
    assert.equal(out?.state, 'CANCELED');
    assert.match(out?.message ?? '', /CAROL/);
    // the others reveal; CAROL cannot
    await until(() => playing.filter((n) => n !== 'CAROL').every((n) => (P(n).lobby?.game.outcome?.unrevealed ?? []).every((u) => u === 'CAROL')), 30000, 'reveals');
    assert.equal((await P('ALICE').session.userStats()).games, 0, 'canceled games do not count');
  });

  it('leave after the game: the admin removes the leaver; takeover when the admin is gone', { timeout: 120000 }, async () => {
    await P('DAVE').session.leaveLobby();
    assert.equal(P('DAVE').profile?.lobby, null);
    await until(() => ['ALICE', 'BOB', 'CAROL', 'ERIN'].every((n) => P(n).lobby !== null && !('DAVE' in (P(n).lobby?.users ?? {}))), 20000, 'DAVE removed');
    // ALICE (admin) goes away; BOB takes over
    P('ALICE').session.close();
    await P('BOB').session.takeOverAdmin();
    await until(() => ['BOB', 'CAROL', 'ERIN'].every((n) => P(n).lobby?.admin.name === 'BOB'), 20000, 'BOB is admin');
    await assert.rejects(P('BOB').session.takeOverAdmin(), /already the admin/);
  });
});
