/* Autopilot: gets the game into the online race the page started (docs/web-lobby-plan.md,
 * section 6A) without anyone touching its menus. It does what the menus' own buttons do, by
 * calling the game's functions behind them and setting the values they set: no cursor, no clicks.
 *
 * The page (web/main.js):  rt_auto_start(role, seats, race)  role 1 host, 2 client; seats: players
 *                          rt_auto_go()                       host: everyone is ready, start
 *                          rt_auto_stop()                     the menus are the player's again
 *   and hears Module.onAuto(state): AUTO_* below.
 * Natively: RT_AUTO=host|client, RT_AUTO_SEATS=n, RT_AUTO_RACE="track=4,laps=4,night=1",
 *   RT_AUTO_GO=ms (the host starts that long after its lobby opened).
 *
 * How the game's front end works (nfs3.exe with the Modern Patch; found 2026-11-20..23):
 *  - Menus: objects of 0x24 bytes in a table at 0x6040d0 (count at 0x660bb0); +0x14 points to the
 *    menu's name (fedata/menus/<name>.mnu), +0x10 is its tick, called every frame by the front
 *    end's loop (0x44b230) with eax = edx = the menu. The shown menu is at 0x559230. The tick's
 *    return value is an action code for the loop: 5 = the focused button's next menu, 6 = run the
 *    race, 9 = switch to the menu whose name 0x559224 points to (the game uses it for credits).
 *  - Host: Create Game (0x440040) asks for a name, then "Host Game" sets 0x7a22e4 (0 = Peer-to-
 *    Peer, 2 players; 1 = Client-Server, up to 8), and its Ok (0x43f7e0) calls 0x49e5f0(eax = the
 *    game's name, edx = 1) to open the session; then the lobby (mainmult).
 *  - Client: the IPX screen's tick fills the game list ([0x5f3ff0]: a 16-bit count, then [+4] ->
 *    64-byte entries, the session's address at +0x2c); Join Game (0x43fdd0) calls 0x49e800(eax ->
 *    that address); then the lobby.
 *  - Lobby: Ready to Race / Start Race is one button (0x461270): a client flips its ready flag
 *    0x6fd508; the host sets 0x6fd508 = 1 once every other player is ready (0x49ab60: at least 2
 *    players [0x7a2276], and for slots 1.. the player found in the slot table 0x7a227a has its
 *    ready byte at 0x79f5f8 + 0x60 * index). The lobby's own per-frame code sends the flags and
 *    starts the race on everyone's game.
 *  - Each player's car, gearbox and colour: apply_me(). The race settings are the player config block's fields (config.dat at 0x6fbb40), and what the
 *    host's lobby holds is sent to the others: track 0x6fd4ac, laps as an index 0x6fd4b0 (16 bits:
 *    0 = 2 laps, 1 = 4, 2 = 8; the race recounts its laps 0x6fd4b4 from it), backward 0x6fd4c0,
 *    mirrored 0x6fd4c4, night 0x6fd4c8, weather 0x6fd4cc.
 *  - Game Setup's Connect Players and Connect Players' Network (IPX) are pressed the game's own
 *    way: the focus on the button (the focused widget is 0x604ee0 + 0xbc * (menu+0x18 +
 *    menu+0x1a)), then the button press function 0x461270 with Enter, whose code 5 the loop takes
 *    to the button's next menu. Switching menus without the press (code 9) gets as far as the
 *    lobby, but the race then runs on each machine against the computer only (7-8 packets per 2 s
 *    instead of ~120).
 *  - The calls are made from inside the loop: the autopilot puts its own tick (a runtime thunk) on
 *    the shown menu, which runs the menu's real tick first and then the autopilot's step.
 */
