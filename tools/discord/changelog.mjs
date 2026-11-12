// Posts the changelogs to the Discord #changelog channel: one message per day, with that day's
// changes for every game. The days come from each game's web/changelog.json (the same lists the
// sites show under What's New), read from the checkouts next to this repository (GAMES in
// content.mjs). Run it after adding or editing a day:
//
//   node tools/discord/changelog.mjs          post new days (oldest first), edit changed ones
//   node tools/discord/changelog.mjs --dry    show what would be posted
//
// A day already posted is edited in place when its text changed, so a correction stays in its
// place in the channel. New messages are also published to servers that follow the channel.
// Uses the bot token and state of setup.mjs (build/discord/); message ids per day are kept in
// build/discord/state.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GAMES } from './content.mjs';

const DRY = process.argv.includes('--dry');
const dir = new URL('../../build/discord/', import.meta.url);
const stateFile = new URL('state.json', dir);
if (!existsSync(stateFile)) { console.error('Run tools/discord/setup.mjs first.'); process.exit(1); }
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const token = (process.env.DISCORD_TOKEN || readFileSync(new URL('token', dir), 'utf8')).trim();
const workspace = fileURLToPath(new URL('../../../', import.meta.url));

async function api(method, path, body, retry = true) {
  for (let tries = 0; ; tries++) {
    const r = await fetch('https://discord.com/api/v10' + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/mrz944/nfs3-web, 1)' },
    });
    if (r.status === 429 && retry && tries < 8) { const j = await r.json().catch(() => ({})); await new Promise((ok) => setTimeout(ok, (j.retry_after || 1) * 1000 + 250)); continue; }
    const text = await r.text();
    if (!r.ok) { const e = new Error(`${method} ${path}: ${r.status} ${text}`); e.status = r.status; throw e; }
    return text ? JSON.parse(text) : null;
  }
}

// every game's days, merged by date
const KIND = { new: 'New', improved: 'Better', fixed: 'Fixed' };
const byDate = new Map();
for (const g of GAMES) {
  const f = `${workspace}${g.dir}/web/changelog.json`;
  if (!existsSync(f)) { console.log(`${g.tag}: no ${f}, skipped`); continue; }
  for (const day of JSON.parse(readFileSync(f, 'utf8')).days) {
    if (!/^\d{4}-\d\d-\d\d$/.test(day.date)) throw new Error(`${f}: bad date ${day.date}`);
    if (!byDate.has(day.date)) byDate.set(day.date, []);
    byDate.get(day.date).push({ g, items: day.items });
  }
}
const esc = (s) => s.replace(/([*_~`|>\\])/g, '\\$1');
const dateText = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
function messages(date) {
  const parts = byDate.get(date).map(({ g, items }) =>
    `### ${g.emoji} ${g.tag} · <https://${g.site}/#changelog>\n` + items.map(([k, t]) => `- **${KIND[k] || k}:** ${esc(t)}`).join('\n'));
  const out = [];                                         // split between games at 2000 characters
  let cur = `## ${dateText(date)}`;
  for (const p of parts) {
    if (cur.length + p.length + 2 > 1990) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + p;
  }
  out.push(cur);
  for (const m of out) if (m.length > 2000) throw new Error(`${date}: one game's changes are longer than a Discord message`);
  return out;
}

const channels = await api('GET', `/guilds/${state.guild}/channels`);
const log = channels.find((c) => c.name === 'changelog');
if (!log) { console.error('No #changelog channel: run tools/discord/setup.mjs.'); process.exit(1); }
if (typeof state.changelog !== 'object' || Array.isArray(state.changelog)) state.changelog = {};
const posted = state.changelog;                         // date -> [message ids]
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });

for (const date of [...byDate.keys()].sort()) {
  const want = messages(date), ids = posted[date] || [];
  if (ids.length) {
    if (ids.length !== want.length) { console.log(`${date}: posted as ${ids.length} message(s), now ${want.length}: delete those messages in Discord and remove the date from build/discord/state.json to post it again`); continue; }
    for (let i = 0; i < ids.length; i++) {
      const m = await api('GET', `/channels/${log.id}/messages/${ids[i]}`).catch((e) => { if (e.status === 404) return null; throw e; });
      if (!m) { console.log(`${date}: message ${i + 1} was deleted in Discord; remove the date from build/discord/state.json to post it again`); continue; }
      if (m.content === want[i]) continue;
      if (DRY) { console.log(`${date}: would edit message ${i + 1}`); continue; }
      await api('PATCH', `/channels/${log.id}/messages/${ids[i]}`, { content: want[i], allowed_mentions: { parse: [] } });
      console.log(`${date}: edited message ${i + 1}`);
    }
    continue;
  }
  if (DRY) { console.log(`---- ${date}: would post\n${want.join('\n---- (next message)\n')}\n`); continue; }
  const out = [];
  for (const content of want) {
    const m = await api('POST', `/channels/${log.id}/messages`, { content, flags: 4, allowed_mentions: { parse: [] } });   // 4: no link previews
    out.push(m.id);
    // publish to following servers: at most 10 an hour per channel, so don't wait on the limit
    if (log.type === 5) await api('POST', `/channels/${log.id}/messages/${m.id}/crosspost`, undefined, false).catch((e) => console.log(`  not published to followers (${e.status})`));
  }
  posted[date] = out; save();
  console.log(`${date}: posted`);
}
if (!DRY) save();
