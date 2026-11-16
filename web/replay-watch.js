// Replays for the lap records (replays.mjs on the server), page side.
//
// Each lap the page sends carries its race's id: a new one at every race's first lap. The game
// writes replay.rp3 (its replay of the last race, the one its Replay button plays) at the end of
// every race that isn't online. When the file changes after a race whose laps went to the lap
// records, it goes to the server too, linked to those laps. The page can't see the game's memory,
// so it looks at the file every few seconds.

const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
export function raceTracker() {
  let race = null;
  return {
    // the race a lap belongs to
    forLap(track, flags, lap, laps) {
      const f = flags & 15;
      if (!race || lap === 1 || race.track !== track || race.f !== f || race.laps !== laps || lap <= race.lap) {
        const b = crypto.getRandomValues(new Uint8Array(8));
        race = { id: [...b].map((x) => ABC[x % ABC.length]).join('') + Date.now().toString(36).slice(-4), track, f, laps, lap: 0, sent: 0, replay: false };
      }
      race.lap = lap;
      return race;
    },
    get current() { return race; },
  };
}

// dir: the game's folder (OPFS); race(): the current race; key(): the player key (token);
// skip(): true while mods are on
export async function watchReplay({ dir, race, key, skip = () => false, log = () => {}, every = 4000 }) {
  const read = async () => { try { return await (await dir.getFileHandle('replay.rp3')).getFile(); } catch { return null; } };
  const digest = async (file) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
  const f = await read();
  let stamp = f ? f.lastModified : 0, seen = f ? await digest(f).catch(() => '') : '', busy = false;
  async function look() {
    if (busy) return;
    busy = true;
    try {
      const g = await read();
      if (!g || g.lastModified === stamp) return;
      stamp = g.lastModified;
      const h = await digest(g).catch(() => null);
      if (!h || h === seen) return;
      seen = h;
      const r = race();
      log(`replay: the game wrote replay.rp3 (${g.size} bytes)${r ? `, race ${r.id}: ${r.sent} lap(s) sent` : ''}${skip() ? ', mods on' : ''}`);
      if (!r || !r.sent || r.replay || skip() || !key()) return;
      r.replay = true;
      const res = await fetch(`__replay?race=${r.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-player-key': key() }, body: await g.arrayBuffer() });
      const d = await res.json().catch(() => ({}));
      log(res.ok ? `replay: sent, linked to the laps of race ${r.id}` : `replay: not taken (${d.error || res.status})`);
    } catch (e) { log('replay: not sent:', e.message); } finally { busy = false; }
  }
  const timer = setInterval(look, every);
  return { look, stop: () => clearInterval(timer) };
}
