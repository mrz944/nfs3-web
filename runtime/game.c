/* Changes to how the game plays (NFS3 with the Modern Patch 1.6.2: the addresses are its).
 *
 * Everything unlocked from the start: the bonus track and the bonus cars the game hands out
 * for winning tournaments and the like. They live in the player config (fedata/config/config.dat,
 * loaded to 0x6fbb40): a byte of awarded cars at +0x1768 (0x6fd2a8) and the Empire City flag at
 * +0x176c (0x6fd2ac). The game tests the bits when it builds its car and track lists, sets them
 * itself when you win them, clears both for a fresh config, and saves them on exit. Setting them
 * every frame covers all of that. RT_LOCKED=1 keeps the original locks.
 *   bit 0 El Niño, 1 Mercedes CLK GTR, 2 Jaguar XJR-15, 3 Pursuit Lamborghini Diablo SV,
 *   4 Pursuit El Niño (the "... Awarded" messages, text.eng 0x1b2-0x1b9)
 *
 * Instant steering (RT_INSTANT_STEER=1, the start page's setting): the "instant steering" trick
 * players got with a joystick, for any controls. Each physics tick the game moves a car's
 * steering (car +0x51c, -128..127) toward where the controls point (+0x518) by a few steps,
 * a quarter second from centre to full lock, unless the car's player block says otherwise:
 * it reads the word at +0x24 of the block (car +0x220 -> 0x6fd52c + 0x6c * slot, in the player
 * config) and with 0 there it sets the steering to the controls at once (0x4aa262). That word
 * comes from config.dat (1 for both human slots) and, online, from the other players. It is
 * read nowhere else. So for the local players' slots it is held at 0, and config.dat is written
 * with the values the game had there, so the setting never sticks in the player's config.
 *
 * The graphics options list each mode as "W x H x depth" (format at 0x538d48), the depth from
 * the Voodoo2 driver, which only did 16-bit colour. Here every frame is drawn in 32-bit colour
 * (runtime/gpu.c), so the label says 32; the mode's own depth value is left alone.
 *
 * Lap times for the start page's lap records: each car (the table at 0x5efac8, 8 pointers) counts
 * its finished laps at +0x204 and keeps each lap's time at +0x240 + 4 * lap (8 laps, in 1/64 s);
 * +0x1e4 is the car's model code ("merc"), +0x1f0 its slot. The race: track number at 0x6fd4ac,
 * then backward 0x6fd4c0, mirrored 0x6fd4c4, night 0x6fd4c8, weather 0x6fd4cc, laps 0x6fd4d0.
 * Each lap the local player finishes goes to the page (Module.onLap), and to the log. */
#include "rt.h"
#include <string.h>
#include <strings.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/threading.h>
#endif

#define AWARDED_CARS 0x6fd2a8u
#define EMPIRE_CITY 0x6fd2acu

#define PLAYER_BLOCKS 0x6fd52cu         /* 8 x 0x6c, in the player config (0x6fbb40) */
#define STEER_RAMP(k) (PLAYER_BLOCKS + 0x6cu * (uint32_t)(k) + 0x24u)
#define CONFIG_BASE 0x6fbb40u
#define SPLIT_SCREEN 0x6fd3b0u           /* 1 with two players on one screen */
static int instant = -1;
static int32_t steer_orig[8]; static uint8_t steer_held[8];

static void instant_steering(void) {
    if (instant < 0) { instant = getenv("RT_INSTANT_STEER") && atoi(getenv("RT_INSTANT_STEER")); if (instant) rt_log("game: instant steering"); }
    if (!instant) return;
    extern int net_local_car(void);
    int me = net_local_car();                   /* -1 offline, -2 online but not known yet */
    if (me == -2) return;
    for (int k = 0; k < 8; k++) {
        int local = me >= 0 ? k == me : k == 0 || (k == 1 && RD32(SPLIT_SCREEN) == 1);
        if (!local) continue;
        int32_t v = (int32_t)RD32(STEER_RAMP(k));
        if (v != 0) { steer_orig[k] = v; steer_held[k] = 1; WR32(STEER_RAMP(k), 0); }
    }
}

/* the game writing fedata/config/config.dat: the bytes it puts there, at file offset pos;
 * returns a copy with the steering words the game had (NULL: write them as they are) */
