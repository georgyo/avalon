// Static hosting (server/static.ts): compression and cache headers.
//
//   yarn workspace @avalon/server test

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { chooseEncoding, serveStatic } from './static';

describe('serveStatic', () => {
  let dir = '';
  let server: Server;
  let base = '';
  const js = 'console.log("avalon");\n'.repeat(400);
  const html = '<!doctype html><title>Avalon</title>' + '<p>x</p>'.repeat(300);

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'avalon-static-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), html);
    writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), js);
    writeFileSync(path.join(dir, 'assets', 'font-abc.woff2'), Buffer.alloc(4096, 7));
    writeFileSync(path.join(dir, 'assets', 'tiny-abc.css'), 'a{}');
    const app = express();
    app.use(serveStatic(dir));
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  interface Res { status: number; headers: { get(name: string): string | null }; body: Buffer; text(): string }
  /** A raw GET (fetch would decompress transparently). */
  const get = (p: string, headers: Record<string, string> = {}): Promise<Res> => new Promise((resolve, reject) => {
    const req = request(base + p, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h: IncomingHttpHeaders = res.headers;
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: { get: (n) => { const v = h[n.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(',') : v; } },
          body,
          text: () => body.toString(),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });

  it('serves hashed assets brotli-compressed and immutable for a year', async () => {
    const r = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-encoding'), 'br');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(r.headers.get('content-type') ?? '', /javascript/);
    assert.equal(r.headers.get('vary'), 'Accept-Encoding');
    const body = r.body;
    assert.ok(body.length < js.length / 4, `compressed ${body.length} of ${js.length}`);
    assert.equal(brotliDecompressSync(body).toString(), js);
    // Revalidation with the ETag.
    const again = await get('/assets/index-abc123.js', { 'accept-encoding': 'br', 'if-none-match': r.headers.get('etag') ?? '' });
    assert.equal(again.status, 304);
  });

  it('falls back to gzip, and to identity without Accept-Encoding', async () => {
    const g = await get('/assets/index-abc123.js', { 'accept-encoding': 'gzip' });
    assert.equal(g.headers.get('content-encoding'), 'gzip');
    assert.equal(gunzipSync(g.body).toString(), js);
    const plain = await get('/assets/index-abc123.js', { 'accept-encoding': 'identity' });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(plain.text(), js);
    assert.equal(plain.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  it('revalidates index.html on every visit; leaves fonts and tiny files uncompressed', async () => {
    const r = await get('/', { 'accept-encoding': 'br' });
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('content-encoding'), 'br');
    assert.equal(brotliDecompressSync(r.body).toString(), html);
    const font = await get('/assets/font-abc.woff2', { 'accept-encoding': 'br' });
    assert.equal(font.headers.get('content-encoding'), null);
    assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const tiny = await get('/assets/tiny-abc.css', { 'accept-encoding': 'br' });
    assert.equal(tiny.headers.get('content-encoding'), null);
  });

  it('never serves files outside the directory', async () => {
    const r = await get('/..%2f..%2fetc%2fpasswd', { 'accept-encoding': 'br' });
    assert.equal(r.status, 404);
  });

  it('parses Accept-Encoding', () => {
    assert.equal(chooseEncoding('gzip, br'), 'br');
    assert.equal(chooseEncoding('br;q=0, gzip'), 'gzip');
    assert.equal(chooseEncoding('identity'), null);
    assert.equal(chooseEncoding('*'), 'br');
    assert.equal(chooseEncoding(undefined), null);
  });
});
