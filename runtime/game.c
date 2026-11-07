/* Changes to how the game plays (NFS3 with the Modern Patch 1.6.2: the addresses are its).
 *
 * Everything unlocked from the start: the bonus track and the bonus cars the game hands out
 * for winning tournaments and the like. They live in the player config (fedata/config/config.dat,
 * loaded to 0x6fbb40): a byte of awarded cars at +0x1768 (0x6fd2a8) and the Empire City flag at
 * +0x176c (0x6fd2ac). The game tests the bits when it builds its car and track lists, sets them
 * itself when you win them, clears both for a fresh config, and saves them on exit. Setting them
 * every frame covers all of that. RT_LOCKED=1 keeps the original locks.
 *   bit 0 El Niño, 1 Mercedes CLK GTR, 2 Jaguar XJR-15, 3 Pursuit Lamborghini Diablo SV,
 *   4 Pursuit El Niño (the "... Awarded" messages, text.eng 0x1b2-0x1b9) */
#include "rt.h"

#define AWARDED_CARS 0x6fd2a8u
#define EMPIRE_CITY 0x6fd2acu

void game_frame(void) {
    static int locked = -1;
    if (locked < 0) { locked = getenv("RT_LOCKED") && atoi(getenv("RT_LOCKED")); if (!locked) rt_log("game: everything unlocked (bonus cars and Empire City)"); }
    if (locked) return;
    if ((RD8(AWARDED_CARS) & 0x1f) != 0x1f) WR8(AWARDED_CARS, RD8(AWARDED_CARS) | 0x1f);
    if (RD32(EMPIRE_CITY) != 1) WR32(EMPIRE_CITY, 1);
}
