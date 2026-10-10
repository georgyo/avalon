// Public GUN relays the clients dial in addition to this relay
// (docs/p2p-protocol.md §7.1, §8). They are advertised in /api/relay-info, so
// the list can change without rebuilding the client, and clients cache it.
//
// Public relays are as untrusted as this one: every protocol message is a
// signed, content-addressed envelope that clients verify themselves. They add
// availability (a game continues when this relay is down) at the cost of
// showing the public game data and the players' IP addresses to their
// operators. They do not run this relay's input filter.

/**
 * Community relays (https://github.com/amark/gun/wiki/volunteer.dht). These
 * come and go: set GUN_PUBLIC_PEERS to curate the list for a deployment.
 */
export const DEFAULT_PUBLIC_PEERS: readonly string[] = Object.freeze([
  'https://relay.peer.ooo/gun',
  'https://peer.wallie.io/gun',
  'https://gun.defucc.me/gun',
]);

/** At most this many public peers are advertised. */
export const MAX_PUBLIC_PEERS = 8;

const MAX_URL_LENGTH = 200;

/** Loopback hosts may use plain http/ws (development and tests). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A relay URL clients may dial: https/wss (http/ws only on loopback), no credentials, query or fragment. */
export function isPeerUrl(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const plain = u.protocol === 'http:' || u.protocol === 'ws:';
  if (!secure && !(plain && LOOPBACK.has(u.hostname))) return false;
  return u.username === '' && u.password === '' && u.search === '' && u.hash === '';
}

/**
 * Parses GUN_PUBLIC_PEERS: unset gives the default list; a comma- or
 * whitespace-separated list of URLs replaces it; '' or 'none' disables public
 * peers. Invalid entries are reported and skipped.
 */
export function parsePublicPeers(env: string | undefined, warn: (msg: string) => void = console.warn): string[] {
  if (env === undefined) return [...DEFAULT_PUBLIC_PEERS];
  const trimmed = env.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return [];
  const peers: string[] = [];
  for (const entry of trimmed.split(/[\s,]+/)) {
    if (entry === '') continue;
    if (!isPeerUrl(entry)) {
      warn(`GUN_PUBLIC_PEERS: ignoring invalid relay URL ${JSON.stringify(entry)}`);
      continue;
    }
    if (!peers.includes(entry)) peers.push(entry);
  }
  if (peers.length > MAX_PUBLIC_PEERS) {
    warn(`GUN_PUBLIC_PEERS: only the first ${MAX_PUBLIC_PEERS} relays are advertised`);
    peers.length = MAX_PUBLIC_PEERS;
  }
  return peers;
}
