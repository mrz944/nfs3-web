# Discord server

One server for all the browser builds (nfs2se.xyz, nfs3.xyz, nfs4.xyz, and later ones). Its
layout and texts are in `tools/discord/content.mjs`; `tools/discord/setup.mjs` makes the server
match that file, and can be run again after any edit.

| Category | Channels |
|---|---|
| Start here | `#rules` (read-only, the Community rules channel), `#changelog` (announcements, can be followed from other servers), `#faq` (read-only) |
| Community | `#general`, `#help` |
| Feedback | `#bug-reports` and `#suggestions`: forums, a tag required (game; device for bugs), status tags only moderators can set |
| Staff | `#mod-chat`: Developer and Moderator only; Discord's Community notices and AutoMod alerts go here |

Roles: **Developer** (given to the server owner) and **Moderator**. AutoMod blocks mention spam,
suspected spam, slurs and sexual content.

## Set it up

Discord doesn't let bots create servers, so two things are done by hand, once.

1. **The server.** In Discord: *+ (Add a Server) → Create My Own → For me and my friends*, any
   name (the script renames it to *NFS Classics Web*). Upload an icon if you like.
2. **A bot for the script.** At <https://discord.com/developers/applications>:
   *New Application* (e.g. *Pit Crew*) → **Bot** → *Reset Token* → copy the token. Save it
   (git-ignored, readable only by you):

   ```sh
   mkdir -p build/discord && (umask 077; cat > build/discord/token)   # paste, Enter, Ctrl+D
   ```

   Then **OAuth2 → URL Generator**: scopes `bot`, bot permissions `Administrator`; open the
   generated URL and add the bot to the new server.
3. **Run the script** from the repository root:

   ```sh
   node tools/discord/setup.mjs --dry   # what it would do
   node tools/discord/setup.mjs
   ```

   It prints the permanent invite (`https://discord.gg/...`). Discord's default `#general` is
   reused; the default *Voice Channels* category and its *General* voice channel are left alone
   (delete them in Discord if you don't want them).

The bot only acts when a script runs. Keep it in the server for `changelog.mjs` and later edits
of `content.mjs`; to retire it, kick it and reset its token.

## Changelog

Each site has a changelog for players in `web/changelog.json` (this repository and the
`nfs2-webgl` and `nfs4-webgl` checkouts next to it): one entry per day (05:00 to 05:00 Polish
time), newest first, each change marked `new`, `improved` or `fixed`. The start page shows it
under **What's New…** in the menu (also at `https://nfs3.xyz/#changelog`); the button says NEW
until a visitor has seen the newest day. The file is read when the page loads, so an edit is live
at once.

After adding or editing a day, post it to Discord:

```sh
node tools/discord/changelog.mjs --dry   # preview
node tools/discord/changelog.mjs
```

It posts one message per day with every game's changes for that day, oldest first, and
publishes new ones to servers following `#changelog`. A day already posted is edited in place.
Message ids per day are kept in `build/discord/state.json`.

## Adding a game

Add a line to `GAMES` in `tools/discord/content.mjs` (tag, emoji, name, year, site, repository,
checkout folder) and run `setup.mjs`: the forum tags, the welcome text and the FAQ's game list
follow, and `changelog.mjs` reads its `web/changelog.json`. Game-specific FAQ answers are
written out in `MESSAGES.faq`.
