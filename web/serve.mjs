// Local static server for the web build, with the headers shared-memory
// threads need (cross-origin isolation).
//   node web/serve.mjs [port] [--game DIR] [--daily HH:MM] [--tailscale [httpsPort]] [--funnel [httpsPort]] [--relay-tcp PORT|PATH] [--data DIR]
// --data DIR: where logs, stats, lap records, players and push subscriptions live (default:
// build/ next to web/); tests point it at a folder of their own.
// --daily HH:MM: a daily race at that time (server clock): shown on the start page, with push
// notifications 10 minutes before and at the start.
// --staging: a closed test site (staging.nfs3.xyz, tools/staging.sh): a password page in front of
// everything, the password in <data>/staging-password (made on first start); also noindex and a
// STAGING ribbon on the page.
// --funnel publishes the page, WebAssembly build and configured game files publicly.
// Also serves the online lobby/relay (WebSocket /net, relay.mjs); --relay-tcp adds a
// raw-TCP endpoint on 127.0.0.1 for native test builds (RT_NET=127.0.0.1:PORT).
// --tailscale publishes the server on your tailnet over HTTPS (tailscale serve,
// tailnet only) and removes that again on exit. Plain http://<tailscale ip> is
// not enough: browsers allow shared-memory threads and OPFS only on https/localhost.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp, foreignOrigin, handleUpgrade, listenRaw, liveSummary, onRoomCreated, roomStats, setPlayers, setPlayLog } from './relay.mjs';
import { createPush, dailyRace } from './push.mjs';
import { createAnalytics } from './analytics.mjs';
import { createLaps } from './laps.mjs';
import { createPlayers, foldName } from './players.mjs';
import { playersSection } from './player-stats.mjs';
import { createReplays } from './replays.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
let data = resolve(root, '..', 'build');          // --data DIR (below) moves it
// --game DIR: serve game files for automatic browser download into OPFS.
// The HTTP listener stays on loopback; Tailscale provides public HTTPS.
const args = process.argv.slice(2);
const gi = args.indexOf('--game');
const gameDir = gi >= 0 ? resolve(args.splice(gi, 2)[1]) : null;
const ti = args.indexOf('--tailscale');
let tsPort = null;
if (ti >= 0) { tsPort = /^\d+$/.test(args[ti + 1] || '') ? Number(args.splice(ti, 2)[1]) : (args.splice(ti, 1), 10000); }
const fi = args.indexOf('--funnel');
const funnel = fi >= 0;
if (funnel) { tsPort = /^\d+$/.test(args[fi + 1] || '') ? Number(args.splice(fi, 2)[1]) : (args.splice(fi, 1), 443); }
const di = args.indexOf('--daily');
const dailyAt = di >= 0 ? args.splice(di, 2)[1] : '';
const ri = args.indexOf('--relay-tcp');
const rawArg = ri >= 0 ? args.splice(ri, 2)[1] : '';
const rawPort = /^\d+$/.test(rawArg) ? Number(rawArg) : rawArg;   // port or Unix socket path
const si = args.indexOf('--staging');
const staging = si >= 0; if (staging) args.splice(si, 1);
const dai = args.indexOf('--data');
const dataDir = dai >= 0 ? resolve(args.splice(dai, 2)[1]) : null;
if (dataDir) data = dataDir;
const port = Number(args[0] || process.env.PORT || 8080);
function listFiles(dir, pre = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), pre + e.name + '/') : e.isFile() ? [[pre + e.name, statSync(join(dir, e.name)).size]] : []);
}
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// client logs: the page POSTs its log to /__log (see main.js); kept in build/clientlogs/.
// Bounded: 20 MiB per session, 2 GiB in all (new sessions are dropped past that), and at
// most 30 new sessions per address per hour.
const logDir = join(data, 'clientlogs');
const LOG_CAP = 20 << 20, LOG_TOTAL = 2 ** 31, LOG_NEW_PER_HOUR = 30;
let logBytes = 0;
try { for (const f of readdirSync(logDir)) logBytes += statSync(join(logDir, f)).size; } catch {}
const newLogs = new Map();                                  // address -> [count, hour]
const printable = (l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?');   // no terminal escapes from players
function clientLog(req, res) {
  const sid = (new URL(req.url, 'http://x').searchParams.get('s') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  if (foreignOrigin(req)) { res.writeHead(403).end(); req.resume(); return; }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => { body += d; if (body.length > 1 << 20) req.destroy(); });
  req.on('end', () => {
    res.writeHead(204).end();
    if (!sid || !body) return;
    try {
      mkdirSync(logDir, { recursive: true });
      const f = join(logDir, sid + '.log');
      let size = 0; try { size = statSync(f).size; } catch {
        const ip = clientIp(req), hour = Math.floor(Date.now() / 3600e3), n = newLogs.get(ip);
        const count = n && n[1] === hour ? n[0] + 1 : 1;
        if (newLogs.size > 10000) newLogs.clear();
        newLogs.set(ip, [count, hour]);
        if (count > LOG_NEW_PER_HOUR || logBytes > LOG_TOTAL) return;
        console.log(`[client] new session ${sid} -> build/clientlogs/${sid}.log`);
      }
      if (size < LOG_CAP) { appendFileSync(f, body); logBytes += Buffer.byteLength(body); }
      for (const l of body.split('\n')) if (/ERROR|ABORT|stall|stopped/.test(l)) console.log(`[client ${sid}] ${printable(l.trim()).slice(0, 400)}`);
    } catch (e) { console.log('[client] log write failed:', e.message); }
  });
}

// /__stats is for the server's owner: HTTP Basic auth, any user name, the password from
// NFS3_STATS_PASSWORD or build/stats-password (made on first start, readable only by you).
const statsPassword = (() => {
  if (process.env.NFS3_STATS_PASSWORD) return process.env.NFS3_STATS_PASSWORD;
  const f = join(data, 'stats-password');
  try { return readFileSync(f, 'utf8').trim(); } catch {}
  const pw = randomBytes(15).toString('base64url');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, pw + '\n', { mode: 0o600 });
  return pw;
})();
const statsFails = new Map();                               // address -> [failures, 10-minute window]
function statsAllowed(req, res) {
  const ip = clientIp(req), win = Math.floor(Date.now() / 600e3), f = statsFails.get(ip);
  if (f && f[1] === win && f[0] >= 20) { res.writeHead(429, { 'Retry-After': '600' }).end('Too many attempts'); return false; }
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  const given = m ? Buffer.from(m[1], 'base64').toString().replace(/^[^:]*:/, '') : '';
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(statsPassword).digest();
  if (m && timingSafeEqual(a, b)) return true;
  if (m) { if (statsFails.size > 10000) statsFails.clear(); statsFails.set(ip, [f && f[1] === win ? f[0] + 1 : 1, win]); }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NFS3 stats", charset="UTF-8"', 'Cache-Control': 'no-store' }).end('Password required');
  return false;
}

