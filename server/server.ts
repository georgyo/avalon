// Avalon server: an untrusted GUN relay plus a static host for the built SPA
// (docs/p2p-protocol.md §8). It has no game logic and holds no secret: every
// protocol message is a signed, content-addressed envelope that clients verify
// themselves.
//
//   GET  /               the SPA (server/dist, built by `yarn build`)
//   GET  /api/relay-info { bootId, now }: clock sync and relay-restart detection (§7.2, §7.4)
//   GET  /healthz        liveness
//   WS   /gun            the GUN relay (SEA + input filter)
//
// Environment: PORT (default 8001), HOST (bind address, default all),
// GUN_DIR (radisk directory, default ./radata; must be writable and persistent),
// STATIC_DIR (default <this file's directory>/dist).

import './gun-shim'; // must run before gun/sea in the esbuild bundle
import Gun from 'gun';
import 'gun/sea';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, installRelayFilter, relaySelfTest, type GunFactory } from './relay';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8001);
const HOST = process.env.HOST || undefined;
const GUN_DIR = process.env.GUN_DIR ?? './radata';
const STATIC_DIR = process.env.STATIC_DIR ?? path.join(here, 'dist');

/** Random per process start: a new value tells clients to republish (§7.4). */
const bootId = randomBytes(16).toString('base64url');

// Throwaway loopback relay built from this very code: SEA and the filter must
// both work before the public relay accepts a single connection.
try {
  await relaySelfTest({ Gun: Gun as unknown as GunFactory });
  console.log('Relay self-test passed');
} catch (err) {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
});

app.get('/api/relay-info', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ bootId, now: Date.now() });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.use(express.static(STATIC_DIR));

const httpServer = createServer(app);
const gun = createRelay(httpServer, GUN_DIR, Gun as unknown as GunFactory);
installRelayFilter(gun);

httpServer.listen(PORT, HOST, () => {
  const { port } = httpServer.address() as AddressInfo;
  console.log(`Avalon relay listening on port ${port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal}: shutting down`);
  httpServer.close();
  httpServer.closeAllConnections();
  // Give radisk (250 ms write batching) time to flush.
  setTimeout(() => process.exit(0), 500).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
