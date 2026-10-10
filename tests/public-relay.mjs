// A stand-in for a public community GUN relay (docs/p2p-protocol.md §7.1): a
// plain `gun` relay with its default options (AXE on) and none of this app's
// input filter. tests/e2e-stack.mjs starts one and advertises it through the
// own relay's GUN_PUBLIC_PEERS, so every e2e run plays over two relays.
//
//   node tests/public-relay.mjs <port> <radisk dir>

import { createServer } from 'node:http';
import { createRequire } from 'node:module';

// CommonJS resolution: `gun/sea` is both sea.js and the sea/ directory, which ESM resolution rejects.
const require = createRequire(import.meta.url);
const Gun = require('gun');
require('gun/sea');

const port = Number(process.argv[2] || 8765);
const file = process.argv[3] || 'public-relay-radata';

const server = createServer((req, res) => {
  res.statusCode = 404;
  res.end();
});
Gun.log.off = true;
Gun({ web: server, file, multicast: false, stats: false });
server.listen(port, '127.0.0.1', () => {
  console.log(`public relay stand-in listening on port ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 300).unref();
  });
}
