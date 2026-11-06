// NFS3 Web Runtime: page side.
//  1. The hosted NFS3 files are downloaded once into OPFS (navigator.storage, origin-private).
//  2. The wasm runtime (dist/nfs3.js, built from the server game executable)
//     mounts OPFS at /opfs and runs the game in Web Workers on shared memory.
//  3. Each animation frame we upload the shared framebuffer to WebGL; input goes
//     into a lock-free ring; audio comes out of a ring through an AudioWorklet.

const $ = (id) => document.getElementById(id);
const status = (msg, err = false) => { $('status').textContent = msg; $('status').className = err ? 'err' : ''; };

// on-page log (the console is hard to reach on some devices); ?log keeps it over the game
const t0 = performance.now();
// the log is hidden unless asked for: ?log in the URL, or "Show technical log" (remembered)
const logWanted = () => { try { return new URLSearchParams(location.search).has('log') || localStorage.getItem('nfs3.log') === '1'; } catch { return false; } };
function log(...a) {
  const el = $('log'); if (!el) return;
  const line = `${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}  ${a.join(' ')}\n`;
  el.textContent = (el.textContent + line).slice(-20000);
  el.scrollTop = el.scrollHeight;
  logQueue.push(line);
  if (/ERROR|ABORT|stall/.test(line)) flushLog();
}
// every log line also goes to the server (build/clientlogs/<session>.log), so problems
// on a player's machine can be looked at afterwards
const logSession = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
const logQueue = [`session ${logSession} ${navigator.userAgent} cores=${navigator.hardwareConcurrency} ${location.href}\n`];
function flushLog(beacon = false) {
  if (!logQueue.length) return;
  const body = logQueue.join(''); logQueue.length = 0;
  const url = `__log?s=${logSession}`;
  try { if (beacon) navigator.sendBeacon(url, body); else fetch(url, { method: 'POST', body, keepalive: body.length < 60000 }).catch(() => {}); } catch {}
}
setInterval(flushLog, 3000);

// page analytics (web/analytics.mjs on our own server: no cookies, no third parties)
function track(e, d = {}) {
  const body = JSON.stringify({ e, s: logSession, d });
  try { if (!navigator.sendBeacon('__event', body)) fetch('__event', { method: 'POST', body, keepalive: true }).catch(() => {}); } catch {}
}
const pageT0 = Date.now();
let playStats = { played: false, frames: 0, ms: 0 };
track('view', { w: innerWidth, h: innerHeight, lang: navigator.language, room_link: !!location.hash.match(/room=/) });
window.addEventListener('pagehide', () => track('end', { secs: (Date.now() - pageT0) / 1000, played: playStats.played, fps: playStats.ms ? playStats.frames * 1000 / playStats.ms : 0 }));
window.addEventListener('pagehide', () => flushLog(true));
for (const k of ['log', 'warn', 'error']) { const orig = console[k].bind(console); console[k] = (...a) => { orig(...a); log(...a.map(String)); }; }
window.addEventListener('error', (e) => log('ERROR', e.message, e.filename ? `${e.filename}:${e.lineno}` : ''));
window.addEventListener('unhandledrejection', (e) => log('ERROR (promise)', e.reason?.stack || e.reason));

import { Net } from './net.js';

