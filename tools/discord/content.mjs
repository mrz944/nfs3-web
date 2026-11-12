// The Discord server for the browser builds (nfs2se.xyz, nfs3.xyz, nfs4.xyz): its layout and
// texts. tools/discord/setup.mjs makes the server match this file; edit here and run it again.
//
// In texts, {#name} becomes a link to that channel and {@Role} a mention of that role.
// Each message is at most 2000 characters (Discord's limit; setup.mjs checks).

// The games. Adding one (NFS5) = a line here: it shows up in the forum tags and the texts below.
// dir: its checkout next to this repository (for changelog.mjs).
export const GAMES = [
  { tag: 'NFS II SE', emoji: '🟨', name: 'Need for Speed II: Special Edition', year: 1997, site: 'nfs2se.xyz', repo: 'mrz944/nfs2se-web', dir: 'nfs2-webgl' },
  { tag: 'NFS III', emoji: '🟦', name: 'Need for Speed III: Hot Pursuit', year: 1998, site: 'nfs3.xyz', repo: 'mrz944/nfs3-web', dir: 'nfs3-webgl' },
  { tag: 'NFS4 High Stakes', emoji: '🟥', name: 'Need for Speed: High Stakes', year: 1999, site: 'nfs4.xyz', repo: 'mrz944/nfs4-web', dir: 'nfs4-webgl' },
];

export const SERVER = {
  name: 'NFS Classics Web',
  description: 'Classic Need for Speed PC games recompiled to run in your browser: nfs2se.xyz, nfs3.xyz and nfs4.xyz. Fan project.',
};

export const ROLES = [
  { key: 'Developer', color: 0xffd800, hoist: true, mod: true, owner: true },   // given to the server owner
  { key: 'Moderator', color: 0x3c6ef0, hoist: true, mod: true },
];

const gameTags = GAMES.map((g) => ({ name: g.tag, emoji: g.emoji }));
const siteList = GAMES.map((g) => `- **${g.name}** (${g.year}): <https://${g.site}>`).join('\n');

// Channels in display order. kind: category | text | announcement | forum.
// readonly: only Developer and Moderator post. staff: only they see it.
export const CHANNELS = [
  { key: 'info', kind: 'category', name: 'Start here' },
  { key: 'rules', kind: 'text', parent: 'info', name: 'rules', readonly: true, topic: 'Server rules and links to the games. Read before posting.' },
  { key: 'changelog', kind: 'announcement', parent: 'info', name: 'changelog', readonly: true, topic: 'What changed on nfs2se.xyz, nfs3.xyz and nfs4.xyz. Follow it to get updates in your own server.' },
  { key: 'faq', kind: 'text', parent: 'info', name: 'faq', readonly: true, topic: 'Common questions: browsers, game files, phones, controllers, online races.' },

  { key: 'community', kind: 'category', name: 'Community' },
  { key: 'general', kind: 'text', parent: 'community', name: 'general', topic: 'Talk about the games, races, old memories. Bugs go to #bug-reports, ideas to #suggestions.' },
  { key: 'help', kind: 'text', parent: 'community', name: 'help', topic: 'Stuck? Say which game, your browser and device, and what you see.' },

  { key: 'feedback', kind: 'category', name: 'Feedback' },
  { key: 'bugs', kind: 'forum', parent: 'feedback', name: 'bug-reports', requireTag: true, reaction: '👍',
    topic: [
      'One bug per post. Search first: if it is already here, add a 👍 and your details there.',
      'Pick the game tag and your device tag.',
      '',
      'Please include:',
      '- browser and version, device and operating system',
      '- what you did, what happened, what you expected',
      '- roughly when it happened, with your time zone (the site keeps a technical log of each session, which helps find the cause)',
      '- a screenshot or a short video if you can',
      '- for a crash: the error text the page shows',
    ].join('\n'),
    tags: [
      ...gameTags,
      { name: 'Windows', emoji: '🪟' }, { name: 'macOS', emoji: '🍎' }, { name: 'Linux', emoji: '🐧' },
      { name: 'Android', emoji: '🤖' }, { name: 'iPhone / iPad', emoji: '📱' },
      { name: 'Confirmed', emoji: '🔎', moderated: true }, { name: 'Fixed', emoji: '✅', moderated: true },
      { name: "Can't reproduce", emoji: '❔', moderated: true }, { name: 'Duplicate', emoji: '♻️', moderated: true },
    ] },
  { key: 'ideas', kind: 'forum', parent: 'feedback', name: 'suggestions', requireTag: true, reaction: '👍',
    topic: [
      'One idea per post. Search first: if it is already here, give it a 👍 and add to it.',
      'Pick the game tag (or Website for the pages, lobby and online rooms).',
      'Say what you would like and why. Ideas that change how the original games drive are unlikely: the point is the real game, as it was.',
    ].join('\n'),
    tags: [
      ...gameTags, { name: 'Website', emoji: '🌐' },
      { name: 'Planned', emoji: '🗓️', moderated: true }, { name: 'Done', emoji: '✅', moderated: true }, { name: 'Not planned', emoji: '🚫', moderated: true },
    ] },

  { key: 'staff', kind: 'category', name: 'Staff', staff: true },
  { key: 'modchat', kind: 'text', parent: 'staff', name: 'mod-chat', staff: true, topic: 'Moderators only. Discord sends its Community notices here.' },
];

