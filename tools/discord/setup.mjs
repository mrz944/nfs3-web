// Makes the Discord server match tools/discord/content.mjs: roles, channels, forums and their tags,
// permissions, Community mode, AutoMod, the rules and FAQ messages, a permanent invite, and the
// server icon and bot avatar (server-icon.png, bot-avatar.png; drawn in icons.html).
// Safe to run again after editing content.mjs: it finds what is there by name and updates it, and
// edits its own messages in place. It never deletes channels or roles; anything it doesn't know
// about is left alone and listed at the end.
//
//   node tools/discord/setup.mjs            apply
//   node tools/discord/setup.mjs --dry      only check content.mjs and show what is on the server
//
// Needs a bot in the server with the Administrator permission (see docs/discord.md). Its token is
// read from build/discord/token (git-ignored) or DISCORD_TOKEN. What the script made (message ids,
// the invite) is kept in build/discord/state.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AUTOMOD, CHANNELS, MESSAGES, ROLES, SERVER } from './content.mjs';

const DRY = process.argv.includes('--dry');
const dir = new URL('../../build/discord/', import.meta.url);
const stateFile = new URL('state.json', dir);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = () => { mkdirSync(dir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); };

// ------------------------------------------------------------------ check content.mjs first
for (const [ch, msgs] of Object.entries(MESSAGES)) msgs.forEach((m, i) => {
  if (m.length > 1900) throw new Error(`MESSAGES.${ch}[${i}] is ${m.length} characters (mentions grow when filled in; keep it under 1900)`);
});
for (const c of CHANNELS) if (c.kind === 'forum') {
  if (c.tags.length > 20) throw new Error(`${c.name}: ${c.tags.length} tags (Discord allows 20)`);
  for (const t of c.tags) if (t.name.length > 20) throw new Error(`${c.name}: tag "${t.name}" is longer than 20 characters`);
}

// ------------------------------------------------------------------ the API
const token = (process.env.DISCORD_TOKEN || (existsSync(new URL('token', dir)) ? readFileSync(new URL('token', dir), 'utf8') : '')).trim();
if (!token) { console.error('No bot token: put it in build/discord/token (see docs/discord.md).'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  for (let tries = 0; ; tries++) {
    const r = await fetch('https://discord.com/api/v10' + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/mrz944/nfs3-web, 1)', 'X-Audit-Log-Reason': 'tools/discord/setup.mjs' },
    });
    if (r.status === 429 && tries < 8) { const j = await r.json().catch(() => ({})); await sleep((j.retry_after || 1) * 1000 + 250); continue; }
    if (r.status === 204) return null;
    const text = await r.text();
    if (!r.ok) { const e = new Error(`${method} ${path}: ${r.status} ${text}`); e.status = r.status; throw e; }
    return text ? JSON.parse(text) : null;
  }
}
const write = async (what, method, path, body) => {
  if (DRY) { console.log(`  would ${what}`); return null; }
  console.log(`  ${what}`);
  return api(method, path, body);
};

// permission bits
const P = Object.fromEntries(Object.entries({
  KICK: 1, BAN: 2, AUDIT_LOG: 7, VIEW: 10, SEND: 11, MANAGE_MESSAGES: 13, EMBED: 14, ATTACH: 15, NICKNAMES: 27,
  MANAGE_THREADS: 34, PUBLIC_THREADS: 35, PRIVATE_THREADS: 36, SEND_IN_THREADS: 38, MODERATE: 40,
}).map(([k, b]) => [k, 1n << BigInt(b)]));
const bits = (...ks) => String(ks.reduce((a, k) => a | P[k], 0n));
const MOD_PERMS = bits('KICK', 'BAN', 'AUDIT_LOG', 'MANAGE_MESSAGES', 'NICKNAMES', 'MANAGE_THREADS', 'MODERATE');
const TYPE = { text: 0, category: 4, announcement: 5, forum: 15 };