const GAME_DIR = 'nfs3';
const net = new Net();
const roomFromHash = () => (new URLSearchParams(location.hash.slice(1)).get('room') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const roomLink = (r) => `${location.origin}${location.pathname}#room=${r}`;
let buildInfo = null;

// ----------------------------------------------------------------- storage
async function gameDir(create = false) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(GAME_DIR, { create });
}
async function hasGame() {
  try { const d = await gameDir(); await d.getFileHandle('.download-complete'); return true; } catch { return false; }
}
async function sha256(blob) {
  const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// `node web/serve.mjs --game DIR`: the page copies that folder from the server (no folder picker)
async function serverHasGame() {
  try { const r = await fetch('__dev/game-list', { method: 'HEAD' }); return r.ok; } catch { return false; }
}
async function serverFiles() {
  const response = await fetch('__dev/game-list');
  if (!response.ok) throw new Error('Game download unavailable. Reload to retry.');
  const list = await response.json();
  return list.map(([path, size]) => ({
    name: path.split('/').at(-1), size, webkitRelativePath: 'dev/' + path,
    blob: () => fetch('__dev/game/' + path.split('/').map(encodeURIComponent).join('/')).then((r) => {
      if (!r.ok) throw new Error(`Download failed: ${path} (${r.status}). Reload to retry.`);
      return r.blob();
    }),
  }));
}

// the browser build renders through the Voodoo2 (Glide) driver -> WebGL2
const patchIni = (t) => t.replace(/^ThrashDriver\s*=.*$/mi, 'ThrashDriver=glide3x');
async function ensureIni() {
  try {
    const d = await gameDir();
    const fh = await d.getFileHandle('nfs3.ini');
    const t = await (await fh.getFile()).text(), u = patchIni(t);
    if (u !== t) { const w = await fh.createWritable(); await w.write(u); await w.close(); log('nfs3.ini: ThrashDriver=glide3x'); }
  } catch (e) { log('nfs3.ini not patched:', e.message); }
}

async function importFolder(files) {
  // webkitRelativePath = "<picked folder>/sub/file"; drop the first component.
  const list = [...files].filter((f) => {
    const name = f.name;
    return !name.startsWith('._') && name !== '.DS_Store' && f.webkitRelativePath.split('/').length > 1;
  });
  const rel = (f) => f.webkitRelativePath.split('/').slice(1).join('/');
  const exe = list.find((f) => rel(f).toLowerCase() === 'nfs3.exe');
  if (!exe) throw new Error('No nfs3.exe in that folder. Pick the folder that contains nfs3.exe, fedata and gamedata.');
  if (buildInfo?.exe_sha256) {
    status('Checking nfs3.exe…');
    const h = await sha256(exe.blob ? await exe.blob() : exe);
    if (h !== buildInfo.exe_sha256)
      throw new Error(`This build was recompiled from a different nfs3.exe (expected ${buildInfo.exe_sha256.slice(0, 12)}…, got ${h.slice(0, 12)}…).`);
  }
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry(GAME_DIR, { recursive: true }); } catch {}
  const dir = await gameDir(true);
  const total = list.reduce((s, f) => s + f.size, 0);
  let done = 0;
  $('progress').hidden = false;
  for (const f of list) {
    const parts = rel(f).split('/');
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(parts.at(-1), { create: true });
    const src = f.blob ? await f.blob() : f;
    const w = await fh.createWritable();
    if (parts.length === 1 && parts[0].toLowerCase() === 'nfs3.ini') {
      const ini = patchIni(await src.text());
      await w.write(ini);
    } else {
      await w.write(src);
    }
    await w.close();
    done += f.size;
    $('progress').value = done / total;
    status(`Copying game files… ${(done / 2 ** 20).toFixed(0)} / ${(total / 2 ** 20).toFixed(0)} MB`);
  }
  const marker = await (await dir.getFileHandle('.download-complete', { create: true })).createWritable();
  await marker.write('complete'); await marker.close();
  $('progress').hidden = true;
}

// ------------------------------------------------------------------- video
// The recompiled game renders through Glide -> our GL ES 3 renderer (runtime/gpu.c),
// which draws into this canvas with WebGL2 when we call _rt_gpu_frame each frame.
function fitCanvas(canvas) {
  const dpr = devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
}

// ------------------------------------------------------------------- input
// KeyboardEvent.code -> runtime key names (runtime/display.c key table)
const CODE_TO_KEY = {
  Escape: 'ESCAPE', Enter: 'RETURN', NumpadEnter: 'RETURN', Space: 'SPACE', Tab: 'TAB', Backspace: 'BACKSPACE',
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  ShiftLeft: 'LSHIFT', ShiftRight: 'RSHIFT', ControlLeft: 'LCTRL', ControlRight: 'RCTRL', AltLeft: 'LALT', AltRight: 'RALT',
  Insert: 'INSERT', Delete: 'DELETE', Home: 'HOME', End: 'END', PageUp: 'PAGEUP', PageDown: 'PAGEDOWN',
};
for (let i = 1; i <= 12; i++) CODE_TO_KEY['F' + i] = 'F' + i;
for (let c = 65; c <= 90; c++) CODE_TO_KEY['Key' + String.fromCharCode(c)] = String.fromCharCode(c);
for (let d = 0; d <= 9; d++) CODE_TO_KEY['Digit' + d] = String(d);

