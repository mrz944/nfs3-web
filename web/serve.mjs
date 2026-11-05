// Local static server for the web build, with the headers shared-memory
// threads need (cross-origin isolation).
//   node web/serve.mjs [port] [--game DIR] [--tailscale [httpsPort]]
// --tailscale publishes the server on your tailnet over HTTPS (tailscale serve,
// tailnet only) and removes that again on exit. Plain http://<tailscale ip> is
// not enough: browsers allow shared-memory threads and OPFS only on https/localhost.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
// --game DIR (dev only): serve a local game folder at /__dev/game/ so the page's
// ?devimport can copy it into OPFS without the folder picker. Listens on 127.0.0.1 only.
const args = process.argv.slice(2);
const gi = args.indexOf('--game');
const gameDir = gi >= 0 ? resolve(args.splice(gi, 2)[1]) : null;
const ti = args.indexOf('--tailscale');
let tsPort = null;
if (ti >= 0) { tsPort = /^\d+$/.test(args[ti + 1] || '') ? Number(args.splice(ti, 2)[1]) : (args.splice(ti, 1), 10000); }
const port = Number(args[0] || process.env.PORT || 8080);
function listFiles(dir, pre = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), pre + e.name + '/') : e.isFile() ? [[pre + e.name, statSync(join(dir, e.name)).size]] : []);
}
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  let base = root;
  if (gameDir && path === '__dev/game-list') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.end(JSON.stringify(listFiles(gameDir))); return;
  }
  if (gameDir && path.startsWith('__dev/game/')) { base = gameDir; path = path.slice('__dev/game/'.length); }
  const file = join(base, path);
  if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (st.isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`NFS3 web runtime: http://localhost:${port}/` + (gameDir ? `  (dev game folder: ${gameDir}, open ?devimport)` : ''));
  if (tsPort) startTailscale();
});

function startTailscale() {
  const ts = (...a) => execFileSync('tailscale', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    ts('serve', '--bg', `--https=${tsPort}`, `http://127.0.0.1:${port}`);
    const name = JSON.parse(ts('status', '--json')).Self.DNSName.replace(/\.$/, '');
    console.log(`tailnet:          https://${name}${tsPort === 443 ? '' : ':' + tsPort}/` + (gameDir ? '?devimport&autostart' : ''));
  } catch (e) {
    console.error('tailscale serve failed:', (e.stderr || e.message).trim());
    console.error('(if it asks for permission: sudo tailscale set --operator=$USER)');
    return;
  }
  const off = () => { try { ts('serve', `--https=${tsPort}`, 'off'); } catch {} process.exit(0); };
  process.on('SIGINT', off); process.on('SIGTERM', off);
}