// ------------------------------------------------------------------ the server
let guildId = process.env.DISCORD_GUILD || state.guild;
if (!guildId) {
  const gs = await api('GET', '/users/@me/guilds');
  if (gs.length !== 1) { console.error(`The bot is in ${gs.length} servers; set DISCORD_GUILD to the server id.`); process.exit(1); }
  guildId = gs[0].id;
}
let guild = await api('GET', `/guilds/${guildId}`);
console.log(`server: ${guild.name} (${guild.id})${DRY ? ', dry run' : ''}`);
if (!DRY) { state.guild = guild.id; save(); }

// roles
console.log('roles');
let roles = await api('GET', `/guilds/${guildId}/roles`);
const role = {};
for (const r of ROLES) {
  const want = { name: r.key, color: r.color, hoist: r.hoist, mentionable: true, permissions: r.mod ? MOD_PERMS : '0' };
  const have = roles.find((x) => x.name === r.key);
  if (!have) role[r.key] = (await write(`create role ${r.key}`, 'POST', `/guilds/${guildId}/roles`, want))?.id || `new:${r.key}`;
  else {
    role[r.key] = have.id;
    if (have.color !== want.color || have.hoist !== want.hoist || have.permissions !== want.permissions || !have.mentionable)
      await write(`update role ${r.key}`, 'PATCH', `/guilds/${guildId}/roles/${have.id}`, want);
  }
  if (r.owner && !DRY) {
    const m = await api('GET', `/guilds/${guildId}/members/${guild.owner_id}`);
    if (!m.roles.includes(role[r.key])) await write(`give ${r.key} to the owner`, 'PUT', `/guilds/${guildId}/members/${guild.owner_id}/roles/${role[r.key]}`);
  }
}
const staffIds = ROLES.map((r) => role[r.key]).filter((id) => !id.startsWith('new:'));

function overwrites(c) {
  const everyone = { id: guildId, type: 0, allow: '0', deny: '0' };
  if (c.staff) everyone.deny = bits('VIEW');
  else if (c.readonly) everyone.deny = bits('SEND', 'PUBLIC_THREADS', 'PRIVATE_THREADS', 'SEND_IN_THREADS');
  else return [];
  return [everyone, ...staffIds.map((id) => ({ id, type: 0, deny: '0', allow: c.staff ? bits('VIEW', 'SEND') : bits('SEND', 'SEND_IN_THREADS') }))];
}
const sameOverwrites = (a, b) => {
  const k = (l) => JSON.stringify([...l].map((o) => [o.id, o.type, String(o.allow), String(o.deny)]).sort());
  return k(a) === k(b);
};

// channels: categories, then plain text ones (rules and the staff channel are needed to switch on
// Community), then announcement and forum channels, which need Community.
console.log('channels');
let channels = await api('GET', `/guilds/${guildId}/channels`);
const chan = {};                                    // key -> channel id
async function ensure(c) {
  const type = TYPE[c.kind];
  const parent = c.parent ? chan[c.parent] : null;
  const body = { name: c.name, type, parent_id: parent && !parent.startsWith('new:') ? parent : null, permission_overwrites: overwrites(c) };
  if (c.kind !== 'category') body.topic = c.topic || '';
  if (c.kind === 'forum') {
    Object.assign(body, { flags: c.requireTag ? 16 : 0, default_sort_order: 0, default_forum_layout: 1, default_reaction_emoji: c.reaction ? { emoji_id: null, emoji_name: c.reaction } : null });
  }
  // by name and kind; a text channel of that name may become the announcement channel
  const have = channels.find((x) => x.name.toLowerCase() === c.name.toLowerCase() && (x.type === type || (type === 5 && x.type === 0)));
  if (c.kind === 'forum') {                       // keep the ids of tags that are there already
    const old = have?.available_tags || [];
    body.available_tags = c.tags.map((t) => {
      const o = old.find((x) => x.name === t.name);
      return { ...(o ? { id: o.id } : {}), name: t.name, moderated: !!t.moderated, emoji_id: null, emoji_name: t.emoji || null };
    });
  }
  if (!have) { chan[c.key] = (await write(`create ${c.kind} ${c.name}`, 'POST', `/guilds/${guildId}/channels`, body))?.id || `new:${c.key}`; return; }
  chan[c.key] = have.id;
  const changed = [];
  if (have.type !== type) changed.push('type');
  if (have.name !== c.name) changed.push('name');
  if ((have.parent_id || null) !== body.parent_id) changed.push('category');
  if (c.kind !== 'category' && (have.topic || '') !== body.topic) changed.push('topic');
  if (!sameOverwrites(have.permission_overwrites || [], body.permission_overwrites)) changed.push('permissions');
  if (c.kind === 'forum') {
    const tags = (l) => JSON.stringify(l.map((t) => [t.name, !!t.moderated, t.emoji_name || null]));
    if (tags(have.available_tags || []) !== tags(body.available_tags)) changed.push('tags');
    if ((have.flags & 16) !== body.flags || have.default_reaction_emoji?.emoji_name !== c.reaction) changed.push('settings');
  }
  if (changed.length) {
    const patch = { ...body };
    if (have.type === type) delete patch.type;
    await write(`update ${c.name} (${changed.join(', ')})`, 'PATCH', `/channels/${have.id}`, patch);
  }
}
const needsCommunity = (c) => c.kind === 'announcement' || c.kind === 'forum';
for (const c of CHANNELS) if (!needsCommunity(c)) await ensure(c);

