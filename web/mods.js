// Mods: community remakes switched on with one checkbox on the start page.
//
// A mod set (web/mods.json "sets") is built on the server from the authors' archives by
// tools/build-mods.mjs into web/mods/<set>/: index.json and one .gz per game file. Switching it on
// downloads those files once and copies them into the game files in this browser (OPFS); every
// file it replaces is backed up first (.mods/backup/), so switching it off puts the originals back.
// planFiles/readZip are the build tool's: which files of an archive the game reads and where they
// go (anchors like FEDATA/, GAMEDATA/, CARMODEL/, TRAFFIC/; a mod's variants and base folder).
// State: .mods/state.json in the game folder.

const MODS_DIR = '.mods';
const ALLOWED = /\.(viv|bnk|qfs|fsh|fce|frd|col|can|hrz)$/i;
const CAR_FILE = /^gamedata\/carmodel\/(traffic\/(pursuit\/)?\d{4}|(?!traffic\/)[^/]+)\/[^/]+\.(viv|bnk)$/;   // car folder: car.viv, speech and sound banks
const ALT_VIV = /^car.+\.viv$/i;                                                                          // car2.viv, car-legacy.viv: alternates

// ------------------------------------------------------------------ archives
// .zip: central directory, stored or deflated entries (the browser's own inflater)
export async function readZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
  if (e < 0) throw new Error('This is not a .zip file. Unpack it first and choose the folder instead.');
  const tv = new DataView(tail.buffer);
  const count = tv.getUint16(e + 10, true), cdSize = tv.getUint32(e + 12, true), cdOff = tv.getUint32(e + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('This .zip is too big to read here. Unpack it and choose the folder instead.');
  const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), cv = new DataView(cd.buffer);
  const utf8 = new TextDecoder('utf-8'), latin = new TextDecoder('windows-1252');
  const out = [];
  for (let i = 0, p = 0; i < count; i++) {
    if (cv.getUint32(p, true) !== 0x02014b50) throw new Error('This .zip looks damaged. Download it again.');
    const flags = cv.getUint16(p + 8, true), method = cv.getUint16(p + 10, true);
    const csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
    const nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true), lho = cv.getUint32(p + 42, true);
    const path = (flags & 0x800 ? utf8 : latin).decode(cd.subarray(p + 46, p + 46 + nl)).replace(/\\/g, '/');
    p += 46 + nl + xl + cl;
    if (path.endsWith('/')) continue;
    out.push({ path, size: usize, async blob() {
      if (flags & 1) throw new Error(`${path} is password protected`);
      const h = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
      const start = lho + 30 + h.getUint16(26, true) + h.getUint16(28, true), raw = file.slice(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      throw new Error(`${path} uses a compression this page can't unpack (${method}). Unpack the .zip and choose the folder instead.`);
    } });
  }
  return out;
}
// ------------------------------------------------------------------ mapping
// archive path -> game path (lower case), or null when the game doesn't read that file
export function planFiles(list, mod = {}, variant = null) {
  const variants = mod.variants || [];
  const keeps = variants.map((v) => v.keep).filter(Boolean);
  let items = list.map((f) => ({ ...f, low: f.path.toLowerCase() }));
  if (variant?.keep) items = items.filter((f) => f.low.includes(variant.keep));
  else if (keeps.length) items = items.filter((f) => !keeps.some((k) => f.low.includes(k)));
  const swap = variant?.swap || {};                                   // { "car2.viv": "car.viv" }
  const target = (low) => {
    const parts = low.split('/').filter(Boolean), name = parts.at(-1);
    // archives are untrusted input: nothing that could climb out of the game folder
    if (/[\\\0:]/.test(low) || parts.some((p) => p === '.' || p === '..')) return null;
    let i = parts.findIndex((s) => s === 'fedata' || s === 'gamedata');
    if (i >= 0) return parts.slice(i).join('/');
    i = parts.findIndex((s) => s === 'carmodel'); if (i >= 0) return 'gamedata/' + parts.slice(i).join('/');
    i = parts.findIndex((s, k) => s === 'traffic' && /^(pursuit|\d{4})$/.test(parts[k + 1] || '')); if (i >= 0) return 'gamedata/carmodel/' + parts.slice(i).join('/');
    i = parts.findIndex((s, k) => s === 'art' && /^(slides|showcase)$/.test(parts[k + 1] || '')); if (i >= 0) return 'fedata/' + parts.slice(i).join('/');
    if (parts.length >= 2 && /\.(viv|bnk)$/.test(name)) {
      const dir = parts.at(-2);
      if (mod.base) return mod.base + dir + '/' + name;               // archives of bare car folders
      if (!/^\d{4}$/.test(dir) && dir !== 'traffic' && dir.length <= 8) return 'gamedata/carmodel/' + dir + '/' + name;
    }
    return null;
  };
  const plan = new Map();                                             // game path -> source (the first one wins)
  const swapped = new Set();
  for (const f of items) {
    let t = target(f.low);
    if (!t) continue;
    const name = t.split('/').at(-1);
    if (swap[name]) { t = t.slice(0, -name.length) + swap[name]; swapped.add(t); plan.set(t, f); continue; }
    if (swapped.has(t)) continue;
    if (t.startsWith('gamedata/carmodel/') ? !CAR_FILE.test(t) || ALT_VIV.test(name) : !ALLOWED.test(name)) continue;
    if (!plan.has(t)) plan.set(t, f);
  }
  return plan;
}

