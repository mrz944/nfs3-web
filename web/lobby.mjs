// The room as the race's lobby (docs/web-lobby-plan.md): the race the room's owner sets up, each
// player's car and Ready, the chat, the countdown and the choice of host. relay.mjs keeps the
// rooms and the sockets; this file keeps what the room says about the next race. No dependencies.
//
// Messages (on top of relay.mjs's):
//   -> {t:'race', race:{...}}          owner: change the race          <- {t:'race', race}
//   -> {t:'me', car, trans, color, ready, dl, mods}                     <- {t:'me', id, ...}
//   -> {t:'chat', text}                                                 <- {t:'chat', line}
//   -> {t:'go'} / {t:'hold'}           owner: start now / stop or resume the countdown
//   -> {t:'pin', id}                   owner: this player hosts (null: the site picks)
//   -> {t:'kick', id}                  owner: out of the room for 10 minutes  <- {t:'kicked'} to them
//                                                                       <- {t:'phase', phase, left, held, launch}
//   welcome carries all of it as `lobby` (lobbyState()).

// The game's online race settings, as its lobby menus offer them (game/fedata/menus/mainmult.mnu,
// location.mnu, opponent.mnu, level.mnu; names from fedata/text/text.eng). [value, label] pairs;
// the first is the default. To be checked against the running game (plan, Phase 0).
const ONOFF = [[0, 'Off'], [1, 'On']];
export const TRACKS = ['Hometown', 'Redrock Ridge', 'Atlantica', 'Rocky Pass', 'Country Woods', 'Lost Canyons', 'Aquatica', 'The Summit', 'Empire City'];
export const SPEC = [
  { key: 'type', label: 'Race', opts: [['single', 'Single Race']] },
  { key: 'track', label: 'Track', opts: TRACKS.map((t, i) => [i, t]) },
  { key: 'laps', label: 'Laps', opts: [[2, '2'], [4, '4'], [6, '6'], [8, '8']] },
  { key: 'dir', label: 'Direction', opts: [['fwd', 'Forward'], ['back', 'Backward']] },
  { key: 'mirror', label: 'Mirrored', opts: ONOFF },
  { key: 'night', label: 'Night', opts: ONOFF },
  { key: 'weather', label: 'Weather', opts: ONOFF },
  { key: 'cls', label: 'Car class', opts: [['any', 'Any class'], ['A', 'Class A'], ['B', 'Class B'], ['C', 'Class C']] },
  { key: 'opp', label: 'AI opponents', opts: [['none', 'None'], ['one', 'One'], ['full', 'Full grid']] },
  { key: 'oppSkill', label: 'AI skill', opts: [['beginner', 'Beginner'], ['expert', 'Expert']] },
  { key: 'oppCar', label: 'AI car', opts: [['random', 'Random']], car: true },
  { key: 'traffic', label: 'Traffic', opts: [['none', 'None'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'aBrake', label: 'Braking assist', opts: ONOFF, assist: true },
  { key: 'aCollision', label: 'Collision recovery', opts: ONOFF, assist: true },
  { key: 'aTraction', label: 'Traction assist', opts: ONOFF, assist: true },
  { key: 'aLine', label: 'Best line', opts: ONOFF, assist: true },
  { key: 'aNav', label: 'Navigator', opts: ONOFF, assist: true },
];
export const DEFAULT_RACE = Object.fromEntries(SPEC.map((s) => [s.key, s.opts[0][0]]));
const CAR = /^[a-z0-9]{2,8}$/;            // a car's folder name in gamedata/carmodel

// a change from the owner: only known keys and allowed values; returns the labels of what changed
export function changeRace(race, patch) {
  const changed = [];
  if (!patch || typeof patch !== 'object') return changed;
  for (const s of SPEC) {
    if (!(s.key in patch)) continue;
    let v = patch[s.key];
    const ok = s.opts.some(([o]) => o === v) || (s.car && typeof v === 'string' && CAR.test(v));
    if (!ok || race[s.key] === v) continue;
    race[s.key] = v;
    changed.push(`${s.label}: ${s.opts.find(([o]) => o === v)?.[1] ?? v}`);
  }
  return changed;
}

// a player's own choices; only what was sent changes
export function changeMe(c, m) {
  const out = {};
  if (typeof m.car === 'string' && CAR.test(m.car)) out.car = m.car;
  if (m.trans === 'auto' || m.trans === 'manual') out.trans = m.trans;
  if (Number.isInteger(m.color) && m.color >= 0 && m.color < 16) out.color = m.color;
  if (typeof m.ready === 'boolean') out.ready = m.ready;
  if (m.dl === null || (Number.isInteger(m.dl) && m.dl >= 0 && m.dl <= 100)) out.dl = m.dl;
  if (typeof m.mods === 'boolean') out.mods = m.mods;
  Object.assign(c, out);
  return out;
}
export const memberView = (c) => ({ car: c.car || '', trans: c.trans || 'auto', color: c.color || 0, ready: !!c.ready, dl: c.dl ?? null, mods: !!c.mods });

// ---------------------------------------------------------------- chat
const CHAT_KEEP = 50, CHAT_MAX = 200;
const BANNED = ['nigg', 'fagg', 'hitler', 'nazi', 'kike', 'retard', 'rape', 'pedo', 'cunt', 'whore', 'chink', 'spic'];
const leet = (s) => s.toLowerCase().replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');
const mask = (t) => t.replace(/\S+/g, (w) => (BANNED.some((b) => leet(w).includes(b)) ? '*'.repeat(w.length) : w));
// a chat line from a member, or a reason it was dropped (limits: 1 a second, 20 a minute, no
// repeats within 10 s)
export function chatLine(c, text) {
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
  if (!t) return null;
  const now = Date.now();
  if (now - (c.chatLast || 0) < 1000) return null;
  c.chatTimes = (c.chatTimes || []).filter((x) => now - x < 60e3);
  if (c.chatTimes.length >= 20) return null;
  if (t === c.chatText && now - c.chatLast < 10e3) return null;
  c.chatLast = now; c.chatText = t; c.chatTimes.push(now);
  return { id: c.id, n: c.name, text: mask(t), ts: now };
}

// ---------------------------------------------------------------- the room's lobby
export function lobbyInit(room) {
  Object.assign(room, {
    race: { ...DEFAULT_RACE }, chat: [], phase: 'waiting', ends: 0, started: 0, held: 0,
    pin: null, launch: null, timer: null, kicked: new Map(), ownerId: null,
  });
}
const others = (room) => [...room.members.values()];
const toRoom = (room, o) => { const s = JSON.stringify(o); for (const c of room.members.values()) c.sendText(s); };
export function say(room, text) {                       // a system line (made here, so it can't be faked)
  const line = { sys: true, text, ts: Date.now() };
  room.chat.push(line); if (room.chat.length > CHAT_KEEP) room.chat.shift();
  toRoom(room, { t: 'chat', line });
}
export function addChat(room, line) {
  room.chat.push(line); if (room.chat.length > CHAT_KEEP) room.chat.shift();
  toRoom(room, { t: 'chat', line });
}
const phaseMsg = (room) => ({
  t: 'phase', phase: room.phase, held: !!room.held, pin: room.pin, owner: room.ownerId,
  left: room.phase === 'countdown' ? Math.max(0, room.held || room.ends - Date.now()) : 0,
  launch: room.launch && { id: room.launch.id, host: room.launch.host, seats: room.launch.seats, race: room.launch.race },
});
export const sendPhase = (room) => toRoom(room, phaseMsg(room));
export function lobbyState(room) {
  const { t, ...p } = phaseMsg(room);
  return { ...p, race: room.race, chat: room.chat, spec: SPEC, members: Object.fromEntries(others(room).map((c) => [c.id, memberView(c)])) };
}
// the browser's line about a room: the race, how many are ready, what's going on
export const roomRace = (room) => ({
  phase: room.phase, ready: others(room).filter((c) => c.ready).length,
  track: room.race.track, laps: room.race.laps, dir: room.race.dir, mirror: room.race.mirror, night: room.race.night, weather: room.race.weather, cls: room.race.cls,
});

// The countdown: it runs while 2 or more are ready. 20 s; +5 s for each new Ready (60 s at most
// from its start); 5 s once everyone in the room is ready. The owner can stop it (hold) or start
// at once (go: 3 s).
const ready = (room) => others(room).filter((c) => c.ready && c.state !== 'game');
export function recount(room, added = false) {
  if (room.phase === 'launch' || room.phase === 'racing') return;
  const now = Date.now(), r = ready(room);
  if (r.length < 2) {
    if (room.phase === 'countdown') { clearTimeout(room.timer); room.phase = 'waiting'; room.held = 0; say(room, 'Countdown stopped: fewer than 2 players ready.'); sendPhase(room); }
    return;
  }
  const first = room.phase === 'waiting';
  if (first) { room.phase = 'countdown'; room.started = now; room.ends = now + 20e3; room.held = 0; }
  else if (added && !room.held) room.ends = Math.min(room.started + 60e3, room.ends + 5e3);
  if (r.length === room.members.size && !room.held) room.ends = Math.min(room.ends, now + 5e3);
  if (first) say(room, `${r.length} players ready: the race starts in ${Math.round((room.ends - now) / 1000)} seconds.`);
  schedule(room);
  sendPhase(room);
}
function schedule(room) {
  clearTimeout(room.timer);
  if (room.phase !== 'countdown' || room.held) return;
  room.timer = setTimeout(() => launch(room), Math.max(0, room.ends - Date.now()));
  room.timer.unref?.();
}
export function hold(room, by) {
  if (room.phase !== 'countdown') return;
  if (room.held) { room.ends = Date.now() + room.held; room.held = 0; say(room, `${by} let the countdown run again.`); }
  else { room.held = Math.max(1000, room.ends - Date.now()); say(room, `${by} stopped the countdown.`); }
  schedule(room); sendPhase(room);
}
export function go(room, by) {
  if (ready(room).length < 2) return;
  if (room.phase === 'waiting') recount(room);
  if (room.phase !== 'countdown') return;
  room.held = 0; room.ends = Math.min(room.ends, Date.now() + 3e3);
  say(room, `${by} started the race.`);
  schedule(room); sendPhase(room);
}

// The host: the ready player whose slowest link to the others is the shortest, counting each
// member's reported round trips (net.js shareRtts), frame rate, and links that go through TURN or
// this server (they stall more: docs/netcode-two-paths-plan.md). The owner's pin wins.
export function pickHost(room, seats) {
  if (room.pin && seats.includes(room.pin)) return room.pin;
  const info = (id) => room.members.get(id)?.info || {};
  let best = null;
  for (const a of seats) {
    let worst = 0;
    for (const b of seats) if (a !== b) {
      const r = info(a).rtt?.[b] ?? info(b).rtt?.[a];
      const kind = info(a).links?.[b] ?? info(b).links?.[a];
      const cost = (r ?? 400) + (kind === 'turn' ? 80 : kind === 'relay' ? 40 : 0);
      worst = Math.max(worst, cost);
    }
    const fps = info(a).fps;
    worst += fps ? Math.max(0, 1000 / fps - 1000 / 60) * 4 : 0;
    if (!best || worst < best.worst || (worst === best.worst && a < best.id)) best = { id: a, worst };   // a tie: the same pick on every page
  }
  return best?.id ?? seats[0];
}
let launches = 0;
function launch(room) {
  const seats = ready(room).map((c) => c.id);
  if (seats.length < 2) { room.phase = 'waiting'; sendPhase(room); return; }
  const host = pickHost(room, seats);
  room.launch = { id: `${Date.now().toString(36)}${(++launches).toString(36)}`, host, seats, race: { ...room.race }, at: Date.now() };
  room.phase = 'launch';
  const name = room.members.get(host)?.name || 'someone';
  say(room, `The race is on: ${name} hosts, ${seats.length} players.`);
  sendPhase(room);
  // nobody got into the game: back to waiting
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { if (room.phase === 'launch') raceOver(room, 'The race didn\'t start.'); }, 120e3);
  room.timer.unref?.();
  room.onLaunch?.(room);
}
// a member's game started or stopped (relay.mjs 'state')
export function gameState(room) {
  const seats = room.launch?.seats || [];
  const inGame = seats.filter((id) => room.members.get(id)?.state === 'game');
  if (room.phase === 'launch' && inGame.length) { room.phase = 'racing'; clearTimeout(room.timer); sendPhase(room); }
  else if (room.phase === 'racing' && !inGame.length) raceOver(room, 'Race over: back in the room.');
}
function raceOver(room, text) {
  clearTimeout(room.timer);
  for (const id of room.launch?.seats || []) { const c = room.members.get(id); if (c) { c.ready = false; toRoom(room, { t: 'me', id, ...memberView(c) }); } }
  room.launch = null; room.phase = 'waiting';
  say(room, text);
  sendPhase(room);
  recount(room);
}
// a member left: the owner moves on, the countdown is counted again, the race may be over
export function memberLeft(room, c) {
  if (room.pin === c.id) room.pin = null;
  if (room.ownerId === c.id) {
    const next = room.members.values().next().value;
    room.ownerId = next?.id || null; room.owner = next?.name || '';
    if (next) say(room, `${next.name} runs the room now.`);
  }
  if (room.launch) { room.launch.seats = room.launch.seats.filter((id) => id !== c.id); if (room.phase === 'racing' || room.phase === 'launch') gameState(room); }
  recount(room);
  if (room.members.size) sendPhase(room);
}
export function stopTimers(room) { clearTimeout(room.timer); clearTimeout(room.setTimer); }
// the owner's changes to the race, as one chat line once they stop for a moment
export function raceChanged(room, by, changed) {
  room.setLines ||= new Map();
  for (const c of changed) room.setLines.set(c.split(':')[0], c);
  clearTimeout(room.setTimer);
  room.setTimer = setTimeout(() => { if (room.setLines.size) say(room, `${by} set ${[...room.setLines.values()].join(', ')}.`); room.setLines.clear(); }, 1500);
  room.setTimer.unref?.();
}