#define _GNU_SOURCE
#include "rt.h"
#include "cpu.h"
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include <time.h>
#include <stdio.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#define CUR_MENU     0x559230u
#define PENDING_MENU 0x559224u
#define MENU_TABLE   0x6040d0u
#define MENU_COUNT   0x660bb0u
#define MENU_SIZE    0x24u
#define PLAYER_NAME  0x6fd2fcu     /* config block +0x17bc: the player's name, also the game's name */
#define READY_FLAG   0x6fd508u

void call_indirect(CPU *c, uint32_t t);
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

static const char *menu_name(uint32_t m) {
    static char name[16];
    name[0] = 0;
    if (m < 0x400000u || m >= GUEST_SIZE - 0x20) return name;
    uint32_t s = RD32(m + 0x14);
    if (s < 0x400000u || s >= GUEST_SIZE - 16) return name;
    int i = 0;
    for (; i < 15; i++) { uint8_t ch = RD8(s + (uint32_t)i); if (ch < 32 || ch > 126) break; name[i] = (char)ch; }
    name[i] = 0;
    return name;
}
/* the shown menu's name ("setup", "connect", "ipx", "mainmult", "pause" in a race, ...), or "" */
const char *auto_menu(void) { return menu_name(RD32(CUR_MENU)); }
static uint32_t menu_by_name(const char *n) {
    uint32_t count = RD32(MENU_COUNT);
    for (uint32_t i = 0; i < count && i < 256; i++) {
        uint32_t m = MENU_TABLE + i * MENU_SIZE;
        char name[16]; snprintf(name, sizeof name, "%s", menu_name(m));
        if (!strcasecmp(name, n)) return m;
    }
    return 0;
}

/* a short string in guest memory (for calls that take a name); a few slots, reused */
static uint32_t scratch_str(const char *s) {
    static uint32_t buf[4]; static int k;
    extern uint32_t galloc(uint32_t n);
    int i = k++ & 3;
    if (!buf[i]) buf[i] = galloc(64);
    snprintf((char *)(G + buf[i]), 64, "%s", s);
    return buf[i];
}
/* a game function, Watcom style (eax, edx, ebx, ecx), from inside the game's own call chain */
static uint32_t gcall(CPU *c, uint32_t fn, uint32_t eax, uint32_t edx, uint32_t ebx, uint32_t ecx) {
    uint32_t save[8]; memcpy(save, c->r, sizeof save);
    uint32_t fl[5] = { c->cf, c->zf, c->sf, c->of, c->pf };
    c->r[EAX] = eax; c->r[EDX] = edx; c->r[EBX] = ebx; c->r[ECX] = ecx;
    PUSH32(RET_SENTINEL);
    call_indirect(c, fn);
    uint32_t ret = c->r[EAX];
    memcpy(c->r, save, sizeof save);
    c->cf = fl[0]; c->zf = fl[1]; c->sf = fl[2]; c->of = fl[3]; c->pf = fl[4];
    return ret;
}

/* a button pressed the game's own way: the focus on it, then the press function with Enter;
 * returns the action code for the loop, or -1 when the menu has no such button */
static int64_t press(CPU *c, uint32_t menu, const char *codelink) {
    uint32_t w = gcall(c, 0x442a40u, menu, scratch_str(codelink), 0, 0);
    if (!w) return -1;
    int idx = (int)((w - 0x604ee0u) / 0xbcu);                       /* the focused widget: 0x604ee0 + 0xbc * (menu+0x18 + menu+0x1a) */
    WR16(menu + 0x1a, (uint16_t)(idx - (int16_t)RD16(menu + 0x18)));
    return gcall(c, 0x461270u, w, 0, 0xd, 0);
}

/* ---------------------------------------------------------------- reporting */
enum { AUTO_OFF = 0, AUTO_MENUS = 1, AUTO_CREATED = 2, AUTO_JOINED = 3, AUTO_READY = 4, AUTO_RACING = 5, AUTO_LOBBY = 6, AUTO_FAILED = 9 };
static int state;
static void report(int s) {
    if (s == state) return;
    state = s;
    rt_log("auto: state %d", s);
#ifdef __EMSCRIPTEN__
    MAIN_THREAD_ASYNC_EM_ASM({ if (Module.onAuto) Module.onAuto($0); }, s);
#endif
}

