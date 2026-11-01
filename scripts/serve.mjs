import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const portArgument = process.argv.indexOf('--port');
const port = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT || 3000);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml' };
createServer(async (req,res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if (pathname.includes('..') || pathname.includes('\\') || pathname.startsWith('/supabase') || pathname.startsWith('/scripts') || pathname.startsWith('/tests') || pathname.includes('/.')) {res.writeHead(404);res.end();return;}
    let file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep)) throw new Error('Invalid path');
    try { if (!(await stat(file)).isFile()) throw new Error(); } catch { file = resolve(root,'404.html'); }
    res.writeHead(200, {'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(await readFile(file));
  } catch { res.writeHead(404);res.end('Not found'); }
}).listen(port,'0.0.0.0',()=>console.log(`Local: http://localhost:${port}`));
