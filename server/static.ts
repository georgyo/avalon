// Static hosting of the built SPA (docs/p2p-protocol.md §8): content-hashed
// `/assets/*` files are cached for a year (immutable), everything else
// (index.html, the favicon) is revalidated on every visit; text assets are
// served brotli- or gzip-compressed when the browser accepts it, compressed
// once per file version and kept in memory.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import express from 'express';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';

/** Extensions worth compressing (fonts and images are already compressed). */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.txt', '.map', '.ico', '.webmanifest', '.ttf', '.eot']);
const MIN_COMPRESS_BYTES = 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

type Encoding = 'br' | 'gzip';

interface Cached { mtimeMs: number; size: number; body: Buffer }

function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
}

/** The encoding to use for an `Accept-Encoding` header (q-values honoured for 0 only). */
export function chooseEncoding(accept: string | undefined): Encoding | null {
  if (accept === undefined) return null;
  const offered = new Map<string, number>();
  for (const part of accept.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    offered.set(name, q === undefined ? 1 : Number(q.slice(2)));
  }
  const ok = (e: string): boolean => (offered.get(e) ?? offered.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/**
 * The SPA's static handler: `express.static` for the files themselves, with
 * cache headers, preceded by a compressing handler for text assets.
 */
export function serveStatic(dir: string): RequestHandler[] {
  const root = path.resolve(dir);
  const cache = new Map<string, Cached>();

  const compressed = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.resolve(root, '.' + path.posix.normalize(urlPath));
    if (file !== root && !file.startsWith(root + path.sep)) return next();
    const ext = path.extname(file).toLowerCase();
    if (!COMPRESSIBLE.has(ext)) return next();
    const enc = chooseEncoding(req.headers['accept-encoding']);
    if (enc === null) return next();
    let st;
    try {
      st = statSync(file);
    } catch {
      return next();
    }
    if (!st.isFile() || st.size < MIN_COMPRESS_BYTES) return next();
    const key = file + '\0' + enc;
    let hit = cache.get(key);
    if (hit === undefined || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const raw = readFileSync(file);
      const body = enc === 'br'
        ? brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzipSync(raw, { level: 9 });
      hit = { mtimeMs: st.mtimeMs, size: st.size, body };
      cache.set(key, hit);
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${enc}"`;
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', cacheControlFor(urlPath));
    res.setHeader('ETag', etag);
    res.type(ext);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Encoding', enc);
    res.setHeader('Content-Length', String(hit.body.length));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(hit.body);
  };

  const plain = express.static(root, {
    setHeaders: (res, filePath) => {
      const rel = '/' + path.relative(root, filePath).split(path.sep).join('/');
      res.setHeader('Cache-Control', cacheControlFor(rel));
      res.setHeader('Vary', 'Accept-Encoding');
    },
  });

  return [compressed, plain];
}