// ------------------------------------------------------------------ files in OPFS
async function findChild(dir, name, kind) {
  for await (const [n, h] of dir.entries()) if (h.kind === kind && n.toLowerCase() === name) return { n, h };
  return null;
}
// a folder by game path, matching the existing spelling (the game files keep their own case)
async function openDir(root, parts, create, made) {
  let d = root, path = '';
  for (const p of parts) {
    path += (path ? '/' : '') + p;
    const c = await findChild(d, p, 'directory');
    if (c) { d = c.h; continue; }
    if (!create) return null;
    d = await d.getDirectoryHandle(p, { create: true });
    made?.push(path);
  }
  return d;
}
async function fileAt(root, path) {
  const parts = path.split('/'), d = await openDir(root, parts.slice(0, -1), false);
  if (!d) return null;
  const c = await findChild(d, parts.at(-1), 'file');
  return c ? { dir: d, name: c.n, handle: c.h } : null;
}
async function writeBlob(dir, name, blob) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(blob); await w.close();
}
async function readState(root) {
  try { const d = await root.getDirectoryHandle(MODS_DIR); return JSON.parse(await (await (await d.getFileHandle('state.json')).getFile()).text()); } catch { return { installed: {} }; }
}
async function writeState(root, state) {
  const d = await root.getDirectoryHandle(MODS_DIR, { create: true });
  await writeBlob(d, 'state.json', new Blob([JSON.stringify(state)]));
}
// paths mods changed (the page's damaged-files check leaves them alone)
export async function moddedPaths(root) {
  const s = await readState(root), out = new Set();
  for (const m of Object.values(s.installed)) for (const f of m.files) out.add(f.p);
  return out;
}
// the game files were downloaded again: the mods (and their backups) are gone with them
export async function forgetMods(root) { await root.removeEntry(MODS_DIR, { recursive: true }).catch(() => {}); }