/* ---------------------------------------------------------------- the race's settings
 * "track=4,laps=4,back=0,mirror=0,night=1,weather=0,cls=3,opp=0,skill=0,aicar=1,traffic=1,
 * abrake=0,acoll=0,atrac=0,aline=0,anav=0" (the host's), "car=diab,trans=1,color=2" (everyone's).
 * The race's are the game's lists (the table at 0x5563e8: name, items, variable), each value the
 * position in its list: classLimiter 0x6fd504 (A, B, C, unlimited), oppnumber 0x6fd4d0 (none,
 * one, full grid), ai 0x6fd4f0 (normal, aggressive), opcars 0x6fd4d4 (none, class A, B, C, then
 * single cars), traffic 0x6fd4e8 (on, off), braking 0x6fd474, collision 0x6fd484, traction
 * 0x6fd488, bestline 0x6fd47c, navigator 0x6fd480 (off, on), laps 0x6fd4b0 (2, 4, 8). */
static char race_spec[256];
static void apply_race(void) {
    static const struct { const char *key; uint32_t addr; } F[] = {
        {"track", 0x6fd4acu}, {"back", 0x6fd4c0u}, {"mirror", 0x6fd4c4u}, {"night", 0x6fd4c8u}, {"weather", 0x6fd4ccu},
        {"cls", 0x6fd504u}, {"opp", 0x6fd4d0u}, {"skill", 0x6fd4f0u}, {"aicar", 0x6fd4d4u}, {"traffic", 0x6fd4e8u},
        {"abrake", 0x6fd474u}, {"acoll", 0x6fd484u}, {"atrac", 0x6fd488u}, {"aline", 0x6fd47cu}, {"anav", 0x6fd480u},
    };
    char buf[256]; snprintf(buf, sizeof buf, "%s", race_spec);
    for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
        char *eq = strchr(tok, '='); if (!eq) continue; *eq = 0;
        int v = atoi(eq + 1);
        if (!strcmp(tok, "laps")) {
            int idx = v >= 8 ? 2 : v >= 4 ? 1 : 0;
            WR16(0x6fd4b0u, (uint16_t)idx); WR32(0x6fd4b4u, (uint32_t)(idx == 2 ? 8 : idx == 1 ? 4 : 2));
            continue;
        }
        for (size_t i = 0; i < sizeof F / sizeof *F; i++) if (!strcmp(tok, F[i].key)) WR32(F[i].addr, (uint32_t)v);
    }
    rt_log("auto: race set: %s", race_spec);
}
/* the player's car (cars 0x6fd2bc: the car list's index; the car records, 0x439a50(index), have
 * the car's folder name at +0x110), gearbox (trans 0x6fd2d4: manual, automatic) and colour (the
 * Colour button: 0x439760(car) colours, 0x4397d0(car, player 0, index) sets one) */
static void apply_me(CPU *c) {
    char buf[256]; snprintf(buf, sizeof buf, "%s", race_spec);
    int car = -1, trans = -1, color = -1;
    for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
        char *eq = strchr(tok, '='); if (!eq) continue; *eq = 0;
        if (!strcmp(tok, "car")) {
            for (uint32_t id = 0; id < 0x32 && car < 0; id++) {
                uint32_t r = gcall(c, 0x439a50u, id, 0, 0, 0);
                if (r && !strncasecmp((char *)(G + r + 0x110), eq + 1, 8) && !RD8(r + 0x110 + (uint32_t)strlen(eq + 1))) car = (int)id;
            }
            if (car < 0) rt_log("auto: no car %s in this game", eq + 1);
        }
        else if (!strcmp(tok, "trans")) trans = atoi(eq + 1);
        else if (!strcmp(tok, "color")) color = atoi(eq + 1);
    }
    if (car >= 0) WR32(0x6fd2bcu, (uint32_t)car);
    if (trans == 0 || trans == 1) WR32(0x6fd2d4u, (uint32_t)trans);
    uint32_t id = RD32(0x6fd2bcu);
    if (color >= 0 && color < (int)gcall(c, 0x439760u, id, 0, 0, 0)) gcall(c, 0x4397d0u, id, 0, (uint32_t)color, 0);
    rt_log("auto: my car %u, gearbox %u, colour %u", id, RD32(0x6fd2d4u), gcall(c, 0x439790u, id, 0, 0, 0));
}

