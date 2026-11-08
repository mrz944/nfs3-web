#!/usr/bin/env node
// Builds a hosted mod set for the start page's Mods switch (web/mods.js):
//   node tools/build-mods.mjs ARCHIVE_DIR [SET] [OUT_DIR]
// ARCHIVE_DIR holds each mod's archive as downloaded from its page, named <id>.zip (the id in
// web/mods.json). The set's mods are laid out in the order web/mods.json lists them (a later mod
// wins a file both change), each in its default version, through the same path rules the page
// uses (planFiles), and written as web/mods/<set>/index.json plus one .gz per game file.
// The output is the mod authors' work, not ours: it is git-ignored, like the game files.
import { createHash } from 'node:crypto';
import { mkdirSync, openAsBlob, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { planFiles, readZip } from '../web/mods.js';

const [src, setName = 'rata536', outArg] = process.argv.slice(2);
if (!src) { console.error('usage: node tools/build-mods.mjs ARCHIVE_DIR [SET] [OUT_DIR]'); process.exit(1); }
const cat = JSON.parse(readFileSync(new URL('../web/mods.json', import.meta.url), 'utf8'));
const set = cat.sets?.[setName];
if (!set) { console.error(`no set "${setName}" in web/mods.json`); process.exit(1); }
const out = resolve(outArg || new URL(`../web/mods/${setName}`, import.meta.url).pathname);

const files = new Map();                          // game path -> { blob, from }
for (const id of set.include) {
  const mod = cat.mods.find((m) => m.id === id);
  if (!mod) { console.error(`mod ${id} is not in web/mods.json`); process.exit(1); }
  const list = await readZip(await openAsBlob(join(src, `${id}.zip`)));
  const plan = planFiles(list, mod, mod.variants?.[0] || null);
  const missing = (mod.check || []).filter((p) => !plan.has(p));
  if (missing.length) { console.error(`${id} ${mod.title}: ${missing.join(', ')} not in the archive`); process.exit(1); }
  for (const [p, f] of plan) files.set(p, { f, from: mod.title });
  console.log(`${mod.title}: ${plan.size} files`);
}
rmSync(out, { recursive: true, force: true });
const index = [], h = createHash('sha256');
let bytes = 0, gz = 0;
for (const [p, { f }] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const raw = Buffer.from(await (await f.blob()).arrayBuffer()), z = gzipSync(raw, { level: 9 });
  const dst = join(out, 'files', p + '.gz');
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, z);
  index.push([p, raw.length, z.length]);
  h.update(p).update(raw);
  bytes += raw.length; gz += z.length;
}
const id = h.digest('hex').slice(0, 12);
writeFileSync(join(out, 'index.json'), JSON.stringify({ set: setName, id, bytes, gz, files: index }));
console.log(`${setName} ${id}: ${index.length} files, ${(bytes / 2 ** 20).toFixed(1)} MB (${(gz / 2 ** 20).toFixed(1)} MB to download) -> ${out}`);