function attachInput(mod, canvas) {
  const base = mod._rt_web_input();
  const QN = 1024;
  const heap = () => new Int32Array(mod.HEAPU8.buffer);
  const keyIndex = {};
  for (const [code, name] of Object.entries(CODE_TO_KEY)) keyIndex[code] = mod.ccall('rt_web_key_index', 'number', ['string'], [name]);

  function push(type, a, b) {
    const h32 = heap(), hi = base >> 2;
    const head = Atomics.load(h32, hi), tail = Atomics.load(h32, hi + 1);
    if (((head - tail) >>> 0) >= QN) return;                    // full: drop
    const e = hi + 2 + (head % QN) * 4;
    h32[e] = type; h32[e + 1] = a; h32[e + 2] = b; h32[e + 3] = 0;
    Atomics.store(h32, hi, (head + 1) | 0);
  }
  const held = new Set();
  const onKey = (down) => (ev) => {
    const idx = keyIndex[ev.code];
    if (idx === undefined || idx < 0) return;
    ev.preventDefault();
    if (down && held.has(ev.code) && !ev.repeat) return;
    if (down) held.add(ev.code); else held.delete(ev.code);
    push(1, idx, down ? 1 : 0);
  };
  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));
  window.addEventListener('blur', () => { for (const c of held) push(1, keyIndex[c], 0); held.clear(); });

  // the game's cursor is relative (DirectInput): pointer lock gives clean deltas
  const acc = { x: 0, y: 0 };
  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
  document.addEventListener('pointerlockchange', () => { $('hint').hidden = document.pointerLockElement === canvas; });
  canvas.addEventListener('mousemove', (ev) => {
    if (document.pointerLockElement !== canvas) return;
    // send deltas in 640x480 game coordinates (the runtime applies the game's sensitivity correction)
    const s = 640 / canvas.clientWidth;
    acc.x += ev.movementX * s; acc.y += ev.movementY * s;
    const dx = Math.trunc(acc.x), dy = Math.trunc(acc.y);
    acc.x -= dx; acc.y -= dy;
    if (dx || dy) push(2, dx, dy);
  });
  canvas.addEventListener('mousedown', (ev) => { if (document.pointerLockElement === canvas) push(3, ev.button === 2 ? 3 : 1, 1); });
  canvas.addEventListener('mouseup', (ev) => { if (document.pointerLockElement === canvas) push(3, ev.button === 2 ? 3 : 1, 0); });
  canvas.addEventListener('wheel', (ev) => { push(4, ev.deltaY < 0 ? 120 : -120, 0); ev.preventDefault(); }, { passive: false });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

// ------------------------------------------------------------------- audio
// The AudioContext is made inside the Start click (Safari only lets audio start during the
// click itself, not after the awaits in start()); startAudio() then plugs the game into it.
let earlyAudio = null;
function makeAudioContext() {
  try {
    const ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    ctx.resume().catch(() => {});
    return { ctx, worklet: ctx.audioWorklet.addModule('audio-worklet.js') };
  } catch (e) { log('audio context failed:', e.message); return null; }
}
async function startAudio(mod) {
  const a = earlyAudio || makeAudioContext();
  if (!a) return null;
  const ctx = a.ctx;
  await a.worklet;
  const node = new AudioWorkletNode(ctx, 'ring-player', { outputChannelCount: [2] });
  node.port.postMessage({ buffer: mod.HEAPU8.buffer, ptr: mod._rt_web_audio() });
  node.connect(ctx.destination);
  log('audio context:', ctx.state);
  ctx.onstatechange = () => log('audio context:', ctx.state);
  // browsers keep audio suspended until a user gesture: never wait for it here
  if (ctx.state !== 'running') {
    log('audio waits for a click or key press');
    const resume = () => ctx.resume().then(() => { for (const e of ['pointerdown', 'keydown']) window.removeEventListener(e, resume, true); });
    for (const e of ['pointerdown', 'keydown']) window.addEventListener(e, resume, true);
  }
  return ctx;
}

// the game ended (crash or exit): say so over the game instead of leaving a frozen picture
let gameDead = false;
function gameStopped(msg) {
  gameDead = true;
  status(msg, true);
  const el = $('log'); el.hidden = false; el.classList.add('overlay');
  log(msg); flushLog();
}