uint8_t *game_config_write(const char *path, int64_t pos, const uint8_t *buf, uint32_t n) {
    if (instant <= 0 || pos < 0) return NULL;
    size_t l = strlen(path);
    if (l < 10 || strcasecmp(path + l - 10, "config.dat")) return NULL;
    uint8_t *out = NULL;
    for (int k = 0; k < 8; k++) {
        if (!steer_held[k]) continue;
        int64_t at = (int64_t)(STEER_RAMP(k) - CONFIG_BASE) - pos;
        for (int i = 0; i < 4; i++) {
            if (at + i < 0 || at + i >= n) continue;
            if (!out) { out = malloc(n); if (!out) return NULL; memcpy(out, buf, n); }
            out[at + i] = (uint8_t)((uint32_t)steer_orig[k] >> (8 * i));
        }
    }
    return out;
}

#define CAR_TABLE 0x5efac8u
#define RACE_TRACK 0x6fd4acu
#define RACE_BACKWARD 0x6fd4c0u
#define RACE_MIRRORED 0x6fd4c4u
#define RACE_NIGHT 0x6fd4c8u
#define RACE_WEATHER 0x6fd4ccu
#define RACE_LAPS 0x6fd4d0u
static void lap_report(uint32_t car, int lap, uint32_t ticks) {
    uint32_t code = RD32(car + 0x1e4);
    int track = (int)RD32(RACE_TRACK), laps = (int)RD32(RACE_LAPS);
    int flags = (RD32(RACE_BACKWARD) ? 1 : 0) | (RD32(RACE_MIRRORED) ? 2 : 0) | (RD32(RACE_NIGHT) ? 4 : 0) | (RD32(RACE_WEATHER) ? 8 : 0) | (instant > 0 ? 16 : 0);
    char cc[5] = {0}; memcpy(cc, &code, 4);
    for (int i = 0; i < 4; i++) if (cc[i] < 32 || cc[i] > 126) cc[i] = '?';
    rt_log("game: lap %d/%d %u:%02u.%02u (track %d, flags %#x, car %s)", lap, laps, ticks / 64 / 60, ticks / 64 % 60, ticks % 64 * 100 / 64, track, flags, cc);
#ifdef __EMSCRIPTEN__
    MAIN_THREAD_ASYNC_EM_ASM({ if (Module.onLap) Module.onLap($0, $1, $2, $3, $4, $5); }, track, flags, (int)code, lap, laps, (int)ticks);
#endif
}
static void lap_watch(void) {
    extern int net_local_car(void);
    static uint32_t seen_car; static int done;             /* laps of seen_car already reported */
    int me = net_local_car();
    if (me == -2) return;                                    /* online, own car not known yet */
    int slot = me >= 0 ? me : 0;
    uint32_t car = 0;
    for (int k = 0; k < 8; k++) {
        uint32_t p = RD32(CAR_TABLE + 4u * (uint32_t)k);
        if (p && p < GUEST_SIZE - 0x1000 && (int)RD32(p + 0x1f0) == slot) { car = p; break; }
    }
    if (!car) return;
    int n = (int)RD32(car + 0x204);
    if (car != seen_car) { seen_car = car; done = n; return; }   /* laps from before: not now */
    if (n < done) done = n;                                  /* a new race, or a restart */
    while (done < n && done < 8) {
        uint32_t ticks = RD32(car + 0x240 + 4u * (uint32_t)done);
        if (!ticks) break;                                   /* written a moment later */
        done++;
        lap_report(car, done, ticks);
    }
}

#define MODE_LABEL 0x538d48u              /* "%d x %d x %d" */
static void mode_label(void) {
    static int done;
    if (done) return;
    done = 1;
    static const char orig[] = "%d x %d x %d", now[] = "%d x %d x 32";
    if (!memcmp(G + MODE_LABEL, orig, sizeof orig)) { memcpy(G + MODE_LABEL, now, sizeof now); rt_log("game: display modes labelled 32-bit"); }
}

void game_frame(void) {
    mode_label();
    instant_steering();
    lap_watch();
    static int locked = -1;
    if (locked < 0) { locked = getenv("RT_LOCKED") && atoi(getenv("RT_LOCKED")); if (!locked) rt_log("game: everything unlocked (bonus cars and Empire City)"); }
    if (locked) return;
    if ((RD8(AWARDED_CARS) & 0x1f) != 0x1f) WR8(AWARDED_CARS, RD8(AWARDED_CARS) | 0x1f);
    if (RD32(EMPIRE_CITY) != 1) WR32(EMPIRE_CITY, 1);
}
