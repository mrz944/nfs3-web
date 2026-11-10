// Lap records for the start page: the best lap per player on every track, each direction.
//
// The game page reports each lap the player finishes (POST /__lap, see reportLap() in main.js;
// the runtime reads the lap off the game, runtime/game.c). Every lap is appended to
// build/laps/laps-YYYY-MM.jsonl; GET /__laps gives the boards: per track and direction, each
// name's best lap, fastest first. Times are in the game's own 1/64 s ticks.
// Laps driven with mods on never get here (the page doesn't send them). The page sends them,
// so a determined cheat can post anything: the checks below only keep out nonsense.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { badName, cleanName, clientIp, foreignOrigin } from './relay.mjs';

export const FLAG = { backward: 1, mirrored: 2, night: 4, weather: 8, instant: 16 };
const TOP = 20;
const MIN_TICKS = 64 * 20, MAX_TICKS = 64 * 60 * 20;   // 20 s .. 20 min a lap

export function createLaps(dir) {
  mkdirSync(dir, { recursive: true });
  const boards = new Map();           // "track:dir" -> Map(name -> best lap record)
  let cache = null;

  function add(r) {
    const key = `${r.track}:${r.f & FLAG.backward ? 'b' : 'f'}`;
    if (!boards.has(key)) boards.set(key, new Map());
    const b = boards.get(key), had = b.get(r.n);
    if (!had || r.ticks < had.ticks) { b.set(r.n, r); cache = null; return true; }
    return false;
  }
  for (const f of readdirSync(dir).filter((f) => /^laps-.*\.jsonl$/.test(f)).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try { add(JSON.parse(line)); } catch {}
    }
  }

  const recent = new Map();           // ip -> [count, 10-minute window]
  function handlePost(req, res) {
    if (foreignOrigin(req)) { res.writeHead(403).end(); req.resume(); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      const ip = clientIp(req), win = Math.floor(Date.now() / 600e3), c = recent.get(ip);
      if (c && c[1] === win && c[0] >= 40) { res.writeHead(429).end(); return; }
      if (recent.size > 10000) recent.clear();
      recent.set(ip, [c && c[1] === win ? c[0] + 1 : 1, win]);
      let m; try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
      const n = cleanName(m?.n);
      if (!n || badName(n) || !int(m.track, 0, 63) || !int(m.f, 0, 31) || !int(m.lap, 1, 8) || !int(m.laps, 1, 8) || m.lap > m.laps
          || !int(m.ticks, MIN_TICKS, MAX_TICKS) || typeof m.car !== 'string' || !/^[a-z0-9]{1,4}$/.test(m.car)) { res.writeHead(400).end(); return; }
      const r = { t: Date.now(), n, track: m.track, f: m.f, car: m.car, ticks: m.ticks, lap: m.lap, laps: m.laps, b: String(m.b || '').slice(0, 24) };
      try { appendFileSync(join(dir, `laps-${new Date().toISOString().slice(0, 7)}.jsonl`), JSON.stringify(r) + '\n'); } catch (e) { console.log('[laps] write failed:', e.message); }
      const best = add(r);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ best }));
    });
  }

  function handleGet(req, res) {
    if (!cache) {
      const out = {};
      for (const [key, b] of boards) out[key] = [...b.values()].sort((x, y) => x.ticks - y.ticks || x.t - y.t).slice(0, TOP)
        .map((r) => ({ n: r.n, car: r.car, ticks: r.ticks, f: r.f, t: r.t }));
      cache = JSON.stringify({ boards: out });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.end(cache);
  }
  return { handlePost, handleGet };
}
