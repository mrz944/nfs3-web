// Reads the Discord server's threads (bug reports, ideas, ...) with the bot of setup.mjs:
//
//   node tools/discord/read.mjs              list the threads, newest first
//   node tools/discord/read.mjs <words>      print the threads whose name has them, every message
//
// Needs the bot's Message Content intent (on since 2026-11-18; without it messages read empty).
import { readFileSync } from 'node:fs';

const dir = new URL('../../build/discord/', import.meta.url);
const state = JSON.parse(readFileSync(new URL('state.json', dir), 'utf8'));
const token = (process.env.DISCORD_TOKEN || readFileSync(new URL('token', dir), 'utf8')).trim();
const q = process.argv.slice(2).join(' ').toLowerCase();

async function api(path) {
  for (let tries = 0; ; tries++) {
    const r = await fetch('https://discord.com/api/v10' + path, { headers: { Authorization: 'Bot ' + token, 'User-Agent': 'DiscordBot (https://github.com/mrz944/nfs3-web, 1)' } });
    if (r.status === 429 && tries < 8) { const j = await r.json().catch(() => ({})); await new Promise((ok) => setTimeout(ok, (j.retry_after || 1) * 1000 + 250)); continue; }
    if (!r.ok) { const e = new Error(`GET ${path}: ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
}

const channels = await api(`/guilds/${state.guild}/channels`);
const name = (id) => channels.find((c) => c.id === id)?.name || id;
const seen = new Map();
for (const t of (await api(`/guilds/${state.guild}/threads/active`)).threads) seen.set(t.id, t);
for (const c of channels.filter((c) => c.type === 0 || c.type === 5 || c.type === 15)) {
  try { for (const t of (await api(`/channels/${c.id}/threads/archived/public?limit=100`)).threads) seen.set(t.id, t); } catch (e) { if (e.status !== 403) throw e; }
}
const threads = [...seen.values()].sort((a, b) => (b.thread_metadata?.create_timestamp || '').localeCompare(a.thread_metadata?.create_timestamp || ''));
const tagName = (t) => (channels.find((c) => c.id === t.parent_id)?.available_tags || []).filter((g) => (t.applied_tags || []).includes(g.id)).map((g) => g.name);

if (!q) {
  for (const t of threads) console.log(`${(t.thread_metadata?.create_timestamp || '').slice(0, 16)}  #${name(t.parent_id)}  ${t.name}  (${t.message_count ?? '?'} msgs${tagName(t).length ? ', ' + tagName(t).join(', ') : ''})`);
} else {
  for (const t of threads.filter((t) => t.name.toLowerCase().includes(q))) {
    console.log(`=== ${t.name}  #${name(t.parent_id)}  ${tagName(t).join(', ')}`);
    const msgs = [];
    let before = '';
    for (;;) {
      const page = await api(`/channels/${t.id}/messages?limit=100${before}`);
      msgs.push(...page);
      if (page.length < 100) break;
      before = `&before=${page[page.length - 1].id}`;
    }
    for (const m of msgs.reverse()) {
      console.log(`--- ${m.author.global_name || m.author.username}  ${m.timestamp.slice(0, 16).replace('T', ' ')}Z`);
      if (m.content) console.log(m.content);
      for (const a of m.attachments) console.log(`  [${a.content_type || 'file'} ${a.filename}] ${a.url}`);
    }
    console.log();
  }
}