// Messages kept in the read-only channels, in order. setup.mjs edits them in place on later runs.
export const MESSAGES = {
  rules: [
`# Welcome to NFS Classics Web
Classic Need for Speed PC games, recompiled to run in your browser. No emulator and no remake: the original game code, translated to WebAssembly, with online races added.

${siteList}

-# Fan project, not affiliated with or endorsed by Electronic Arts. Need for Speed is a trademark of Electronic Arts.

**Where to go**
- {#faq}: common questions, read this first
- {#help}: stuck? ask here
- {#bug-reports}: something broken? one post per bug
- {#suggestions}: ideas for the games and the sites
- {#changelog}: what changed, follow it for updates
- {#general}: everything else`,

`# Rules
**1. Be decent.** No harassment, hate speech, slurs or personal attacks. Argue with ideas, not people.
**2. English in the public channels**, so everyone can follow.
**3. Right channel.** Questions in {#help}, bugs in {#bug-reports}, ideas in {#suggestions}.
**4. No piracy.** Don't share or ask for game downloads, ISOs, cracks or CD keys.
**5. No spam or ads.** No self-promotion, no invite links to other servers, no unsolicited DMs.
**6. Nothing NSFW** or shocking, including names and avatars.
**7. Race fair.** Don't post faked lap records, don't grief online rooms, don't impersonate other players or the staff.
**8. Follow Discord's rules:** <https://discord.com/terms> and <https://discord.com/guidelines>.

Moderators may remove posts and mute, kick or ban to keep the place friendly. Questions about moderation: ask a {@Moderator}.`,
  ],

  faq: [
`# FAQ
**What is this?**
The original PC games, statically recompiled: their x86 code is translated to C and then WebAssembly, so the real game logic, handling, AI and sound run in your browser. Windows, DirectX, the 3dfx Voodoo card and the network are replaced by a small runtime for the web.
${siteList}

**Do I need my own copy of the game?**
- **NFS II SE and NFS III:** no setup. The game files download once into your browser's private storage, then Start is one click.
- **NFS4 High Stakes:** yes. Install it with VEG's Modern Patch, then pick its folder on the page once. It is copied into the browser's storage and never uploaded.

**Which browsers work?**
Recent Chrome, Edge, Firefox or Safari, with WebGL 2. A desktop or laptop gives the best results. If the page says WebGL 2 is missing or the game runs very slowly, turn on hardware acceleration in your browser's settings.

**Can I play on a phone or tablet?**
NFS II SE and NFS III have on-screen touch controls: turn the phone sideways. On iPhone, Safari can't go fullscreen; use Share → **Add to Home Screen** and play from that icon. NFS4 is desktop only for now.

**Gamepads and wheels?**
On nfs2se.xyz and nfs3.xyz: turn on *Gamepads and wheels* in Game Settings, press a button on the controller, then Start. Set the buttons up in the game's own controller options.`,

`**How do online races work?**
Make a room on the start page (or join one) and share the invite link. Everyone clicks Start Game, then picks the game's network (IPX) mode: one player creates the game, the others join it. Each start page has a step-by-step guide. Up to 8 racers per room.

**Is there a daily race?**
Yes, on nfs3.xyz at 20:00 Polish time (CET/CEST). The start page shows it, and can notify you 10 minutes before.

**Lap records?**
nfs2se.xyz and nfs3.xyz list each racer's best lap per track and direction on the start page. Laps driven with mods on don't count.

**Where are my saves and settings?**
In your browser's storage for that site, together with the game files. Clearing the site's data deletes them, and the game downloads again.

**It stutters or runs slowly.**
Close other heavy tabs, plug in your laptop, check hardware acceleration is on. Game Settings has an FPS counter. If it stays bad, post in {#help} with your browser, device and FPS.

**Something broke.**
Post in {#bug-reports} with the game and device tags. The more detail, the faster the fix.

**Is the source code available?**
Yes, for the runtime and the pages: ${GAMES.map((g) => `<https://github.com/${g.repo}>`).join(' · ')}. The games' own code and data aren't in the repositories.`,
  ],
};

// AutoMod rules (Discord's built-in filters), kept by name.
export const AUTOMOD = [
  { name: 'Mention spam', trigger_type: 5, trigger_metadata: { mention_total_limit: 6, mention_raid_protection_enabled: true } },
  { name: 'Suspected spam', trigger_type: 3, trigger_metadata: {} },
  { name: 'Slurs and sexual content', trigger_type: 4, trigger_metadata: { presets: [2, 3] } },
];
