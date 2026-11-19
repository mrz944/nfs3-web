// The daily race as a recurring Discord event (Events at the top of the channel list): every day
// at the same time as serve.mjs --daily, Polish time, with a link to the site.
// Finds its event by name and updates it, so it is safe to run again: after changing the time, and
// on the days the clocks change (last Sunday of March and of October), because Discord repeats an
// event at the same UTC time and the race follows Polish time.
//
//   node tools/discord/daily-event.mjs [HH:MM]      default 20:00
//   node tools/discord/daily-event.mjs --dry        only show what it would do
//
// Token and server as in setup.mjs: build/discord/token (or DISCORD_TOKEN), build/discord/state.json.
import { existsSync, readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');
const hhmm = process.argv.slice(2).find((a) => /^\d{1,2}:\d{2}$/.test(a)) || '20:00';
const ZONE = 'Europe/Warsaw';
const NAME = 'Daily race on nfs3.xyz';
const DESCRIPTION = `Need for Speed III: Hot Pursuit online, in your browser. Every day at the same time: Discord shows it in your own time zone, and so does the start page of nfs3.xyz.

Racers from every country are welcome. Open https://nfs3.xyz a few minutes early, join the room on the start page (or make one and post its invite link in #find-a-race) and race. Voice chat in Race 1 if you like.`;

const dir = new URL('../../build/discord/', import.meta.url);
const token = (process.env.DISCORD_TOKEN || (existsSync(new URL('token', dir)) ? readFileSync(new URL('token', dir), 'utf8') : '')).trim();
if (!token) { console.error('No bot token: put it in build/discord/token (see docs/discord.md).'); process.exit(1); }
const { guild } = JSON.parse(readFileSync(new URL('state.json', dir), 'utf8'));
if (!guild) { console.error('No server id in build/discord/state.json: run setup.mjs first.'); process.exit(1); }

async function api(method, path, body, tries = 0) {
  const r = await fetch('https://discord.com/api/v10' + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/mrz944/nfs3-web, 1)', 'X-Audit-Log-Reason': 'tools/discord/daily-event.mjs' },
  });
  const text = await r.text();
  if (r.status === 429 && tries < 8) {
    await new Promise((ok) => setTimeout(ok, ((JSON.parse(text).retry_after || 1) * 1000) + 250));
    return api(method, path, body, tries + 1);
  }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// the next HH:MM in Polish time that is at least 10 minutes away, as a UTC Date
function nextStart() {
  const [h, m] = hhmm.split(':').map(Number);
  const offset = (t) => { // minutes Warsaw is ahead of UTC at instant t
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(t).map((x) => [x.type, Number(x.value)]));
    return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60e3) * 60e3) / 60e3;
  };
  for (let d = 0; d < 3; d++) {
    const day = new Date(Date.now() + d * 864e5);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(day).split('-').map(Number);
    const wall = Date.UTC(ymd[0], ymd[1] - 1, ymd[2], h, m);
    const t = wall - offset(wall) * 60e3; // the clocks change at night, so the offset near the wall time is the one
    if (t > Date.now() + 10 * 60e3) return new Date(t);
  }
}

const start = nextStart();
const event = {
  name: NAME,
  description: DESCRIPTION,
  entity_type: 3, // external: it happens on the site
  entity_metadata: { location: 'https://nfs3.xyz' },
  privacy_level: 2,
  scheduled_start_time: start.toISOString(),
  scheduled_end_time: new Date(start.getTime() + 3600e3).toISOString(),
  recurrence_rule: { start: start.toISOString(), frequency: 3, interval: 1 }, // daily
};

const old = (await api('GET', `/guilds/${guild}/scheduled-events`)).find((e) => e.name === NAME);
console.log(`${old ? 'update' : 'create'} "${NAME}": daily at ${hhmm} ${ZONE}, next ${start.toISOString()} (UTC)`);
if (DRY) process.exit(0);
const r = old ? await api('PATCH', `/guilds/${guild}/scheduled-events/${old.id}`, event) : await api('POST', `/guilds/${guild}/scheduled-events`, event);
console.log(`done: https://discord.com/events/${guild}/${r.id}`);