/* every other player in the game's lobby is ready (what 0x49ab60 checks before Start Race) */
static int all_ready(void) {
    int n = (int16_t)RD16(0x7a2276u);
    if (n < 2) return 0;
    for (int slot = 1; slot < n; slot++) {
        int idx = -1;
        for (int i = 0; i < 8; i++) if ((int16_t)RD16(0x7a227au + 2u * (uint32_t)i) == slot) { idx = i; break; }
        if (idx < 0 || !RD8(0x79f5f8u + 0x60u * (uint32_t)idx)) return 0;
    }
    return 1;
}

/* ---------------------------------------------------------------- the walk */
static int role;                                  /* 0 not yet, -1 off, 1 host, 2 client */
static int seats = 2;                             /* players in the race */
static int go;                                    /* host: start the race (everyone is in and ready) */
static double go_after;                           /* natively: RT_AUTO_GO=ms in the game's lobby */
static int raced;                                 /* the race has started */
static char step_menu[16]; static double menu_since; static int tries;
static double next_try;

static uint32_t to_menu(const char *name) {      /* action code 9 with the menu's name pending (0: unknown menu) */
    uint32_t m = menu_by_name(name);
    if (!m) { rt_log("auto: no %s menu", name); return 0; }
    WR32(PENDING_MENU, RD32(m + 0x14));
    return 9;
}