// -------------------------------------------------------------------- boot
async function start() {
  $('start').disabled = true;
  status('Loading the recompiled game…');
  await ensureIni();
  const startT = performance.now();
  const dev = await deviceInfo();
  log('device:', Object.entries(dev).map(([k, v]) => `${k}=${v}`).join(' '));
  if (dev.software) log('WARNING: the browser renders without the GPU (hardware acceleration is off or blocked); expect low frame rates');
  track('start', { online: !!net.id, gpu: String(dev.gpu || ''), dpr: dev.dpr, cores: dev.cores, software: !!dev.software });
  if (net.id) track('online_start', { players: net.peers.size + 1 });
  if (net.id) log(`online: room ${net.room} "${net.info?.name}", ${net.peers.size + 1} player(s), node ${net.id}`);
  log('loading dist/nfs3.js');
  const { default: NFS3 } = await import('./dist/nfs3.js');
  log('instantiating wasm + starting worker pool (cores:', navigator.hardwareConcurrency + ')');
  const mod = await NFS3({
    setStatus: (t) => t && log('[emscripten]', t),
    monitorRunDependencies: (n) => log('[emscripten] pending dependencies:', n),
    onAbort: (what) => { log('ABORT', what); track('error', { kind: 'abort', msg: String(what) }); gameStopped('The game stopped: ' + what); },
    onGameMessage: (t) => { log('ERROR game message:', t); track('error', { kind: 'message', msg: t }); },
    onGameExit: (code) => { log('ERROR game exited, code', code); track('error', { kind: 'exit', msg: 'code ' + code }); gameStopped('The game closed itself (see the log). Reload the page to start again.'); },
    arguments: ['/opfs/nfs3'],
    print: (t) => console.log(t),
    printErr: (t) => console.log(t),
  });
  log('runtime ready, game thread running');
  if (net.id) { mod.ccall('rt_net_set_node', null, ['string'], [net.id]); net.attach(mod); net.setState('game'); showNetBadge(); }
  startPerfLog(mod);
  // keep the log over the game until frames arrive (always with ?log)
  const keepLog = logWanted();
  $('log').classList.add('overlay'); document.body.appendChild($('log'));
  $('log').hidden = !keepLog;
  gameStarted = true;
  $('setup-wrap').hidden = true; $('bg').hidden = true;
  $('screen').style.display = 'block';
  $('hint').hidden = false;
  const canvas = $('canvas');
  attachInput(mod, canvas);
  startAudio(mod).catch((e) => log('audio unavailable:', e.message || e));

  let fpsN = 0, fpsT = performance.now(), first = true, stalled = false, lastFresh = performance.now();
  $('fps').hidden = false;
  function frame() {
    if (gameDead) return;
    fitCanvas(canvas);
    const m0 = performance.now();
    const fresh = mod._rt_gpu_frame(canvas.width, canvas.height);
    const mt = performance.now() - m0; hitch.mainMs += mt; hitch.mainMax = Math.max(hitch.mainMax, mt);
    if (fresh < 0) { status('WebGL2 is not available in this browser.', true); return; }
    if (fresh) {
      if (stalled) log(`stall over after ${((performance.now() - lastFresh) / 1000).toFixed(1)} s`);
      stalled = false; lastFresh = performance.now();
      fpsN++;
      if (first) { first = false; log('first frame'); track('first_frame', { secs: (performance.now() - startT) / 1000 }); playStats.played = true; }
      playStats.frames++;
    }
    const now = performance.now();
    if (first && !stalled && now - lastFresh > 30000) { stalled = true; log('stall: no first frame 30 s after start'); }
    if (!first && !stalled && now - lastFresh > 5000 && document.visibilityState === 'visible') {
      stalled = true; log('stall: no new frame from the game for 5 s'); track('error', { kind: 'stall', msg: 'no frame for 5 s' });
    }
    if (!first) playStats.ms += now - (frame.last ?? now);
    if (frame.last) { hitch.raf = Math.max(hitch.raf, now - frame.last); hitch.intervals.push(now - frame.last); }
    if (fresh && hitch.lastFresh) hitch.game = Math.max(hitch.game, now - hitch.lastFresh);
    if (fresh) { hitch.lastFresh = now; hitch.frames++; }
    frame.last = now;
    if (now - fpsT >= 1000) { $('fps').textContent = `${Math.round(fpsN * 1000 / (now - fpsT))} fps`; fpsN = 0; fpsT = now; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// This browser's graphics and device, logged once at start (and sent with the start event),
// so a slow machine can be told apart from slow code: software rendering, a weak GPU,
// a high-DPI screen, battery saving...
async function deviceInfo() {
  const d = { cores: navigator.hardwareConcurrency || 0, mem: navigator.deviceMemory || 0, dpr: devicePixelRatio || 1,
    screen: `${screen.width}x${screen.height}`, window: `${innerWidth}x${innerHeight}`, isolated: crossOriginIsolated };
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    if (!gl) d.gpu = 'no WebGL2';
    else {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      d.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      d.vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      d.maxtex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      d.software = /SwiftShader|llvmpipe|softpipe|Basic Render|Software/i.test(d.gpu);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch (e) { d.gpu = 'error ' + e.message; }
  try { const b = await navigator.getBattery?.(); if (b) d.battery = `${Math.round(b.level * 100)}%${b.charging ? ' charging' : ' on battery'}`; } catch {}
  try { const ua = await navigator.userAgentData?.getHighEntropyValues?.(['platformVersion', 'architecture', 'fullVersionList']);
    if (ua) d.platform = `${ua.platform} ${ua.platformVersion || ''} ${ua.architecture || ''}`.trim(); } catch {}
  return d;
}

// Perf log: every 2 s while the game runs, this browser's frame pacing (frames shown, frames
// the game made, time the game waited for the screen, render scale) and, online, one part per
// peer (link, round trip, packets, losses, longest gap between packets). It goes to the server
// with the rest of the log (build/clientlogs/), so lag can be looked at afterwards.
//
// It also lowers the render scale when the GPU can't keep up: the game draws 640x480 and we
// scale that by a whole number to fill the screen, which on a big or high-DPI screen means
// rendering up to 2560x1920. If frames are ready but the screen doesn't take them in time,
// the next lower scale is used (and remembered in this browser). ?scale=N forces one.
const hitch = { raf: 0, game: 0, frames: 0, lastFresh: 0, mainMs: 0, mainMax: 0, intervals: [] };
const savedScale = () => { try { return Number(new URLSearchParams(location.search).get('scale')) || Number(localStorage.getItem('nfs3.maxScale')) || 3; } catch { return 3; } };
function startPerfLog(mod) {
  if (net.id) log(`net: room ${net.room} (${net.info?.name || ''}) as "${$('pname')?.value || ''}" id ${net.id}`);
  const forced = (() => { try { return new URLSearchParams(location.search).has('scale'); } catch { return false; } })();
  let maxScale = savedScale(), slow = 0;
  mod._rt_gpu_set_max_scale(maxScale);
  log(`perf: render scale limit ${maxScale}${forced ? ' (forced by ?scale)' : ''}`);
  const stats = () => { const p = mod._rt_gpu_stats() >> 3; return Array.from(mod.HEAPF64.subarray(p, p + 6)); };
  let t = performance.now(), prev = stats();
  setInterval(() => {
    const now = performance.now(), secs = (now - t) / 1000; t = now;
    const cur = stats(), [pub, rep, wait] = cur.map((v, i) => v - prev[i]); prev = cur;
    const [, , , scale, fw, fh] = cur;
    const shown = hitch.frames / secs, made = pub / secs, waitShare = wait / (secs * 1000);
    const iv = hitch.intervals.sort((a, b) => a - b), hz = iv.length > 10 ? 1000 / iv[Math.floor(iv.length * 0.1)] : 60;
    const visible = document.visibilityState === 'visible';
    if (visible && shown > 5) { net.myFps = Math.round(shown); try { localStorage.setItem('nfs3.lastFps', String(net.myFps)); } catch {} }
    log(`perf ${visible ? '' : '[tab hidden] '}fps=${Math.round(shown)} made=${Math.round(made)} replaced=${rep} wait=${Math.round(waitShare * 100)}% hz=${Math.round(hz)}`
      + ` maxframe=${Math.round(hitch.game)}ms raf=${Math.round(hitch.raf)}ms main=${(hitch.mainMs / Math.max(1, iv.length)).toFixed(1)}/${Math.round(hitch.mainMax)}ms scale=${scale} (${fw}x${fh})`
      + (net.id ? ' | ' + (net.netStats().join(' | ') || 'no peers') : ''));
    // frames are waiting for the screen, but the screen runs well below its refresh rate: GPU-bound
    const gpuBound = visible && hitch.lastFresh && shown < hz * 0.9 && (waitShare > 0.2 || rep > secs * 3);
    slow = gpuBound ? slow + 1 : 0;
    if (!forced && slow >= 2 && scale > 1) {
      maxScale = scale - 1; slow = 0;
      mod._rt_gpu_set_max_scale(maxScale);
      try { localStorage.setItem('nfs3.maxScale', String(maxScale)); } catch {}
      log(`perf: GPU can't keep up (${Math.round(shown)} fps at ${fw}x${fh}), render scale lowered to ${maxScale}`);
    }
    Object.assign(hitch, { raf: 0, game: 0, frames: 0, mainMs: 0, mainMax: 0, intervals: [] });
  }, 2000);
  document.addEventListener('visibilitychange', () => log(`perf: tab ${document.visibilityState}`));
}

function showNetBadge() {
  const b = $('netbadge');
  const draw = () => {
    const s = net.summary();
    b.textContent = `${s.name || 'Room ' + s.room} · ${s.players} player${s.players === 1 ? '' : 's'}` + (s.peers.length ? ' · ' + s.peers.join(' · ') : ' · waiting for friends')
      + (s.best ? ` · best host: ${s.best.name}${s.best.me ? ' (create the game)' : ''}` : '');
  };
  b.hidden = false; draw();
  net.addEventListener('status', draw);
  b.onclick = () => navigator.clipboard?.writeText(roomLink(net.room)).then(() => { b.textContent = 'Room link copied'; setTimeout(draw, 1200); });
}

// ------------------------------------------------------------------ lobby
// Room browser and room page. Rooms live on the relay (relay.mjs); we join
// before Start so everyone sees each other (and WebRTC links come up) early.
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const pingClass = (ms) => (ms < 60 ? 'ping-good' : ms < 130 ? 'ping-ok' : 'ping-bad');
const savedPass = (code) => { try { return sessionStorage.getItem('nfs3.pass.' + code) || ''; } catch { return ''; } };
const savePass = (code, pw) => { try { pw ? sessionStorage.setItem('nfs3.pass.' + code, pw) : sessionStorage.removeItem('nfs3.pass.' + code); } catch {} };
let gameStarted = false;

function setupOnline() {
  const name = $('pname');
  try { name.value = localStorage.getItem('nfs3.name') || ''; } catch {}
  name.addEventListener('input', () => { try { localStorage.setItem('nfs3.name', name.value.trim()); } catch {} });
  const myName = () => name.value.trim().slice(0, 16);
  const needName = () => {
    if (myName()) return false;
    message('Enter your name first.'); name.focus(); return true;
  };
  const message = (t) => { $('lobby-msg').textContent = t || ''; $('lobby-msg').hidden = !t; };
  const server = (t, cls = '') => { $('server-state').textContent = t; $('server-state').className = 'pill ' + cls; };
  let joining = null;          // room code waiting for a password

  // ---- room list
  function drawRooms() {
    const tb = $('rooms').tBodies[0]; tb.textContent = '';
    const racers = String(Math.min(999, net.rooms.reduce((n, r) => n + r.players.length, 0))).padStart(3, '0');
    $('online-count').replaceChildren(...[...racers].map((d) => el('i', { textContent: d })));
    const rooms = [...net.rooms].sort((a, b) => (a.racing - b.racing) || (b.players.length - a.players.length) || (b.created - a.created));
    $('rooms-empty').hidden = rooms.length > 0; $('rooms').hidden = !rooms.length;
    for (const r of rooms) {
      const full = r.players.length >= r.max;
      const rtts = r.players.map((p) => p.rtt).filter((x) => x != null);
      const ping = net.relayRtt != null && rtts.length ? Math.round(net.relayRtt + rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
      const title = el('div', { className: 'rname', textContent: r.name });
      if (r.locked) title.append(el('span', { className: 'tag', textContent: 'password', title: 'Needs a password' }));
      if (r.racing) title.append(el('span', { className: 'tag race', textContent: 'racing', title: 'Someone in this room is in the game' }));
      const who = el('div', { className: 'sub', textContent: r.players.map((p) => p.name).join(', ') });
      const join = el('button', { className: 'small', textContent: full ? 'Full' : 'Join', disabled: full || !!net.id });
      join.onclick = () => joinRoom(r.code, r.locked ? null : '', r.name);
      tb.append(el('tr', {},
        el('td', {}, title, who),
        el('td', { textContent: `${r.players.length}/${r.max}` }),
        el('td', { className: ping != null ? pingClass(ping) : '', textContent: ping != null ? `${ping} ms` : '–' }),
        el('td', {}, join)));
    }
  }

  // ---- in a room
  function drawRoom() {
    const inRoom = !!net.id;
    $('lobby').hidden = inRoom || gameStarted; $('inroom').hidden = !inRoom || gameStarted;
    if (!inRoom) return;
    $('room-title').textContent = net.info?.name || net.room;
    if (net.info?.locked) $('room-title').append(el('span', { className: 'tag', textContent: 'password' }));
    const ul = $('members'); ul.textContent = '';
    ul.append(el('li', {}, el('span', { textContent: `${myName() || 'Player'} (you)` }), el('span', { className: 'muted', textContent: net.relayRtt != null ? `server ${Math.round(net.relayRtt)} ms` : '' })));
    for (const p of net.peers.values()) {
      const r = net.rttTo(p);
      const right = el('span', {},
        el('span', { className: r != null ? pingClass(r) : 'muted', textContent: r != null ? `${Math.round(r)} ms` : '…' }),
        el('span', { className: 'muted', textContent: ` · ${p.direct ? 'direct' : 'via server'}${p.state === 'game' ? ' · in game' : ''}` }));
      ul.append(el('li', {}, el('span', { textContent: p.name }), right));
    }
    if (!net.peers.size) ul.append(el('li', {}, el('span', { className: 'muted', textContent: 'Waiting for friends… send them the invite link.' })));
    const best = net.bestHost();
    $('best-host').textContent = best ? `Best host: ${best.me ? 'you' : best.name} (slowest link ${best.worst} ms, counting ping and frame rate). The host has no input lag; everyone else has one round trip to the host.` : '';
    $('share-link').textContent = roomLink(net.room);
  }
  const redraw = () => { drawRooms(); drawRoom(); };

  async function joinRoom(code, password, label) {
    if (needName()) return;
    if (password == null) { askPassword(code, label); return; }
    message('');
    try {
      await net.join(code, myName(), password);
      savePass(code, password);
      track('room_join', { locked: !!password });
      history.replaceState(null, '', '#room=' + code);
      $('pass-form').hidden = true; joining = null;
    } catch (e) {
      if (e.code === 'password') { askPassword(code, label, e.message); return; }
      message(e.message);
      if (e.code === 'gone') history.replaceState(null, '', location.pathname + location.search);
    }
    redraw();
  }
  function askPassword(code, label, err) {
    joining = code;
    $('pass-label').textContent = `Password for ${label || code}`;
    $('pass-form').hidden = false; $('create-form').hidden = true;
    if (err) message(err);
    $('j-pass').value = ''; $('j-pass').focus();
  }
  $('pass-form').addEventListener('submit', (e) => { e.preventDefault(); if (joining) joinRoom(joining, $('j-pass').value); });
  $('j-cancel').onclick = () => { $('pass-form').hidden = true; joining = null; message(''); };

  $('show-create').onclick = () => {
    if (needName()) return;
    $('create-form').hidden = false; $('pass-form').hidden = true;
    if (!$('c-name').value) $('c-name').value = `${myName()}'s room`;
    $('c-name').focus();
  };
  $('c-cancel').onclick = () => { $('create-form').hidden = true; };
  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (needName()) return;
    message('');
    const pw = $('c-pass').value;
    try {
      const w = await net.create({ name: $('c-name').value.trim(), password: pw, max: Number($('c-max').value), listed: $('c-listed').checked }, myName());
      savePass(w.room, pw);
      track('room_create', { max: Number($('c-max').value), locked: !!pw, listed: $('c-listed').checked });
      history.replaceState(null, '', '#room=' + w.room);
      $('create-form').hidden = true;
    } catch (err) { message(err.message); }
    redraw();
  });
  $('leave-room').onclick = () => { net.leave(); history.replaceState(null, '', location.pathname + location.search); redraw(); };
  $('copy-link').onclick = () => navigator.clipboard?.writeText(roomLink(net.room)).then(() => {
    $('copy-link').textContent = 'Copied'; setTimeout(() => { $('copy-link').textContent = 'Copy invite link'; }, 1200);
  });

  net.addEventListener('rooms', redraw);
  net.addEventListener('status', drawRoom);
  net.addEventListener('log', (e) => log('online:', e.detail));
  net.addEventListener('disconnected', () => { server('offline', 'bad'); redraw(); if (!gameStarted) setTimeout(connect, 3000); });

  // invite links (#room=code) join straight away (asking for the password if needed)
  async function connect() {
    server('connecting…');
    try { await net.connect(); } catch (e) { server('offline', 'bad'); setTimeout(connect, 3000); return; }
    server('online', 'ok');
    const code = roomFromHash();
    if (code && !net.id) {
      if (myName()) joinRoom(code, savedPass(code), code);
      else { message('Enter your name, then join the room from the invite link.'); name.focus();
        name.addEventListener('change', () => { if (!net.id && roomFromHash() === code) joinRoom(code, savedPass(code), code); }, { once: true }); }
    }
    redraw();
  }
  window.addEventListener('hashchange', () => { const c = roomFromHash(); if (c && c !== net.room && !net.id) joinRoom(c, savedPass(c), c); });
  redraw();
  connect();
}

const TIPS = [
  'Hold the handbrake through tight corners to slide around them.',
  'In Hot Pursuit, the police set up roadblocks and spike strips ahead. Watch the radar.',
  'Manual transmission is faster once you get the hang of it.',
  'Online: whoever has the lowest ping should create the game. The host never lags.',
  'Two racers? Pick Peer-to-Peer in the host dialog so both get the same responsiveness.',
  'Click the picture to capture the mouse. Esc gives it back.',
  'Car Showcase has history, interiors and a slide show for every car.',
];
function setupLogToggle() {
  const t = $('log-toggle');
  const draw = () => { $('log').hidden = !logWanted(); t.textContent = logWanted() ? 'Hide technical log' : 'Show technical log'; };
  t.onclick = (e) => { e.preventDefault(); try { localStorage.setItem('nfs3.log', logWanted() ? '0' : '1'); } catch {} draw(); };
  draw();
}
async function init() {
  setupLogToggle();
  $('tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  setupOnline();
  log('page loaded; crossOriginIsolated =', crossOriginIsolated, '; SharedArrayBuffer =', typeof SharedArrayBuffer);
  if (!crossOriginIsolated) {
    status('This page must be served with cross-origin isolation (COOP/COEP headers). Use web/serve.mjs.', true);
    return;
  }
  if (!navigator.storage?.getDirectory) { status('This browser has no Origin Private File System support.', true); return; }
  try { buildInfo = await (await fetch('dist/build-info.json')).json(); } catch {
    status('No recompiled build found in web/dist. Run ./build-web.sh first.', true); return;
  }
  const refresh = async () => {
    const ok = await hasGame();
    $('pick-label').hidden = ok; $('start').hidden = !ok; $('forget').hidden = !ok;
    status(ok ? 'Game files are stored in this browser. Ready.' : 'Choose your NFS3 folder (the one with nfs3.exe, fedata and gamedata).');
  };
  $('pick').addEventListener('change', async (e) => {
    try { await importFolder(e.target.files); } catch (err) { status(err.message, true); $('progress').hidden = true; return; }
    track('import', { files: e.target.files.length });
    await refresh();
  });
  $('forget').addEventListener('click', async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(GAME_DIR, { recursive: true }).catch(() => {});
    await refresh();
  });
  // a server started with --game offers its game folder: import it automatically
  // ?devimport also forces the attempt and reports errors
  const forced = new URLSearchParams(location.search).has('devimport');
  if (!(await hasGame()) && (forced || await serverHasGame())) {
    status('Downloading the game files into this browser…');
    try { await importFolder(await serverFiles()); track('import', { from: 'server' }); } catch (err) { status(err.message, true); return; }
  }
  if (new URLSearchParams(location.search).has('autostart') && (await hasGame())) { start().catch((e) => { console.error('Failed to start:', e.stack || e); status('Failed to start: ' + e.message, true); $('setup-wrap').hidden = false; }); }
  $('start').addEventListener('click', () => { if (!earlyAudio) earlyAudio = makeAudioContext(); start().catch((e) => { console.error(e); status('Failed to start: ' + e.message, true); $('start').disabled = false; }); });
  await refresh();
}
init();