// Community: needed for the announcement channel (others can follow #changelog) and forums
console.log('community');
if (!guild.features.includes('COMMUNITY')) {
  if (chan.rules?.startsWith('new:') || chan.modchat?.startsWith('new:')) console.log('  would switch on Community (rules channel, updates to mod-chat, verified email, media scan for everyone)');
  else guild = await write('switch on Community', 'PATCH', `/guilds/${guildId}`, {
    features: [...new Set([...guild.features, 'COMMUNITY'])], verification_level: Math.max(1, guild.verification_level),
    explicit_content_filter: 2, default_message_notifications: 1, rules_channel_id: chan.rules, public_updates_channel_id: chan.modchat,
    description: SERVER.description, preferred_locale: 'en-US',
  }) || guild;
} else if (guild.description !== SERVER.description || guild.rules_channel_id !== chan.rules) {
  await write('update the description and rules channel', 'PATCH', `/guilds/${guildId}`, { description: SERVER.description, rules_channel_id: chan.rules });
}
if (guild.name !== SERVER.name) await write(`rename the server to ${SERVER.name}`, 'PATCH', `/guilds/${guildId}`, { name: SERVER.name });

// the server icon and the bot's avatar (tools/discord/icons.html), uploaded when the file changed
const image = (name) => {
  const buf = readFileSync(new URL(name, import.meta.url));
  return { data: 'data:image/png;base64,' + buf.toString('base64'), hash: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
};
const icon = image('server-icon.png'), avatar = image('bot-avatar.png');
if (state.iconHash !== icon.hash || !guild.icon) {
  if (await write('set the server icon', 'PATCH', `/guilds/${guildId}`, { icon: icon.data })) { state.iconHash = icon.hash; save(); }
}
if (state.avatarHash !== avatar.hash) {
  if (await write("set the bot's avatar", 'PATCH', '/users/@me', { avatar: avatar.data })) { state.avatarHash = avatar.hash; save(); }
}

console.log('channels needing Community');
channels = await api('GET', `/guilds/${guildId}/channels`);
for (const c of CHANNELS) if (needsCommunity(c)) await ensure(c);

// order: categories as listed, channels as listed within them
const order = [];
CHANNELS.forEach((c, i) => { const id = chan[c.key]; if (id && !id.startsWith('new:')) order.push({ id, position: i }); });
channels = await api('GET', `/guilds/${guildId}/channels`);
const pos = Object.fromEntries(channels.map((c) => [c.id, c.position]));
const sorted = (l) => l.map((o) => o.id).sort((a, b) => pos[a] - pos[b]).join();
if (sorted(order) !== order.map((o) => o.id).join()) await write('put the channels in order', 'PATCH', `/guilds/${guildId}/channels`, order);

// AutoMod
console.log('automod');
const rules = await api('GET', `/guilds/${guildId}/auto-moderation/rules`);
for (const a of AUTOMOD) {
  if (rules.some((r) => r.name === a.name)) continue;
  const actions = [{ type: 1, metadata: { custom_message: 'Blocked by the server filter. Ask a moderator if this was a mistake.' } }];
  if (chan.modchat && !chan.modchat.startsWith('new:')) actions.push({ type: 2, metadata: { channel_id: chan.modchat } });
  try {
    await write(`add AutoMod rule "${a.name}"`, 'POST', `/guilds/${guildId}/auto-moderation/rules`, {
      name: a.name, event_type: 1, trigger_type: a.trigger_type, trigger_metadata: a.trigger_metadata, actions, enabled: true,
      exempt_roles: staffIds,
    });
  } catch (e) { console.log(`  AutoMod rule "${a.name}" not added (one of this kind already there?): ${e.message}`); }
}

// messages in the read-only channels
console.log('messages');
const fill = (s) => s
  .replace(/\{#([\w-]+)\}/g, (m, name) => { const c = CHANNELS.find((x) => x.name === name); const id = c && chan[c.key]; return id && !id.startsWith('new:') ? `<#${id}>` : `#${name}`; })
  .replace(/\{@(\w+)\}/g, (m, name) => role[name] && !role[name].startsWith('new:') ? `<@&${role[name]}>` : `@${name}`);
state.messages ||= {};
for (const [key, texts] of Object.entries(MESSAGES)) {
  const cid = chan[key];
  if (!cid || cid.startsWith('new:')) { console.log(`  would post ${texts.length} message(s) in ${key}`); continue; }
  let ids = state.messages[key] || [];
  const want = texts.map(fill);
  // a message deleted by hand: post the whole set again, so the order stays right
  let ok = true;
  for (const id of ids) { try { await api('GET', `/channels/${cid}/messages/${id}`); } catch (e) { if (e.status === 404) ok = false; else throw e; } }
  if (!ok) { for (const id of ids) await api('DELETE', `/channels/${cid}/messages/${id}`).catch(() => {}); ids = []; }
  const out = [];
  for (let i = 0; i < want.length; i++) {
    const body = { content: want[i], flags: 4, allowed_mentions: { parse: [] } };   // 4: no link previews; mention nobody
    if (ids[i]) {
      const m = await api('GET', `/channels/${cid}/messages/${ids[i]}`);
      if (m.content !== want[i]) await write(`edit ${key} message ${i + 1}`, 'PATCH', `/channels/${cid}/messages/${ids[i]}`, body);
      out.push(ids[i]);
    } else out.push((await write(`post ${key} message ${i + 1}`, 'POST', `/channels/${cid}/messages`, body))?.id);
  }
  for (const id of ids.slice(want.length)) await write(`delete an extra ${key} message`, 'DELETE', `/channels/${cid}/messages/${id}`);
  if (!DRY) { state.messages[key] = out; save(); }
}

// a permanent invite, to the rules channel
console.log('invite');
if (state.invite) { try { await api('GET', `/invites/${state.invite}`); } catch (e) { if (e.status === 404) delete state.invite; else throw e; } }
if (!state.invite && chan.rules && !chan.rules.startsWith('new:')) {
  const inv = await write('make a permanent invite', 'POST', `/channels/${chan.rules}/invites`, { max_age: 0, max_uses: 0, unique: false });
  if (inv) { state.invite = inv.code; save(); }
}
if (state.invite) console.log(`  https://discord.gg/${state.invite}`);

// left alone
const known = new Set(Object.values(chan));
const extra = channels.filter((c) => !known.has(c.id));
if (extra.length) console.log(`not in content.mjs (left alone): ${extra.map((c) => `${c.name} (type ${c.type})`).join(', ')}`);
console.log(DRY ? 'dry run: nothing changed' : 'done');