/* the step for the shown menu, from inside its tick; returns an action code for the loop (0: none) */
static uint32_t step(CPU *c, uint32_t menu) {
    const char *m = menu_name(menu);
    double t = now_ms();
    if (strcmp(m, step_menu)) {                                      /* a new screen: let it settle */
        if (!step_menu[0] || !strcmp(m, "mainmult")) apply_me(c);    /* my car, before the lobby sends it */
        snprintf(step_menu, sizeof step_menu, "%s", m); menu_since = t; tries = 0;
        next_try = t + (!strcmp(m, "ipx") ? 1500 : 400);
        if (!strcmp(m, "mainmult")) {
            report(role == 1 ? AUTO_CREATED : AUTO_JOINED);
            if (role == 1 && race_spec[0]) apply_race();             /* the host's lobby holds the race; the others get it */
            if (role == 2) next_try = t + 1500;                      /* a moment in the lobby, then ready */
        }
    }
    if (t < next_try) return 0;

    if (!strcmp(m, "ipx") && role == 1) {                            /* host: open the session */
        if (tries++ >= 3) { rt_log("auto: couldn't create the game"); report(AUTO_FAILED); role = -1; return 0; }
        WR32(0x7a22e4u, seats > 2 ? 1u : 0u);                        /* Peer-to-Peer (2 only) or Client-Server */
        WR32(0x6fd50cu, 0); WR32(0x5f3fe8u, 0);                      /* as the Host Game box leaves them for IPX */
        uint32_t ok = gcall(c, 0x49e5f0u, PLAYER_NAME, 1, 0, 0);
        rt_log("auto: host: create game \"%s\" (%s) -> %u", (char *)(G + PLAYER_NAME), seats > 2 ? "client-server" : "peer-to-peer", ok);
        next_try = t + 3000;
        return ok ? to_menu("mainmult") : 0;                         /* to the game's lobby */
    }
    if (!strcmp(m, "ipx") && role == 2) {                            /* client: join the host's game once it's listed */
        next_try = t + 1000;
        uint32_t list = RD32(0x5f3ff0u);
        int n = list ? (int16_t)RD16(list) : 0;
        if (n <= 0) {                                                /* the game only searches when the screen opens: search again */
            if (t - menu_since > 60000) { rt_log("auto: no game to join"); report(AUTO_FAILED); role = -1; return 0; }
            next_try = t + 3000;
            int64_t code = press(c, menu, "refreshlist");
            rt_log("auto: client: search again -> %d", (int)code);
            return code > 0 ? (uint32_t)code : 0;
        }
        uint32_t e = RD32(list + 4);                                 /* one race per room: the room's game is the only one */
        if (tries++ >= 3) { rt_log("auto: couldn't join"); report(AUTO_FAILED); role = -1; return 0; }
        uint32_t ok = gcall(c, 0x49e800u, e + 0x2c, 0, 0, 0);
        rt_log("auto: client: join \"%.20s\" (1 of %d listed) -> %u", (char *)(G + e), n, ok);
        next_try = t + 3000;
        return ok ? to_menu("mainmult") : 0;
    }
    if (!strcmp(m, "mainmult") && role == 2) {                       /* client: ready */
        if (!RD32(READY_FLAG)) { WR32(READY_FLAG, 1); rt_log("auto: client: ready"); }
        report(AUTO_READY);
        next_try = t + 2000;
        return 0;
    }
    if (!strcmp(m, "mainmult") && role == 1) {                       /* host: start once the page says so and all are ready */
        next_try = t + 500;
        if (go && all_ready() && !RD32(READY_FLAG)) { WR32(READY_FLAG, 1); rt_log("auto: host: start race"); }
        return 0;
    }
    /* any screen before: Connect Players (its start finds the game's network providers, which
     * creating or joining a game needs), then the IPX screen */
    if (tries++ >= 3) return 0;
    next_try = t + 2000;
    /* Game Setup and Connect Players: their button is pressed the game's own way (0x461270 with
     * Enter on the widget), so whatever the button sets up happens as it would for a player */
    const char *button = !strcmp(m, "setup") ? "SETUP_CONNECTPLAYERS" : !strcmp(m, "connect") ? "ipx" : NULL;
    if (button) {
        int64_t code = press(c, menu, button);
        if (code >= 0) { rt_log("auto: pressed %s on %s -> %d", button, m, (int)code); return (uint32_t)code; }
        rt_log("auto: no %s button on %s", button, m);
    }
    const char *to = !strcmp(m, "connect") ? "ipx" : "connect";
    rt_log("auto: to %s from %s", to, m);
    return to_menu(to);
}

/* the autopilot's tick, on the shown menu: the menu's own tick first, then the step */
#define HOOKS 32
static struct { uint32_t menu, orig; } hooks[HOOKS]; static int nhooks;
static uint32_t hook_thunk;
static uint32_t orig_tick(uint32_t menu) { for (int i = 0; i < nhooks; i++) if (hooks[i].menu == menu) return hooks[i].orig; return 0; }
static uint32_t hook_tick(CPU *c, const uint32_t *a) {
    (void)a;
    uint32_t menu = c->r[EAX], orig = orig_tick(menu);
    uint32_t code = orig ? gcall(c, orig, menu, menu, c->r[EBX], c->r[ECX]) : 0;
    if (code || role <= 0 || raced) return code;
    return step(c, menu);
}
static void hook_menu(uint32_t menu) {
    if (!menu || RD32(menu + 0x10) == hook_thunk) return;
    if (!hook_thunk) hook_thunk = thunk_new("autopilot_tick", hook_tick, 0);
    int known = 0;
    for (int i = 0; i < nhooks; i++) if (hooks[i].menu == menu) { hooks[i].orig = RD32(menu + 0x10); known = 1; }
    if (!known && nhooks < HOOKS) { hooks[nhooks].menu = menu; hooks[nhooks].orig = RD32(menu + 0x10); nhooks++; }
    WR32(menu + 0x10, hook_thunk);
}
static void unhook_all(void) {
    for (int i = 0; i < nhooks; i++) if (RD32(hooks[i].menu + 0x10) == hook_thunk) WR32(hooks[i].menu + 0x10, hooks[i].orig);
    nhooks = 0;
}

