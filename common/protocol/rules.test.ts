import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../avalonlib.ts';
import { canon, hexEncode, sha256, utf8 } from '../crypto/bytes.ts';
import { legacyAssignRoles, legacyShuffle } from '../testing/legacyAssignRoles.ts';
import {
  approvalsRequired, deriveDeck, distinctLabels, failsRequired, LOBBY_ALPHABET, missionSizes, nextSeat, numEvil,
  roleNamesInPlay, RULES, RULES_HASH, seen, teamOf, validateName, validateSelectedRoles,
} from './rules.ts';

/** Deterministic PRNG in [0, 1) (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SELECTABLE = ROLES.filter((r) => r.selectable).map((r) => r.name);
const PLAYERS = ['ALICE', 'BOB', 'CAROL', 'DAVE', 'ERIN', 'FRANK', 'GRACE', 'HEIDI', 'IVAN', 'JUDY'];

function subsets(): string[][] {
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << SELECTABLE.length; mask++) out.push(SELECTABLE.filter((_, i) => (mask >> i) & 1));
  return out;
}

test('golden: deriveDeck + seen equal the legacy assignRoles for every n and every role subset', () => {
  let cases = 0;
  for (let n = 5; n <= 10; n++) {
    const players = PLAYERS.slice(0, n);
    for (const selected of subsets()) {
      const deck = deriveDeck(n, selected);
      assert.equal(deck.length, n);
      for (let s = 0; s < 12; s++) {
        const seed = n * 100003 + s * 7919 + selected.length * 31 + SELECTABLE.filter((r) => selected.includes(r)).length;
        const legacy = legacyAssignRoles(players, selected, mulberry32(seed * 977 + s));
        // The legacy code's first shuffle decides the seating: shuffled[i] holds deck[i].
        const shuffled = legacyShuffle(players, mulberry32(seed * 977 + s));
        const roleOf = new Map(shuffled.map((p, i) => [p, deck[i]]));
        assert.deepEqual(Object.keys(legacy).sort(), [...players].sort());
        for (const p of players) {
          const mine = roleOf.get(p);
          assert.ok(mine);
          assert.equal(legacy[p].role, mine.role, `role of ${p}, n=${n}, roles=${selected.join(',')}`);
          assert.equal(legacy[p].assassin, mine.assassin, `assassin flag of ${p}, n=${n}, roles=${selected.join(',')}`);
          const expectedSees = players.filter((q) => q !== p && seen(mine.role, roleOf.get(q)?.role ?? '')).sort();
          assert.deepEqual([...legacy[p].sees].sort(), expectedSees, `sees of ${p} (${mine.role}), n=${n}, roles=${selected.join(',')}`);
        }
        cases++;
      }
    }
  }
  assert.equal(cases, 6 * 64 * 12);
});

test('deck structure: numEvil evil cards first, at most one assassin, only with MERLIN', () => {
  for (let n = 5; n <= 10; n++) {
    for (const selected of subsets()) {
      const deck = deriveDeck(n, selected);
      const evil = deck.filter((l) => teamOf(l.role) === 'evil');
      assert.equal(evil.length, numEvil(n));
      assert.ok(deck.slice(0, numEvil(n)).every((l) => teamOf(l.role) === 'evil'));
      const assassins = deck.filter((l) => l.assassin);
      assert.equal(assassins.length, selected.includes('MERLIN') ? 1 : 0);
      assert.ok(assassins.every((l) => teamOf(l.role) === 'evil'));
      // Λ and N_roles
      const labels = distinctLabels(deck);
      assert.equal(new Set(labels.map((l) => l.role + '/' + l.assassin)).size, labels.length);
      const names = roleNamesInPlay(deck);
      assert.deepEqual(names, ROLES.map((r) => r.name).filter((x) => deck.some((l) => l.role === x)));
      assert.ok(labels.length <= 7 && names.length <= 7);
    }
  }
  // Selection order does not matter, the deck follows ROLES order.
  assert.deepEqual(deriveDeck(7, ['OBERON', 'MERLIN', 'MORGANA']), deriveDeck(7, ['MERLIN', 'MORGANA', 'OBERON']));
  // Concrete examples.
  assert.deepEqual(deriveDeck(5, ['MERLIN', 'PERCIVAL', 'MORGANA']), [
    { role: 'MORGANA', assassin: false }, { role: 'EVIL MINION', assassin: true },   // priority 4 > 2
    { role: 'MERLIN', assassin: false }, { role: 'PERCIVAL', assassin: false }, { role: 'LOYAL FOLLOWER', assassin: false },
  ]);
  assert.deepEqual(deriveDeck(5, ['MERLIN', 'MORGANA', 'ASSASSIN']).slice(0, 2), [
    { role: 'MORGANA', assassin: false }, { role: 'ASSASSIN', assassin: true },
  ]);
  // ASSASSIN without MERLIN keeps assassin=false (§2.4).
  assert.deepEqual(deriveDeck(5, ['ASSASSIN']).slice(0, 2), [
    { role: 'ASSASSIN', assassin: false }, { role: 'EVIL MINION', assassin: false },
  ]);
  // Evil specials beyond numEvil are dropped in ROLES order.
  assert.deepEqual(deriveDeck(5, ['MORGANA', 'MORDRED', 'OBERON', 'ASSASSIN']).slice(0, 2).map((l) => l.role), ['MORGANA', 'MORDRED']);
});

test('sight is name-only (assassin flag never matters)', () => {
  assert.equal(seen('MERLIN', 'MORDRED'), false);
  assert.equal(seen('MERLIN', 'ASSASSIN'), true);
  assert.equal(seen('PERCIVAL', 'MORGANA'), true);
  assert.equal(seen('PERCIVAL', 'MERLIN'), true);
  assert.equal(seen('MORGANA', 'OBERON'), false);
  assert.equal(seen('OBERON', 'MORGANA'), false);
  assert.equal(seen('EVIL MINION', 'EVIL MINION'), true);
  assert.equal(seen('LOYAL FOLLOWER', 'MERLIN'), false);
  assert.throws(() => seen('MERLIN', 'UNKNOWN'));
});

test('rule tables (§5.6)', () => {
  assert.deepEqual([5, 6, 7, 8, 9, 10].map(numEvil), [2, 2, 3, 3, 3, 4]);
  assert.deepEqual(missionSizes(5), [2, 3, 2, 3, 3]);
  assert.deepEqual(missionSizes(6), [2, 3, 4, 3, 4]);
  assert.deepEqual(missionSizes(7), [2, 3, 3, 4, 4]);
  for (const n of [8, 9, 10]) assert.deepEqual(missionSizes(n), [3, 4, 4, 5, 5]);
  const ms = missionSizes(5);
  ms[0] = 99;
  assert.deepEqual(missionSizes(5), [2, 3, 2, 3, 3], 'returned arrays are copies');
  for (let n = 5; n <= 10; n++) {
    for (let m = 0; m < 5; m++) assert.equal(failsRequired(n, m), m === 3 && n >= 7 ? 2 : 1);
    assert.equal(approvalsRequired(n), Math.floor(n / 2) + 1);
    assert.equal(nextSeat(n - 1, n), 0);
    assert.equal(nextSeat(0, n), 1);
  }
  assert.throws(() => numEvil(4));
  assert.throws(() => numEvil(11));
  assert.throws(() => failsRequired(5, 5));
  assert.equal(teamOf('MERLIN'), 'good');
  assert.equal(teamOf('OBERON'), 'evil');
  assert.throws(() => teamOf('UNKNOWN'));
  assert.equal(LOBBY_ALPHABET.length, 23);
});

test('validateName and validateSelectedRoles', () => {
  assert.equal(validateName('ALICE'), null);
  assert.equal(validateName('A'.repeat(20)), null);
  for (const bad of ['', 'alice', 'A'.repeat(21), 'AL ICE', 'MERLIN', 'OBERON', 'ASSASSIN', 'ÄLICE', '__proto__']) {
    assert.equal(validateName(bad), 'Invalid name', bad);
  }
  assert.equal(validateSelectedRoles([]), true);
  assert.equal(validateSelectedRoles(['MERLIN', 'PERCIVAL', 'MORGANA', 'MORDRED', 'OBERON', 'ASSASSIN']), true);
  assert.equal(validateSelectedRoles(['PERCIVAL', 'MERLIN']), false, 'not in ROLES order');
  assert.equal(validateSelectedRoles(['MERLIN', 'MERLIN']), false, 'duplicate');
  assert.equal(validateSelectedRoles(['LOYAL FOLLOWER']), false, 'not selectable');
  assert.equal(validateSelectedRoles(['EVIL MINION']), false, 'not selectable');
  assert.equal(validateSelectedRoles(['KING']), false, 'unknown');
});

test('rules ignore the UI-mutable ROLES[].selected flag', () => {
  const before = ROLES.map((r) => r.selected);
  try {
    ROLES.forEach((r) => (r.selected = !r.selected));
    assert.equal(hexEncode(sha256(utf8(canon(RULES)))), RULES_HASH);
    assert.deepEqual(deriveDeck(5, ['MERLIN']).map((l) => l.role), ['EVIL MINION', 'EVIL MINION', 'MERLIN', 'LOYAL FOLLOWER', 'LOYAL FOLLOWER']);
  } finally {
    ROLES.forEach((r, i) => (r.selected = before[i]));
  }
});

test('RULES_HASH is pinned', () => {
  assert.equal(RULES_HASH, hexEncode(sha256(utf8(canon(RULES)))));
  assert.ok(Object.isFrozen(RULES) && Object.isFrozen(RULES.roles) && Object.isFrozen(RULES.roles[0]));
  assert.equal(RULES.cards.length, 13);
  assert.equal(RULES.generators.H.length, 10);
  // Changing any rule, tag or generator changes this value: update it only together with a protocol version decision.
  assert.equal(RULES_HASH, '2c981fa97b1fda01cc81cdc9cd9cde0513c17b2f4b34c8ad2619d98e115773bb');
});