// Mods stack: a file two mods change holds the newest one's copy. Each mod keeps a backup of what
// the file was before it (.mods/backup/<mod>/<path>), so taking out the top one restores the one
// below, and taking out one underneath hands its backup to the mod above.
const bkey = (key) => key.replace(/[^a-z0-9-]/gi, '_');
async function backupDir(root, key, create) {
  try { return await (await (await root.getDirectoryHandle(MODS_DIR, { create })).getDirectoryHandle('backup', { create })).getDirectoryHandle(bkey(key), { create }); } catch { return null; }
}
async function install(root, key, info, plan, progress) {
  if ((await readState(root)).installed[key]) await uninstall(root, key);
  const state = await readState(root);
  const below = (p) => Object.entries(state.installed).filter(([, m]) => m.files.some((f) => f.p === p)).map(([, m]) => m.title);
  const over = new Set();
  const backups = await backupDir(root, key, true);
  const rec = { title: info.title, id: info.id || '', variant: info.variant || '', at: Date.now(), files: [], dirs: [] };
  let n = 0, bytes = 0;
  try {
    for (const [p, src] of plan) {
      progress?.(`Copying ${++n} / ${plan.size}…`);
      for (const t of below(p)) over.add(t);
      const parts = p.split('/'), old = await fileAt(root, p);
      if (old) await writeBlob(await openDir(backups, parts.slice(0, -1), true), parts.at(-1), await old.handle.getFile());
      const dir = old ? old.dir : await openDir(root, parts.slice(0, -1), true, rec.dirs);
      const blob = await src.blob();
      await writeBlob(dir, old ? old.name : parts.at(-1), blob);
      bytes += blob.size;
      rec.files.push({ p, b: !!old });
      state.installed[key] = { ...rec, partial: true };              // a reload halfway leaves a record to undo
      await writeState(root, state);
    }
  } catch (e) {
    state.installed[key] = rec; await writeState(root, state);       // undo what got copied
    await uninstall(root, key).catch(() => {});
    throw e;
  }
  state.installed[key] = rec;
  await writeState(root, state);
  return { files: rec.files.length, bytes, over: [...over] };
}
async function uninstall(root, key) {
  const state = await readState(root), rec = state.installed[key];
  if (!rec) return;
  const mine = await backupDir(root, key, true);
  for (const f of [...rec.files].reverse()) {
    const parts = f.p.split('/');
    // the next mod above this one on the same file, if any
    const above = Object.entries(state.installed).filter(([k, m]) => k !== key && m.at > rec.at && m.files.some((g) => g.p === f.p)).sort((a, b) => a[1].at - b[1].at)[0];
    const b = f.b ? await fileAt(mine, f.p) : null;
    if (above) {                                                     // the file stays the upper mod's: it inherits what was below us
      const [ak, am] = above, theirs = await backupDir(root, ak, true), g = am.files.find((x) => x.p === f.p);
      const tb = await fileAt(theirs, f.p);
      if (b) { await writeBlob(await openDir(theirs, parts.slice(0, -1), true), tb ? tb.name : parts.at(-1), await b.handle.getFile()); g.b = true; }
      else { if (tb) await tb.dir.removeEntry(tb.name).catch(() => {}); g.b = false; }
      for (const d of rec.dirs) if (f.p.startsWith(d + '/') && !am.dirs.includes(d)) am.dirs.push(d);   // and our folders, to clean up later
    } else {
      const cur = await fileAt(root, f.p);
      if (b) await writeBlob(cur ? cur.dir : await openDir(root, parts.slice(0, -1), true), cur ? cur.name : parts.at(-1), await b.handle.getFile());
      else if (cur) await cur.dir.removeEntry(cur.name).catch(() => {});
    }
  }
  for (const d of [...rec.dirs].reverse()) {                        // folders the mod made, if empty now
    const parts = d.split('/'), parent = await openDir(root, parts.slice(0, -1), false);
    const c = parent && await findChild(parent, parts.at(-1), 'directory');
    if (c) await parent.removeEntry(c.n).catch(() => {});           // fails (and stays) when not empty
  }
  await (await root.getDirectoryHandle(MODS_DIR)).getDirectoryHandle('backup').then((d) => d.removeEntry(bkey(key), { recursive: true })).catch(() => {});
  delete state.installed[key];
  await writeState(root, state);
}

