// The online room as the race's lobby (docs/web-lobby-plan.md; the server side is lobby.mjs):
// the race the owner sets up, each player's car, gearbox and colour, Ready and the countdown, the
// host, the chat (in the room and over the running game).
//
// The cars, their classes and colours come from the player's own game files (gamedata/carmodel
// in the browser's storage), so they follow the Mods switch and nothing from the game is in this
// file.

const CAR_NAMES = {
  '456g': 'Ferrari 456M GT', amd7: 'Aston Martin DB7', corv: 'Chevrolet Corvette', cout: 'Lamborghini Countach', diab: 'Lamborghini Diablo SV',
  elni: 'El Niño', f355: 'Ferrari 355 F1 Spider', ffal: 'Ford Falcon GT', fm50: 'Ferrari 550 Maranello', hgts: 'HSV VT GTS', jxjr: 'Jaguar XJR-15',
  jxk8: 'Jaguar XK8', jxkr: 'Jaguar XKR', lcop: 'Pursuit Diablo SV', lstm: 'Lister Storm', merc: 'Mercedes CLK-GTR',
  peln: 'Pursuit El Niño', scig: 'Italdesign Scighera', sl60: 'Mercedes SL600', sr42: 'Spectre R42', vcop: 'Pursuit Corvette', walm: "'98 Indy 500 Pace Car",
};
const CLASS = ['A', 'B', 'C'];
export const carName = (c) => CAR_NAMES[c] || String(c || '').toUpperCase();

// ---------------------------------------------------------------- the game's cars
// car.viv (a BIGF archive): carp.txt has "Car Classification" (0 = A, 1 = B, 2 = C, 3 = not a
// race car); car.fce has the paint colours (count at 0x7fc, then H, S, B, T as 32-bit values).
async function readViv(file, want) {
  const head = new DataView(await file.slice(0, 16).arrayBuffer());
  const n = head.getUint32(8), hlen = head.getUint32(12);
  const dir = new Uint8Array(await file.slice(16, Math.min(file.size, hlen + 16)).arrayBuffer());
  const dv = new DataView(dir.buffer), out = {};
  for (let i = 0, o = 0; i < n && o + 8 < dir.length; i++) {
    const off = dv.getUint32(o), len = dv.getUint32(o + 4); o += 8;
    let e = o; while (e < dir.length && dir[e]) e++;
    const name = String.fromCharCode(...dir.subarray(o, e)).toLowerCase(); o = e + 1;
    if (want.includes(name)) out[name] = file.slice(off, off + len);
  }
  return out;
}
const hsb = (h, s, v) => {
  h = (h / 255) * 360; s /= 255; v /= 255;
  const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('');
};
// { code: { cls: 'A'|'B'|'C', colors: ['#rrggbb', ...] } } from the game files, or null without them
export async function gameCars(gameDir) {
  let models;
  try { models = await (await (await gameDir()).getDirectoryHandle('gamedata')).getDirectoryHandle('carmodel'); } catch { return null; }
  const cars = {};
  for await (const [code, h] of models.entries()) {
    if (h.kind !== 'directory' || code === 'traffic') continue;
    try {
      const v = await readViv(await (await h.getFileHandle('car.viv')).getFile(), ['carp.txt', 'car.fce']);
      const lines = (await v['carp.txt'].text()).split(/\r?\n/);
      const k = lines.findIndex((l) => /^Car Classification/i.test(l));
      const cls = CLASS[Number(lines[k + 1])];
      if (!cls) continue;
      const colors = [];
      if (v['car.fce']) {
        const f = new DataView(await v['car.fce'].slice(0, 0x900).arrayBuffer());
        const n = f.byteLength >= 0x800 ? Math.min(16, f.getUint32(0x7fc, true)) : 0;
        for (let i = 0; i < n; i++) { const o = 0x800 + i * 16; colors.push(hsb(f.getUint32(o, true), f.getUint32(o + 4, true), f.getUint32(o + 8, true))); }
      }
      cars[code.toLowerCase()] = { cls, colors };
    } catch {}
  }
  return Object.keys(cars).length ? cars : null;
}