static void begin(int r, int n, const char *race) {
    role = r; seats = n < 2 ? 2 : n; go = 0; raced = 0; step_menu[0] = 0;
    snprintf(race_spec, sizeof race_spec, "%s", race ? race : "");
    rt_log("auto: %s, %d players, race %s", r == 1 ? "host" : "client", seats, race_spec[0] ? race_spec : "(the game's)");
    report(AUTO_MENUS);
}
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void rt_auto_start(int r, int n, const char *race) { begin(r, n, race); }
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void rt_auto_go(void) { if (role == 1 && !go) { go = 1; rt_log("auto: go"); } }
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void rt_auto_stop(void) { if (role > 0) rt_log("auto: stopped"); role = -1; report(AUTO_OFF); }

/* every frame (game_frame, on the game's thread): watch the menus, hook the shown one */
void autopilot_frame(void) {
    static char last[16] = "?";
    const char *m = auto_menu();
    if (strcmp(m, last)) {
        rt_log("auto: menu %s", m[0] ? m : "(none)"); snprintf(last, sizeof last, "%s", m);
        if (!strcmp(m, "pause") && role > 0)                         /* the race is loaded */
        {
            rt_log("auto: racing track=%u laps=%u back=%u mirror=%u night=%u weather=%u class=%u opp=%u skill=%u aicar=%u traffic=%u", RD32(0x6fd4acu), RD32(0x6fd4b4u),
                   RD32(0x6fd4c0u), RD32(0x6fd4c4u), RD32(0x6fd4c8u), RD32(0x6fd4ccu), RD32(0x6fd504u), RD32(0x6fd4d0u), RD32(0x6fd4f0u), RD32(0x6fd4d4u), RD32(0x6fd4e8u));
            char w[200]; int k = 0;                                  /* the lobby's players: car, gearbox (records at 0x79f5f8, 0x60 each) */
            for (int i = 0; i < (int16_t)RD16(0x7a2276u) && i < 8; i++) k += snprintf(w + k, sizeof w - (size_t)k, "[%d: car %u gearbox %u] ", i, RD8(0x79f604u + 0x60u * (uint32_t)i), RD8(0x79f605u + 0x60u * (uint32_t)i));
            rt_log("auto: racers %s", w);
        }
    }
    if (!role) {                                                     /* natively: RT_AUTO */
        const char *e = getenv("RT_AUTO");
        role = -1;
        if (e && (!strcmp(e, "host") || !strcmp(e, "client"))) {
            if (getenv("RT_AUTO_GO")) go_after = atof(getenv("RT_AUTO_GO"));
            begin(!strcmp(e, "host") ? 1 : 2, getenv("RT_AUTO_SEATS") ? atoi(getenv("RT_AUTO_SEATS")) : 2, getenv("RT_AUTO_RACE"));
        }
    }
    if (role <= 0) { if (nhooks) unhook_all(); return; }
    if (!m[0]) return;
    if (!strcmp(m, "pause")) { if (!raced) { raced = 1; unhook_all(); report(AUTO_RACING); } return; }
    if (raced) {                                                     /* after the race: the menus are the player's (for now) */
        if (!strcmp(m, "mainmult")) { report(AUTO_LOBBY); role = -1; rt_log("auto: back in the game's lobby, done"); }
        return;
    }
    if (role == 1 && go_after > 0 && !go && !strcmp(m, "mainmult") && now_ms() - menu_since > go_after) { go = 1; rt_log("auto: go (RT_AUTO_GO)"); }
    hook_menu(RD32(CUR_MENU));
}