// --staging: one shared password for testers. The password page gives a cookie (so the
// WebSocket, the workers and the game download pass too); the cookie is a hash of the password,
// so changing the password file and restarting logs everyone out.
const stagingPassword = (() => {
  if (!staging) return '';
  const f = join(data, 'staging-password');
  try { return readFileSync(f, 'utf8').trim(); } catch {}
  const pw = randomBytes(9).toString('base64url');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, pw + '\n', { mode: 0o600 });
  return pw;
})();
const stagingToken = staging ? createHash('sha256').update('nfs3-staging:' + stagingPassword).digest('base64url') : '';
function stagingIn(req) {
  const m = /(?:^|;\s*)nfs3staging=([\w-]+)/.exec(req.headers.cookie || '');
  return !!m && m[1].length === stagingToken.length && timingSafeEqual(Buffer.from(m[1]), Buffer.from(stagingToken));
}
const stagingPage = (wrong) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>NFS3 staging</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:16px system-ui,sans-serif}
form{display:grid;gap:10px;padding:24px;width:min(320px,calc(100vw - 32px));box-sizing:border-box}input,button{font:inherit;padding:10px;border-radius:6px;border:1px solid #555;background:#222;color:#eee}
button{background:#c90;color:#111;border:0;font-weight:600}p{margin:0;color:#aaa;font-size:14px}.bad{color:#f77}</style>
<form method="post" action="/__staging"><b>NFS3 staging</b><p>A test site for new features. Ask the owner for the password.</p>
${wrong ? '<p class="bad">Wrong password.</p>' : ''}<input type="password" name="pw" autocomplete="current-password" autofocus required><button>Enter</button></form>`;
function stagingGate(req, res, url) {
  if (url.pathname === '/__staging' && req.method === 'POST') {
    const ip = clientIp(req), win = Math.floor(Date.now() / 600e3), f = statsFails.get(ip);
    if (f && f[1] === win && f[0] >= 20) { res.writeHead(429, { 'Retry-After': '600' }).end('Too many attempts'); req.resume(); return false; }
    let body = ''; req.setEncoding('utf8');
    req.on('data', (d) => { body += d; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      const given = new URLSearchParams(body).get('pw') || '';
      const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(stagingPassword).digest();
      if (timingSafeEqual(a, b)) {
        res.writeHead(303, { Location: '/', 'Set-Cookie': `nfs3staging=${stagingToken}; Path=/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax`, 'Cache-Control': 'no-store' }).end();
      } else {
        if (statsFails.size > 10000) statsFails.clear();
        statsFails.set(ip, [f && f[1] === win ? f[0] + 1 : 1, win]);
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(stagingPage(true));
      }
    });
    return false;
  }
  if (stagingIn(req)) return true;
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(stagingPage(false));
  req.resume();
  return false;
}
const STAGING_RIBBON = '<div style="position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;background:#c90;color:#111;font:700 11px/1 system-ui,sans-serif;letter-spacing:.1em;padding:4px 10px;border-radius:0 0 6px 6px;pointer-events:none">STAGING</div>';

// room log: every 5 s, each room with 2+ players (names, state, ping to this server),
// next to the client logs as build/clientlogs/room-<code>.log, for looking into lag later
setInterval(() => {
  for (const r of roomStats()) {
    if (r.players.length < 2) continue;
    mkdirSync(logDir, { recursive: true });
    const line = `${new Date().toISOString()} ${r.racing ? 'racing' : 'lobby'} host=${r.host ?? '?'} ` +
      r.players.map((p) => `${p.name}${p.p ? `(${p.p})` : ''}:${p.state}:${p.rtt != null ? Math.round(p.rtt) + 'ms' : '?'}`).join(' ') + '\n';
    try { appendFileSync(join(logDir, `room-${r.code.replace(/[^a-z0-9]/gi, '')}.log`), line); } catch {}
  }
}, 5000).unref();

// Versioned script URLs. Cloudflare gives .js files its own browser cache time (4 h by default,
// whatever we send), so a browser could keep yesterday's nfs3.js and pair it with today's
// nfs3.wasm, which crashes at the first frame. So every script address the page uses carries
// ?v=<build>: index.html and our .js files are rewritten on the way out, and a new build means
// new addresses. Inside dist/nfs3.js the same goes for "nfs3.js" (its game threads load it
// again) and "nfs3.wasm". sw.js keeps a fixed address (a service worker is identified by it).
const SCRIPTS = ['main.js', 'mods.js', 'net.js', 'net-worker.js', 'audio-worklet.js', 'opfs.js', 'opfs-writer.js', 'replay-watch.js', 'dist/nfs3.js'];
let verCache = { t: 0, v: '' };
function version() {
  if (Date.now() - verCache.t < 2000) return verCache.v;
  const h = createHash('sha256');
  for (const f of [...SCRIPTS, 'index.html', 'dist/nfs3.wasm', 'dist/build-info.json']) { try { const st = statSync(join(root, f)); h.update(`${f}:${st.size}:${st.mtimeMs}`); } catch {} }
  verCache = { t: Date.now(), v: h.digest('hex').slice(0, 10) };
  return verCache.v;
}
function versioned(text) {
  const v = version();
  return text.replace(/(["'])(\.\/)?(main\.js|mods\.js|net\.js|net-worker\.js|audio-worklet\.js|opfs\.js|opfs-writer\.js|replay-watch\.js|dist\/nfs3\.js|nfs3\.js|nfs3\.wasm)\1/g, (m, q, dot, f) => `${q}${dot || ''}${f}?v=${v}${q}`);
}

// players (players.mjs): a name, its laps and its logs, tied to the page's player key
const players = createPlayers(join(data, 'players'));
setPlayers(players);

// page analytics (analytics.mjs): events in build/analytics/, summary at /__stats; an event
// that comes with a player key is stored with that player's id
const analytics = createAnalytics(join(data, 'analytics'), { player: (k) => players.idOfToken(k) });
const playDir = join(data, 'analytics');
setPlayLog(playDir);

// lap records (laps.mjs): POST /__lap from the game page, GET /__laps for the start page
const laps = createLaps(join(data, 'laps'), players);
// replays of the races the best laps were driven in (replays.mjs): POST /__replay, GET /__replay/<race>.rp3
const replays = createReplays(join(data, 'replays'), { players, laps });
const playersStats = playersSection({ players, laps, playDir, logDir, sessionsDir: join(data, 'players') });

// push notifications (push.mjs) and the daily race
const push = createPush(join(data, 'push'));
onRoomCreated((r) => push.roomOpened(r));
const daily = dailyAt ? dailyRace(dailyAt, (m) => push.notify(m)) : null;
if (dailyAt && !daily) { console.error('--daily needs HH:MM'); process.exit(1); }

// start page activity (/__live): who is online now, the most active racers (time spent in
// online games, from relay.mjs play-*.jsonl; per player, under the current name, or per name
// for time from before player keys), the daily race and the current build
let topCache = { t: 0, v: null };
function topRacers() {
  if (Date.now() - topCache.t < 60e3) return topCache.v;
  const now = Date.now(), win = { '24h': 864e5, '7d': 7 * 864e5, all: Infinity }, sums = { '24h': new Map(), '7d': new Map(), all: new Map() };
  try {
    for (const f of readdirSync(playDir).filter((f) => f.startsWith('play-'))) {
      for (const line of readFileSync(join(playDir, f), 'utf8').split('\n')) {
        let r; try { r = JSON.parse(line); } catch { continue; }
        const lo = r.p ? null : players.legacyOwner(foldName(r.n));
        const who = r.p ? players.resolve(r.p) : lo === undefined ? 'n:' + foldName(r.n) : lo;
        if (!who) continue;
        for (const k in win) if (now - r.t < win[k]) { const o = sums[k].get(who) || { s: 0, n: r.n }; o.s += r.s; o.n = r.n; sums[k].set(who, o); }
      }
    }
  } catch {}
  const v = {};
  for (const k in sums) v[k] = [...sums[k]].sort((a, b) => b[1].s - a[1].s).slice(0, 10)
    .map(([who, o]) => ({ n: who.startsWith('n:') ? o.n : players.nameOf(who) || o.n, ...(who.startsWith('n:') ? {} : { p: who }), min: Math.round(o.s / 60) }));
  topCache = { t: Date.now(), v };
  return v;
}
function live(res) {
  let build = '';
  try { build = JSON.parse(readFileSync(join(root, 'dist', 'build-info.json'), 'utf8')).built || ''; } catch {}
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(JSON.stringify({ ...liveSummary(), top: topRacers(), daily: daily ? { next: daily.next(), time: daily.time } : null, build }));
}

// ICE servers for the page's WebRTC links (/__ice). A third of the direct links never come up
// (both players behind strict routers) and fall back to this server, which is far from many
// players. With a Cloudflare TURN key in build/cloudflare/turn.json ({"id": ..., "token": ...},
// from the dashboard's Realtime > TURN; free up to 1 TB a month) the page also gets TURN
// servers on Cloudflare's edge near each player: short-lived credentials, minted here and
// renewed before they expire, never the key itself. Without the file: STUN only, as before.
const turnFile = join(data, 'cloudflare', 'turn.json');
const ICE_TTL = 6 * 3600;
let iceCache = { until: 0, servers: null, pending: null };
async function iceServers() {
  if (iceCache.servers && Date.now() < iceCache.until - 1800e3) return iceCache.servers;
  if (iceCache.pending) return iceCache.pending;
  let key = null;                                   // read on every miss, so a key added later is found
  try { key = JSON.parse(readFileSync(turnFile, 'utf8')); } catch {}
  if (!key?.id || !key?.token) return null;
  iceCache.pending = (async () => {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key.id)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + key.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: ICE_TTL }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      const servers = [].concat(j.iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53\b/.test(u)) }));
      if (!servers.length) throw new Error('no iceServers in the answer');
      iceCache = { until: Date.now() + ICE_TTL * 1000, servers, pending: null };
      return servers;
    } catch (e) {
      console.log('[ice] TURN credentials not available:', e.message);
      if (iceCache.servers && Date.now() < iceCache.until) return iceCache.servers;   // keep the old ones to the end
      return null;
    } finally { iceCache.pending = null; }
  })();
  return iceCache.pending;
}
async function ice(req, res) {
  if (foreignOrigin(req)) { res.writeHead(403).end(); return; }
  const servers = await iceServers();
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=600', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(JSON.stringify({ iceServers: servers || [], turn: !!servers }));
}

// served on every response
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
// never served even though they sit in web/: the server's own modules and dotfiles
const PRIVATE = (path) => /\.mjs$/i.test(path) || path.split(/[/\\]/).some((p) => p.startsWith('.'));
const realRoots = new Map();
const realRoot = (b) => { if (!realRoots.has(b)) realRoots.set(b, realpathSync(b)); return realRoots.get(b); };

const server = createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end('bad request'); return; }
  if (staging) { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); if (!stagingGate(req, res, url)) return; }
  if (req.method === 'POST' && url.pathname === '/__event') {
    if (foreignOrigin(req)) { res.writeHead(403).end(); req.resume(); return; }
    analytics.handleEvent(req, res); return;
  }
  if (url.pathname === '/__stats') { if (statsAllowed(req, res)) analytics.handleStats(req, res, roomStats, playersStats); return; }
  if (['/__me', '/__name', '/__merge', '/__forget'].includes(url.pathname)) { players.handle(req, res, url); return; }
  if (req.method === 'POST' && url.pathname === '/__log') { clientLog(req, res); return; }
  if (url.pathname === '/__live') { live(res); return; }
  if (url.pathname === '/__ice') { ice(req, res); return; }
  if (req.method === 'POST' && url.pathname === '/__lap') { laps.handlePost(req, res); return; }
  if (url.pathname === '/__laps') { laps.handleGet(req, res); return; }
  if (req.method === 'POST' && url.pathname === '/__replay') { replays.handlePost(req, res, url); return; }
  if (url.pathname.startsWith('/__replay/')) { replays.handleGet(req, res, url); return; }
  if (url.pathname.startsWith('/__push/')) {
    if (req.method === 'POST' && foreignOrigin(req)) { res.writeHead(403).end(); req.resume(); return; }
    push.handle(req, res, url.pathname.slice(1)); return;
  }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('invalid path'); return; }
  let path = normalize(decoded).replace(/^([/\\])+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  let base = root;
  if (gameDir && path === '__dev/game-list') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.end(JSON.stringify(listFiles(gameDir))); return;
  }
  if (gameDir && path.startsWith('__dev/game/')) { base = gameDir; path = path.slice('__dev/game/'.length); }
  const file = join(base, path);
  if (!file.startsWith(base + sep) || (base === root && PRIVATE(path))) { res.writeHead(404).end('not found'); return; }
  let st;
  try {
    st = statSync(file);
    const real = realpathSync(file);                          // a symlink must not lead out of the tree
    if (!real.startsWith(realRoot(base) + sep)) throw new Error('outside');
  } catch { res.writeHead(404).end('not found'); return; }
  if (st.isDirectory()) { res.writeHead(404).end(); return; }
  // the page and our own scripts: script addresses get ?v=<build> (see versioned())
  const rewrite = base === root && (path === 'index.html' || SCRIPTS.includes(path));
  // An address with this build's ?v= (versioned()) never changes content, so the browser keeps
  // it. That matters most for nfs3.wasm (18 MB): it came again at every Start, and with it kept
  // Chrome also keeps the compiled game. Everything else is checked each time, with an ETag so
  // an unchanged file costs a 304.
  const pinned = base === root && (path === 'dist/nfs3.wasm' || SCRIPTS.includes(path)) && url.searchParams.get('v') === version();
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${rewrite ? '-' + version() : ''}"`;
  const head = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // (staging: private, so Cloudflare's cache never hands a file past the password page)
    'Cache-Control': pinned ? `${staging ? 'private' : 'public'}, max-age=31536000, immutable` : staging ? 'private, no-cache' : 'no-cache',
    ETag: etag,
  };
  // (Cloudflare makes the ETag weak when it compresses)
  if (String(req.headers['if-none-match'] || '').split(/,\s*/).some((t) => t.replace(/^W\//, '') === etag)) { res.writeHead(304, head).end(); return; }
  let text = rewrite ? versioned(readFileSync(file, 'utf8')) : null;
  if (text && staging && path === 'index.html') text = text.replace('</body>', STAGING_RIBBON + '</body>');
  const body = text != null ? Buffer.from(text) : null;
  res.writeHead(200, {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Content-Length': body ? body.length : st.size,
    ...head,
  });
  if (req.method === 'HEAD') { res.end(); return; }
  if (rewrite) { res.end(body); return; }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
});
// online play: WebSocket lobby/relay at /net (see relay.mjs)
server.on('upgrade', (req, sock) => {
  let path = ''; try { path = new URL(req.url, 'http://x').pathname; } catch {}
  if (staging && !stagingIn(req)) { sock.destroy(); return; }
  if (path === '/net') handleUpgrade(req, sock); else sock.destroy();
});
// last line of defence: a bug in a request handler is logged, not the end of every race
process.on('uncaughtException', (e) => console.error('[server] uncaught error (still running):', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection (still running):', e?.stack || e));
if (rawPort) listenRaw(rawPort);
server.listen(port, '127.0.0.1', () => {
  console.log(`NFS3 web runtime: http://localhost:${port}/` + (gameDir ? `  (game folder: ${gameDir}, automatic download)` : ''));
  console.log(`stats:            http://localhost:${port}/__stats  (password: ${process.env.NFS3_STATS_PASSWORD ? '$NFS3_STATS_PASSWORD' : dataDir ? join(data, 'stats-password') : 'build/stats-password'})`);
  if (staging) console.log(`staging:          closed with a password (${join(data, 'staging-password')})`);
  if (daily) console.log(`daily race:       ${daily.time} (server time), next ${new Date(daily.next()).toString().slice(0, 21)}; ${push.count} push subscriber(s)`);
  if (funnel && ![443, 8443, 10000].includes(tsPort)) { console.error('Funnel only works on ports 443, 8443 and 10000'); process.exit(1); }
  if (tsPort) startTailscale();
});

async function startTailscale() {
  const ts = (...a) => execFileSync('tailscale', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    // Activation can wait for account approval: keep serving and show the activation URL.
    await new Promise((resolve, reject) => {
      const child = spawn('tailscale', [funnel ? 'funnel' : 'serve', '--bg', `--https=${tsPort}`, `http://127.0.0.1:${port}`], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Tailscale exited with code ${code}`)));
    });
    const name = JSON.parse(ts('status', '--json')).Self.DNSName.replace(/\.$/, '');
    const base = `https://${name}${tsPort === 443 ? '' : ':' + tsPort}/`;
    if (funnel) {
      console.log(`funnel:           ${base}  (public; game files and WebAssembly are served)`);
    } else console.log(`tailnet:          ${base}` + (gameDir ? '  (game files download automatically)' : ''));
  } catch (e) {
    console.error(`tailscale ${funnel ? 'funnel' : 'serve'} failed:`, (e.stderr || e.message).trim());
    if (funnel) console.error('(Funnel must be allowed for this machine in the tailnet policy: https://tailscale.com/kb/1223/funnel)');
    console.error('(if it asks for permission: sudo tailscale set --operator=$USER)');
    return;
  }
  const off = () => { try { ts(funnel ? 'funnel' : 'serve', `--https=${tsPort}`, 'off'); } catch {} process.exit(0); };
  process.on('SIGINT', off); process.on('SIGTERM', off);
}
