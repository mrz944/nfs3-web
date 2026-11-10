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
 * with the values the game had there, so the setting never sticks in the player's config. */
#include "rt.h"
#include <string.h>
#include <strings.h>

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

void game_frame(void) {
    instant_steering();
    static int locked = -1;
    if (locked < 0) { locked = getenv("RT_LOCKED") && atoi(getenv("RT_LOCKED")); if (!locked) rt_log("game: everything unlocked (bonus cars and Empire City)"); }
    if (locked) return;
    if ((RD8(AWARDED_CARS) & 0x1f) != 0x1f) WR8(AWARDED_CARS, RD8(AWARDED_CARS) | 0x1f);
    if (RD32(EMPIRE_CITY) != 1) WR32(EMPIRE_CITY, 1);
}