// ---------------------------------------------------------------- the room
// deps: net, $, el, flagged(name, cc), pingClass(ms), myName(), gameDir(), gameReady() (the files
// are here), modsOn() (async), gameRunning(), log(...)
export function setupRoom(d) {
  const { net, $, el } = d;
  let cars = null;                    // gameCars()
  let mine = { car: '', trans: 'auto', color: 0 };
  try { Object.assign(mine, JSON.parse(localStorage.getItem('nfs3.car') || '{}')); } catch {}
  const saveMine = () => { try { localStorage.setItem('nfs3.car', JSON.stringify(mine)); } catch {} };
  let mods = false;

  const L = () => net.lobby;
  const spec = (k) => L()?.spec?.find((s) => s.key === k);
  const optLabel = (k, v) => spec(k)?.opts.find(([o]) => o === v)?.[1] ?? (k === 'oppCar' ? carName(v) : String(v));
  const memberOf = (id) => L()?.members?.[id] || {};
  const nameOf = (id) => (id === net.id ? d.myName() || 'You' : net.peers.get(id)?.name || '?');
  const ids = () => [net.id, ...net.peers.keys()];
  const readyIds = () => ids().filter((id) => memberOf(id).ready);

  // ---- my car: the cars the class allows
  function allowed() {
    const cls = L()?.race?.cls || 'any';
    const all = cars ? Object.keys(cars) : Object.keys(CAR_NAMES).filter((c) => !/cop$|^peln$/.test(c));
    const key = (c) => carName(c).replace(/^\W+/, '');
    return all.filter((c) => cls === 'any' || !cars || cars[c].cls === cls).sort((a, b) => key(a).localeCompare(key(b)));
  }
  function fixCar(send = true) {
    const ok = allowed();
    let changed = false;
    if (!ok.includes(mine.car)) { mine.car = ['diab', 'fm50', 'f355', 'corv', 'jxk8'].find((c) => ok.includes(c)) || ok[0] || ''; mine.color = 0; changed = true; }
    const n = cars?.[mine.car]?.colors.length || 0;
    if (n && mine.color >= n) { mine.color = 0; changed = true; }
    if (changed) saveMine();
    if (send && (changed || !memberOf(net.id).car)) net.setMe({ car: mine.car, trans: mine.trans, color: mine.color });
  }
  async function loadCars() {
    cars = await gameCars(d.gameDir).catch(() => null);
    mods = await d.modsOn().catch(() => false);
    if (net.id) { fixCar(); net.setMe({ mods, dl: d.gameReady() ? 100 : 0 }); draw(); }
  }

  // ---- drawing
  const swatch = (c) => el('i', { className: 'swatch', style: `background:${c}` });
  function drawRace() {
    const l = L(); if (!l) return;
    const own = net.isOwner && (l.phase === 'waiting' || l.phase === 'countdown');
    const r = l.race;
    $('race-track').textContent = optLabel('track', r.track);
    $('race-sub').textContent = [`${r.laps} laps`, r.dir === 'back' ? 'Backward' : '', r.mirror ? 'Mirrored' : '', r.night ? 'Night' : '', r.weather ? 'Weather' : '', r.cls !== 'any' ? optLabel('cls', r.cls) : ''].filter(Boolean).join(' · ');
    const box = $('race-opts');
    // keep the open select (a redraw while choosing would close it)
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    box.textContent = '';
    const main = el('div', { className: 'ropts' }), assists = el('div', { className: 'ropts' });
    for (const s of l.spec) {
      let opts = s.opts;
      if (s.car) opts = [...s.opts, ...allowed().map((c) => [c, carName(c)])];
      const sel = el('select', { disabled: !own, title: own ? '' : 'The room\'s owner sets up the race' });
      for (const [v, t] of opts) sel.append(el('option', { value: JSON.stringify(v), textContent: t, selected: v === r[s.key] }));
      sel.onchange = () => {
        const v = JSON.parse(sel.value);
        net.setRace({ [s.key]: v });
        try { localStorage.setItem('nfs3.race', JSON.stringify({ ...r, [s.key]: v })); } catch {}   // Quick Race makes rooms with it
      };
      (s.assist ? assists : main).append(el('label', {}, el('span', { textContent: s.label }), sel));
    }
    box.append(main, el('details', { className: 'assists' }, el('summary', { textContent: 'Driving assists' }), assists));
    const owner = l.owner === net.id ? 'You set up the race.' : `${nameOf(l.owner)} sets up the race.`;
    $('race-note').textContent = `${owner} The game takes these settings once the automatic start is in (staging: coming next).`;
  }
  function drawCar() {
    const sel = $('my-car');
    if (document.activeElement !== sel) {
      sel.textContent = '';
      for (const c of allowed()) sel.append(el('option', { value: c, textContent: `${carName(c)}${cars ? ` (${cars[c].cls})` : ''}`, selected: c === mine.car }));
    }
    $('my-trans').value = mine.trans;
    const cols = cars?.[mine.car]?.colors || [];
    $('my-colors').replaceChildren(...cols.map((c, i) => {
      const b = el('button', { type: 'button', className: 'sw' + (i === mine.color ? ' on' : ''), title: `Colour ${i + 1}`, ariaLabel: `Colour ${i + 1}`, ariaPressed: String(i === mine.color) }, swatch(c));
      b.onclick = () => { mine.color = i; saveMine(); net.setMe({ color: i }); drawCar(); };
      return b;
    }));
    $('my-colors-none').hidden = cols.length > 0;
    $('car-note').hidden = !!cars;
  }
  function memberRow(id) {
    const me = id === net.id, m = memberOf(id), p = net.peers.get(id), l = L();
    const racing = l?.launch?.seats?.includes(id) && (l.phase === 'launch' || l.phase === 'racing');
    const status = racing ? ['racing', 'Racing'] : m.ready ? ['ready', 'Ready'] : m.dl != null && m.dl < 100 ? ['dl', 'No game files yet'] : ['wait', 'Not ready'];
    const who = el('span', { className: 'who' }, d.flagged(me ? `${nameOf(id)} (you)` : nameOf(id), me ? net.cc : p?.cc));
    if (l?.owner === id) who.append(el('span', { className: 'tag', textContent: 'owner', title: 'Sets up the race' }));
    if (l?.pin === id) who.append(el('span', { className: 'tag race', textContent: 'host', title: 'The owner picked this player to host' }));
    if (m.mods) who.append(el('span', { className: 'tag', textContent: 'mods', title: 'Mods are on in this browser' }));
    const col = cars?.[m.car]?.colors?.[m.color];
    const car = el('span', { className: 'car' }, ...(col ? [swatch(col)] : []), m.car ? `${carName(m.car)} · ${m.trans === 'manual' ? 'Manual' : 'Auto'}` : '…');
    let link = '';
    if (me) link = net.relayRtt != null ? `server ${Math.round(net.relayRtt)} ms` : '';
    const ping = el('span', { className: 'ping' });
    if (!me && p) {
      const r = net.rttTo(p);
      ping.append(el('span', { className: r != null ? d.pingClass(r) : 'muted', textContent: r != null ? `${Math.round(r)} ms` : '…' }),
        el('span', { className: 'muted', textContent: ` ${p.direct ? (p.turn ? 'TURN' : 'direct') : 'server'}` }));
    } else ping.append(el('span', { className: 'muted', textContent: link }));
    const li = el('li', { className: `m-${status[0]}${me ? ' me' : ''}` },
      el('span', { className: 'light', title: status[1] }), who, el('span', { className: 'st', textContent: status[1] }), car, ping);
    if (net.isOwner && !me) {
      const menu = el('details', { className: 'mmenu' }, el('summary', { textContent: '⋯', title: 'Owner' }));
      const pin = el('button', { type: 'button', className: 'small secondary', textContent: l?.pin === id ? 'Let the site pick the host' : 'Make host' });
      pin.onclick = () => net.pin(l?.pin === id ? null : id);
      const kick = el('button', { type: 'button', className: 'small secondary', textContent: 'Remove from room' });
      kick.onclick = () => { if (confirm(`Remove ${nameOf(id)} from the room for 10 minutes?`)) net.kick(id); };
      menu.append(el('div', {}, pin, kick));
      li.append(menu);
    } else if (net.isOwner && me) {
      const menu = el('details', { className: 'mmenu' }, el('summary', { textContent: '⋯', title: 'Owner' }));
      const pin = el('button', { type: 'button', className: 'small secondary', textContent: l?.pin === id ? 'Let the site pick the host' : 'Make me host' });
      pin.onclick = () => net.pin(l?.pin === id ? null : id);
      menu.append(el('div', {}, pin)); li.append(menu);
    }
    return li;
  }
  function drawMembers() {
    const ul = $('members');
    if (ul.contains(document.activeElement) || ul.querySelector('details[open]')) return;   // an open owner menu stays open
    ul.replaceChildren(...ids().map(memberRow));
    if (!net.peers.size) ul.append(el('li', { className: 'empty' }, aloneNote()));
  }
  // Waiting alone in a room: others find it with Quick Race or the link. With the page out of
  // sight, the browser can say when someone comes in.
  const JOIN_NOTE = 'nfs3.joinNote';
  const joinNote = () => { try { return localStorage.getItem(JOIN_NOTE) === '1' && Notification.permission === 'granted'; } catch { return false; } };
  function aloneNote() {
    const box = el('div', { className: 'alone' }, el('span', { className: 'muted', textContent: 'Waiting for others: anyone who clicks Quick Race comes here, or send a friend the invite link.' }));
    if ('Notification' in window && Notification.permission !== 'denied') {
      const on = joinNote();
      const b = el('button', { type: 'button', className: 'small secondary', textContent: on ? '🔔 You\'ll be told when someone joins (click to stop)' : '🔔 Tell me when someone joins' });
      b.onclick = async () => {
        if (joinNote()) { try { localStorage.removeItem(JOIN_NOTE); } catch {} }
        else if ((await Notification.requestPermission()) === 'granted') { try { localStorage.setItem(JOIN_NOTE, '1'); } catch {} }
        drawMembers();
      };
      box.append(el('br'), b);
    }
    return box;
  }
  let knownPeers = null;                  // null: not in a room (the players already there when we come in aren't news)
  net.addEventListener('status', () => {
    if (!net.id) { knownPeers = null; return; }
    const now = new Set(net.peers.keys());
    if (knownPeers && document.hidden && joinNote()) for (const id of now) if (!knownPeers.has(id)) {
      try { new Notification(`${net.peers.get(id)?.name || 'Someone'} joined your room`, { body: 'Back to the page to race.', tag: 'nfs3-join', icon: 'icons/icon-192.png' }); } catch {}
    }
    knownPeers = now;
  });
  // the host the site would pick now (the server decides at the start, the same way)
  function hostGuess() {
    const l = L(); if (!l) return null;
    if (l.launch) return { id: l.launch.host, why: 'hosts this race' };
    if (l.pin) return { id: l.pin, why: 'picked by the owner' };
    const seats = readyIds().length >= 2 ? readyIds() : ids();
    if (seats.length < 2) return null;
    let best = null;
    for (const a of seats) {
      let worst = 0;
      for (const b of seats) if (a !== b) {
        const r = net.pingTable.get(a)?.[b] ?? net.pingTable.get(b)?.[a];
        const pa = a === net.id ? net.peers.get(b) : b === net.id ? net.peers.get(a) : null;
        const kind = pa ? (pa.direct ? (pa.turn ? 'turn' : 'direct') : 'relay') : null;
        worst = Math.max(worst, (r ?? 400) + (kind === 'turn' ? 80 : kind === 'relay' ? 40 : 0));
      }
      worst += net.hostCost(a);
      if (!best || worst < best.worst || (worst === best.worst && a < best.id)) best = { id: a, worst };   // ties as on the server
    }
    return best && { id: best.id, why: 'best connection to everyone' };
  }
  function drawBar() {
    const l = L(); if (!l) return;
    const n = ids().length, r = readyIds().length, me = memberOf(net.id);
    const seat = l.launch?.seats?.includes(net.id);
    let text;
    if (l.phase === 'countdown') text = l.held ? `Countdown stopped by ${nameOf(l.owner)} · ${r} of ${n} ready` : `Race in ${Math.ceil(net.countdownLeft / 1000)} s · ${r} of ${n} ready`;
    else if (l.phase === 'launch') text = `Starting: ${nameOf(l.launch.host)} hosts`;
    else if (l.phase === 'racing') text = `Racing (${l.launch.seats.length} players)${seat ? '' : ': you are in the next race'}`;
    else text = n < 2 ? 'Waiting for players' : `${r} of ${n} ready · the race starts when 2 are ready`;
    $('cd-text').textContent = text;
    $('cd-text').className = l.phase === 'countdown' && !l.held ? 'live' : '';
    const btn = $('ready-btn');
    const files = d.gameReady();
    btn.disabled = !files || (seat && (l.phase === 'launch' || l.phase === 'racing'));
    btn.textContent = !files ? 'Download the game first' : seat && l.phase !== 'waiting' && l.phase !== 'countdown' ? 'Racing…' : me.ready ? 'Ready ✓' : (l.phase === 'racing' ? 'Ready for the next race' : 'Ready');
    btn.classList.toggle('on', !!me.ready);
    btn.title = me.ready ? 'Click to be not ready' : '';
    $('owner-ctl').hidden = !net.isOwner || !(l.phase === 'waiting' || l.phase === 'countdown');
    $('go-now').disabled = r < 2;
    $('hold-cd').disabled = l.phase !== 'countdown';
    $('hold-cd').textContent = l.held ? 'Resume' : 'Wait';
    const h = hostGuess();
    $('best-host').textContent = h ? `Host: ${h.id === net.id ? 'you' : nameOf(h.id)} (${h.why})` : '';
  }
  function drawChat() {
    const box = $('chat-lines'), atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
    box.replaceChildren(...(L()?.chat || []).map(chatLine));
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
  const muted = new Set(); try { for (const p of JSON.parse(localStorage.getItem('nfs3.muted') || '[]')) muted.add(p); } catch {}
  function chatLine(line) {
    const t = new Date(line.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (line.sys) return el('div', { className: 'cl sys' }, el('time', { textContent: t }), line.text);
    if (muted.has(line.n)) return el('div', { className: 'cl sys' }, el('time', { textContent: t }), `${line.n}: (muted)`);
    const me = line.id === net.id, mention = !me && d.myName() && line.text.toLowerCase().includes(d.myName().toLowerCase());
    const who = el('b', { textContent: line.n, title: me ? '' : 'Click to mute or unmute' });
    if (!me) who.onclick = () => { if (muted.has(line.n)) muted.delete(line.n); else muted.add(line.n); try { localStorage.setItem('nfs3.muted', JSON.stringify([...muted])); } catch {} drawChat(); };
    return el('div', { className: `cl${me ? ' me' : ''}${mention ? ' mention' : ''}` }, el('time', { textContent: t }), who, ' ', line.text);
  }
  function draw() {
    const inRoom = !!net.id && !!L();
    $('room-grid').hidden = !inRoom; $('ready-bar').hidden = !inRoom;
    if (!inRoom) return;
    drawRace(); drawCar(); drawMembers(); drawBar();
  }

  // ---- inputs
  $('my-car').onchange = () => { mine.car = $('my-car').value; mine.color = 0; saveMine(); net.setMe({ car: mine.car, color: 0 }); drawCar(); };
  $('my-trans').onchange = () => { mine.trans = $('my-trans').value; saveMine(); net.setMe({ trans: mine.trans }); };
  $('ready-btn').onclick = () => { const r = !memberOf(net.id).ready; fixCar(); net.setMe({ ready: r }); };
  $('go-now').onclick = () => net.goNow();
  $('hold-cd').onclick = () => net.hold();
  // the server takes 1 line a second and drops a repeat within 10 s: such a line stays in the box
  let sentAt = 0, sentText = '';
  function sendChat() {
    const inp = $('chat-in'), v = inp.value.trim();
    if (!v) return;
    const now = Date.now();
    if (now - sentAt < 1100 || (v === sentText && now - sentAt < 10e3)) {
      const note = $('chat-note');
      note.textContent = v === sentText ? 'That line was just sent: change it or wait a few seconds.' : 'One line a second: Enter again in a moment.';
      note.hidden = false; clearTimeout(sendChat.t); sendChat.t = setTimeout(() => { note.hidden = true; }, 2500);
      return;
    }
    $('chat-note').hidden = true;
    net.say(v); sentAt = now; sentText = v; inp.value = '';
  }
  $('chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
  $('chat-in').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } });

  net.addEventListener('lobby', () => { if (net.id && !memberOf(net.id).car) fixCar(); draw(); });
  net.addEventListener('status', draw);
  net.addEventListener('chat', (e) => { drawChat(); overlay(e.detail); });
  net.addEventListener('kicked', () => d.message?.('The room\'s owner removed you from the room.'));
  let wasIn = false;
  net.addEventListener('status', () => {
    if (net.id && !wasIn) { wasIn = true; fixCar(); net.setMe({ trans: mine.trans, color: mine.color, mods, dl: d.gameReady() ? 100 : 0 }); drawChat(); loadCars(); }
    if (!net.id) wasIn = false;
  });
  setInterval(() => { if (net.id && L()?.phase === 'countdown') drawBar(); }, 250);
  // the game files arriving (or going) changes Ready and the car list
  let had = d.gameReady();
  setInterval(() => { const h = d.gameReady(); if (h !== had) { had = h; loadCars(); drawBar(); } }, 2000);

  // ---- the chat over the running game: new lines for 8 s; ` or the button opens the input
  let ov = null;
  function overlayBox() {
    if (ov) return ov;
    ov = el('div', { id: 'chat-ov' },
      el('div', { id: 'chat-ov-lines' }),
      el('form', { id: 'chat-ov-form', hidden: true }, el('input', { id: 'chat-ov-in', maxLength: 200, placeholder: 'Chat (Enter sends, Esc closes)', autocomplete: 'off' })),
      el('button', { id: 'chat-ov-btn', type: 'button', title: 'Chat (` key)', textContent: '💬' }, el('span', { id: 'chat-ov-n' })));
    document.body.append(ov);
    const inp = ov.querySelector('#chat-ov-in'), form = ov.querySelector('#chat-ov-form');
    const close = () => { form.hidden = true; inp.blur(); unread = 0; badge(); };
    const open = () => { window.dispatchEvent(new Event('blur')); form.hidden = false; inp.focus(); unread = 0; badge(); };
    ov.querySelector('#chat-ov-btn').onclick = () => (form.hidden ? open() : close());
    form.onsubmit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (v) net.say(v); inp.value = ''; close(); };
    // the game never sees what is typed here
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } });
    inp.addEventListener('keyup', (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' && d.gameRunning() && net.id && form.hidden) { e.preventDefault(); e.stopImmediatePropagation(); open(); }
    }, true);
    return ov;
  }
  let unread = 0;
  const badge = () => { const b = ov?.querySelector('#chat-ov-n'); if (b) b.textContent = unread ? String(unread) : ''; };
  function overlay(line) {
    if (!d.gameRunning() || !net.id) return;
    const box = overlayBox();
    box.hidden = false;
    const row = chatLine(line);
    box.querySelector('#chat-ov-lines').append(row);
    setTimeout(() => row.classList.add('fade'), 7000);
    setTimeout(() => row.remove(), 8000);
    if (box.querySelector('#chat-ov-form').hidden && !line.sys && line.id !== net.id) { unread++; badge(); }
  }
  return { draw, overlayOn: () => { if (net.id) overlayBox().hidden = false; }, carFor: () => ({ ...mine }) };
}
