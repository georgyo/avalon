/** Lobby codes and discovery (docs/p2p-protocol.md §4.1-4.3) over a minimal in-memory transport. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeEnvelope, lobbySoul, signerFromPair, type Envelope, type Hex32, type Transport } from '@avalon/common/protocol';
import { decodeLobbyValue, discover, drawCode } from './lobbyClient.ts';
import { newPair } from './identity.ts';
import { b64uEncode, randomBytes } from '@avalon/common/crypto';

class MapTransport implements Transport {
  readonly souls = new Map<string, Map<string, string>>();
  async publish(soul: string, key: Hex32, value: string): Promise<void> {
    let m = this.souls.get(soul);
    if (m === undefined) {
      m = new Map();
      this.souls.set(soul, m);
    }
    m.set(key, value);
  }
  subscribe(soul: string, onValue: (key: string, value: string) => void): () => void {
    for (const [k, v] of this.souls.get(soul) ?? []) onValue(k, v);
    return () => undefined;
  }
  async synced(): Promise<void> {
    return undefined;
  }
}

describe('lobby client helpers', () => {
  it('codes are 4 letters of the lobby alphabet, uniformly drawn', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const c = drawCode();
      assert.match(c, /^[A-HJ-NP-TV-Z]{4}$/);
      for (const ch of c) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    assert.equal(counts.size, 23);
    for (const n of counts.values()) assert.ok(n > 200 && n < 500, 'letter frequency ' + n);
  });

  it('discovery lists the lobbies of a code; values in the wrong soul or with a wrong key are ignored', async () => {
    const t = new MapTransport();
    const signer = signerFromPair(newPair());
    const create = (code: string, name: string): { key: Hex32; value: string; msgId: Hex32 } => {
      const env: Envelope<'lobby.create'> = {
        v: 1, type: 'lobby.create', lobby: '', game: '', step: '', author: signer.pub, prev: '', t: 1,
        body: { code, name, nonce: b64uEncode(randomBytes(16)) },
      };
      return encodeEnvelope(env, signer);
    };
    const a = create('ABCD', 'ALICE');
    const b = create('ABCD', 'BOB');
    const other = create('WXYZ', 'CAROL');
    await t.publish(lobbySoul('ABCD'), a.key, a.value);
    await t.publish(lobbySoul('ABCD'), b.key, b.value);
    await t.publish(lobbySoul('ABCD'), other.key, other.value); // a create for another code
    await t.publish(lobbySoul('ABCD'), 'f'.repeat(64), a.value); // wrong key
    const found = await discover(t, 'ABCD', { timeoutMs: 50 });
    assert.deepEqual(found.candidates.map((c) => c.adminName).sort(), ['ALICE', 'BOB']);
    assert.equal(found.candidates[0].fingerprint, found.candidates[0].lobbyId.slice(0, 4).toUpperCase());
    assert.equal(decodeLobbyValue('ABCD', lobbySoul('ABCD'), 'f'.repeat(64), a.value), null);
    assert.equal(decodeLobbyValue('ABCD', lobbySoul('ABCD'), a.key, a.value)?.msgId, a.msgId);
  });
});
