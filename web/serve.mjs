// Local static server for the web build, with the headers shared-memory
// threads need (cross-origin isolation).
//   node web/serve.mjs [port] [--game DIR] [--tailscale [httpsPort]] [--relay-tcp PORT|PATH]
// Also serves the online lobby/relay (WebSocket /net, relay.mjs); --relay-tcp adds a
// raw-TCP endpoint on 127.0.0.1 for native test builds (RT_NET=127.0.0.1:PORT).
// --tailscale publishes the server on your tailnet over HTTPS (tailscale serve,
// tailnet only) and removes that again on exit. Plain http://<tailscale ip> is
// not enough: browsers allow shared-memory threads and OPFS only on https/localhost.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUpgrade, listenRaw, roomStats } from './relay.mjs';
import { createAnalytics } from './analytics.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
// --game DIR (dev only): serve a local game folder at /__dev/game/ so the page's
// ?devimport can copy it into OPFS without the folder picker. Listens on 127.0.0.1 only.
const args = process.argv.slice(2);
const gi = args.indexOf('--game');
const gameDir = gi >= 0 ? resolve(args.splice(gi, 2)[1]) : null;
const ti = args.indexOf('--tailscale');
let tsPort = null;
if (ti >= 0) { tsPort = /^\d+$/.test(args[ti + 1] || '') ? Number(args.splice(ti, 2)[1]) : (args.splice(ti, 1), 10000); }
const ri = args.indexOf('--relay-tcp');
const rawArg = ri >= 0 ? args.splice(ri, 2)[1] : '';
const rawPort = /^\d+$/.test(rawArg) ? Number(rawArg) : rawArg;   // port or Unix socket path
const port = Number(args[0] || process.env.PORT || 8080);
function listFiles(dir, pre = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), pre + e.name + '/') : e.isFile() ? [[pre + e.name, statSync(join(dir, e.name)).size]] : []);
}
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// client logs: the page POSTs its log to /__log (see main.js); kept in build/clientlogs/
const logDir = resolve(root, '..', 'build', 'clientlogs');
const LOG_CAP = 20 << 20;
function clientLog(req, res) {
  const sid = (new URL(req.url, 'http://x').searchParams.get('s') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => { body += d; if (body.length > 1 << 20) req.destroy(); });
  req.on('end', () => {
    res.writeHead(204).end();
    if (!sid || !body) return;
    mkdirSync(logDir, { recursive: true });
    const f = join(logDir, sid + '.log');
    let size = 0; try { size = statSync(f).size; } catch { console.log(`[client] new session ${sid} (${req.socket.remoteAddress}) -> build/clientlogs/${sid}.log`); }
    if (size < LOG_CAP) appendFileSync(f, body);
    for (const l of body.split('\n')) if (/ERROR|ABORT|stall|stopped/.test(l)) console.log(`[client ${sid}] ${l.trim()}`);
  });
}

// page analytics (analytics.mjs): events in build/analytics/, summary at /__stats
const analytics = createAnalytics(resolve(root, '..', 'build', 'analytics'));

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/__event') { analytics.handleEvent(req, res); return; }
  if (url.pathname === '/__stats') { analytics.handleStats(req, res, roomStats); return; }
  if (req.method === 'POST' && url.pathname === '/__log') { clientLog(req, res); return; }
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
});
// online play: WebSocket lobby/relay at /net (see relay.mjs)
server.on('upgrade', (req, sock) => { if (new URL(req.url, 'http://x').pathname === '/net') handleUpgrade(req, sock); else sock.destroy(); });
if (rawPort) listenRaw(rawPort);
server.listen(port, '127.0.0.1', () => {
  console.log(`NFS3 web runtime: http://localhost:${port}/` + (gameDir ? `  (dev game folder: ${gameDir}, open ?devimport)` : ''));
  console.log(`stats:            http://localhost:${port}/__stats`);
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