// ------------------------------------------------------------------ page
const MB = (b) => `${Math.round(b / 2 ** 20)} MB`;
const prefs = () => { try { return JSON.parse(localStorage.getItem('nfs3.mods') || '{}'); } catch { return {}; } };
let settled = Promise.resolve();
// start() waits for this: never start the game halfway through copying
export const modsSettled = () => settled;

export async function setupMods({ gameRoot, log, hasGame }) {
  const box = document.getElementById('mods-on'), line = document.getElementById('mods-line'), bar = document.getElementById('mods-bar'), pill = document.getElementById('mods-count');
  if (!box) return;
  let cat = null;
  try { cat = await (await fetch('mods.json', { cache: 'no-cache' })).json(); } catch {}
  const name = 'rata536', set = cat?.sets?.[name], key = 'set-' + name;
  if (!set) { line.textContent = 'The mod list could not be loaded.'; box.disabled = true; return; }
  const titles = set.include.map((id) => cat.mods.find((m) => m.id === id)?.title).filter(Boolean);
  document.getElementById('mods-list').textContent = titles.join(' · ');
  box.checked = !!prefs()[name];
  const show = (text, err = false) => { line.textContent = text; line.classList.toggle('err', err); };
  const mark = (on) => { pill.textContent = on ? 'on' : 'off'; pill.className = 'pill' + (on ? ' ok' : ''); };

  async function sync() {
    if (!(await hasGame())) { box.disabled = true; show('Available once the game files are in this browser.'); return; }
    const root = await gameRoot(), want = box.checked;
    let rec = (await readState(root)).installed[key];
    box.disabled = true;
    try {
      let idx = null;
      try { const r = await fetch(`mods/${name}/index.json`, { cache: 'no-cache' }); if (r.ok) idx = await r.json(); } catch {}
      if (want && !idx) throw new Error('they are not on this server right now');
      if (rec && (rec.partial || !want || rec.id !== idx.id)) {          // off, half done, or a newer set
        show('Putting the original files back…');
        await uninstall(root, key);
        log(`mods: ${set.title} off, original files back`);
        rec = null;
      }
      if (want && !rec) {
        bar.hidden = false; bar.value = 0;
        let got = 0;
        const plan = new Map(idx.files.map(([p, size, gz]) => [p, { size, blob: async () => {
          const r = await fetch(`mods/${name}/files/${p.split('/').map(encodeURIComponent).join('/')}.gz`);
          if (!r.ok) throw new Error(`download failed: ${p} (${r.status})`);
          const b = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).blob();
          if (b.size !== size) throw new Error(`download incomplete: ${p}`);
          got += gz; bar.value = got / idx.gz;
          show(`Downloading and installing… ${MB(got)} / ${MB(idx.gz)}`);
          return b;
        } }]));
        show(`Downloading and installing… 0 / ${MB(idx.gz)}`);
        const res = await install(root, key, { title: set.title, id: idx.id }, plan);
        log(`mods: ${set.title} on: ${res.files} files, ${MB(res.bytes)}`);
      }
      const on = want;
      mark(on);
      show(on ? `On: in the game from the next Start. Untick to put the original files back.`
        : idx ? `Off. Switching it on downloads ${MB(idx.gz)} once.` : 'Off.');
    } catch (e) {
      log('mods:', e.message);
      show(`Couldn't ${want ? 'install' : 'remove'} the mods: ${e.message}. Reload to try again.`, true);
      mark(!!(await readState(root)).installed[key]);
    }
    bar.hidden = true;
    box.disabled = false;
  }
  const run = () => (settled = settled.then(sync, sync));
  box.addEventListener('change', () => {
    try { localStorage.setItem('nfs3.mods', JSON.stringify({ ...prefs(), [name]: box.checked })); } catch {}
    run();
  });
  run();
  return { refresh: run };
}
