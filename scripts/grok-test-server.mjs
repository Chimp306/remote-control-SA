import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { mapRequestPath } from './site-paths.mjs';
import { createMemoryDb, handleGrokRequest, provisionEnrollment } from '../supabase/functions/grok-control/bridge.mjs';

const root = resolve(import.meta.dirname, '..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

export async function startGrokTestServer() {
  const db = createMemoryDb();
  const enrollment = await provisionEnrollment(db);
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (pathname === '/functions/v1/grok-control') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-headers': 'apikey,content-type,x-grok-access', 'access-control-allow-methods': 'POST,OPTIONS' });
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'POST required' }));
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { body = null; }
        const result = await handleGrokRequest({
          body,
          accessToken: String(req.headers['x-grok-access'] || ''),
          ip: '127.0.0.1',
          db,
        });
        res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
        res.end(JSON.stringify(result.body));
        return;
      }
      if (pathname.includes('..') || pathname.includes('\\') || pathname.startsWith('/supabase') || pathname.startsWith('/scripts') || pathname.startsWith('/tests') || pathname.includes('/.')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const mapped = mapRequestPath(pathname);
      if (mapped.redirect) {
        res.writeHead(302, { Location: mapped.redirect });
        res.end();
        return;
      }
      let file = resolve(root, `.${mapped.file}`);
      if (!file.startsWith(root + sep)) throw new Error('Invalid path');
      try { if (!(await stat(file)).isFile()) throw new Error(); } catch { file = resolve(root, '404.html'); }
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  return { server, port, db, enrollment, url: `http://127.0.0.1:${port}/functions/v1/grok-control` };
}
