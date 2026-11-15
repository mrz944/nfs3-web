/* WSOCK32 for online play: IPX sockets on a virtual LAN.
 *
 * NFS3's "IPX" network mode (LAN game browser, datagrams) runs on top of a
 * room on the relay server (web/relay.mjs): every room member has a 6-byte
 * node address, broadcasts reach the whole room, unicast reaches one peer.
 * In the browser the page carries packets (WebRTC peer-to-peer, relay as
 * fallback); natively a TCP connection to the relay does (RT_NET=host:port,
 * RT_ROOM=name, RT_NAME=player).
 *
 * Packet on the wire (after the 6-byte node header the relay adds/strips):
 *   u16 dst socket (BE) | u16 src socket (BE) | data
 *
 * TCP/IP (AF_INET) sockets are refused, so the game's TCP mode reports no network.
 */
#define _GNU_SOURCE
#include "rt.h"
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <math.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/threading.h>
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include <sys/un.h>
#include <fcntl.h>
#include <poll.h>
#endif

#define WSAEWOULDBLOCK 10035
#define WSAEMSGSIZE 10040
#define WSAEAFNOSUPPORT 10047
#define WSAEADDRINUSE 10048
#define WSAENOTSOCK 10038
#define WSAENETDOWN 10050
#define WSAEINVAL 10022
#define AF_IPX_ 6
#define MAXPKT 2048
#define QLEN 256
#define NSOCK 16
#define SOCK_BASE 0x4000

static __thread uint32_t last_err;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;

static uint8_t self_node[6];
static int online;                       /* joined a room */
static const uint8_t BCAST[6] = { 0xff, 0xff, 0xff, 0xff, 0xff, 0xff };

typedef struct { uint16_t len, sport; uint8_t src[6]; uint8_t data[MAXPKT]; } Pkt;
typedef struct {
    int used, nonblock, bound;
    uint32_t gen;                        /* bumped on close: wakes blocked readers */
    uint16_t port;                       /* host order */
    Pkt *q; int qh, qt;                  /* ring of QLEN */
} VSock;
static VSock socks[NSOCK];

static struct { uint64_t tx, rx, txb, rxb, drop; } stats;
static int net_trace = -1;
static double tnow(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (double)t.tv_sec + t.tv_nsec * 1e-9; }
static void trace_pkt(const char *dir, const uint8_t node[6], uint16_t dport, uint16_t sport, const uint8_t *d, int n) {
    if (net_trace < 0) net_trace = getenv("RT_NET_TRACE") != NULL;
    if (!net_trace) return;
    char h[600]; int k = 0;
    for (int i = 0; i < n && i < 256; i++) k += snprintf(h + k, sizeof h - k, "%02x", d[i]);
    rt_log("pkt %.3f %s %02x%02x %04x->%04x %4d %s", fmod(tnow(), 1000.0), dir, node[4], node[5], sport, dport, n, h);
}

/* --------------------------------------------------------------- transport */
static void transport_send(const uint8_t dst[6], const uint8_t *pkt, int len);

static void deliver_now(const uint8_t src[6], const uint8_t *p, int len);
static void pace_log(void);
/* RT_NET_DELAY=ms: hold incoming packets that long (testing a link's latency natively) */
#define DQ 1024
static struct { double due; uint8_t src[6]; uint16_t len; uint8_t p[MAXPKT + 4]; } dq[DQ];
static unsigned dq_h, dq_t; static double net_delay = -1;
static pthread_mutex_t dq_mu = PTHREAD_MUTEX_INITIALIZER; static pthread_cond_t dq_cv = PTHREAD_COND_INITIALIZER;
static void *delay_main(void *unused) {
    (void)unused;
    pthread_mutex_lock(&dq_mu);
    for (;;) {
        while (dq_h == dq_t) pthread_cond_wait(&dq_cv, &dq_mu);
        double w = dq[dq_t].due - tnow();
        if (w > 0) { pthread_mutex_unlock(&dq_mu); usleep((useconds_t)(w * 1e6)); pthread_mutex_lock(&dq_mu); continue; }
        uint8_t src[6], p[MAXPKT + 4]; int len = dq[dq_t].len;
        memcpy(src, dq[dq_t].src, 6); memcpy(p, dq[dq_t].p, (size_t)len); dq_t = (dq_t + 1) % DQ;
        pthread_mutex_unlock(&dq_mu); deliver_now(src, p, len); pthread_mutex_lock(&dq_mu);
    }
    return NULL;
}
/* a packet from the network (any thread) */
void net_deliver(const uint8_t src[6], const uint8_t *p, int len) {
    if (len < 4) return;
    static double loss = -1;            /* RT_NET_LOSS=percent: drop incoming packets (testing) */
    if (loss < 0) { const char *e = getenv("RT_NET_LOSS"); loss = e ? atof(e) / 100.0 : 0; }
    if (loss > 0 && (double)rand() / RAND_MAX < loss) { stats.drop++; return; }
    static double jitter = -1;          /* RT_NET_JITTER=ms: plus up to that much more, at random (no reordering) */
    if (net_delay < 0) {
        const char *e = getenv("RT_NET_DELAY"); net_delay = e ? atof(e) / 1000.0 : 0;
        const char *j = getenv("RT_NET_JITTER"); jitter = j ? atof(j) / 1000.0 : 0;
        if (net_delay > 0 || jitter > 0) { pthread_t t; pthread_create(&t, NULL, delay_main, NULL); }
    }
    if ((net_delay > 0 || jitter > 0) && len <= MAXPKT + 4) {
        pthread_mutex_lock(&dq_mu);
        if ((dq_h + 1) % DQ != dq_t) {
            dq[dq_h].due = tnow() + net_delay + jitter * rand() / RAND_MAX; memcpy(dq[dq_h].src, src, 6); dq[dq_h].len = (uint16_t)len; memcpy(dq[dq_h].p, p, (size_t)len);
            dq_h = (dq_h + 1) % DQ; pthread_cond_signal(&dq_cv);
        }
        pthread_mutex_unlock(&dq_mu);
        return;
    }
    deliver_now(src, p, len);
}
/* ------------------------------------------------------------ smoother play
 * The game's netcode is host-relayed lockstep: each client sends its controls
 * (steer, gas, brake, handbrake) to the host every ~31 ms, the host bundles all
 * players' controls and sends the bundle back, and every machine drives every car
 * from the bundles. So a joining player's car only reacts a round trip later.
 *
 * For casual play we trade strict lockstep for responsiveness:
 * 1. A client writes its newest controls into its own block of each bundle it
 *    gets, so its car reacts at once in its own game.
 * 2. Its game and the host's then drive that car differently, so every player's
 *    game is the authority for its own car and the host's for the AI cars: about
 *    30 times a second each one sends those cars' physics state (position,
 *    velocity, orientation, spin) and the others overwrite theirs. The host moves
 *    a client's car ahead by the time it took to arrive (half the round trip to
 *    that player, from the page: rt_net_peer_rtt).
 * 3. A position error is taken out over a few updates rather than at once, so a
 *    car whose player's computer froze for a moment (its updates stop, then say it
 *    is somewhere else) slides back into place instead of jumping.
 * RT_NETSYNC=0 turns both off.
 *
 * Game packets ("\xEAdat"): fe, payload length, seq, ack, CRC-16 (BE), payload.
 * A client's controls: payload 06 00 + 4 bytes; a bundle: 06 + 8 blocks of 4 (player
 * k in block k). CRC: reflected, table at 0x566b54 (poly 0xA001), init 0xFBEA, over
 * the bytes from fe on with the CRC bytes zero. Cars: 8 pointers at 0x5efac8, car k
 * = player k, then the AI; physics state at +0x98 (88 bytes). Our state packets (socket
 * 0x7ea5): 'S' 'Y', sender's car, count, sender's clock (u32 ms), then count x (car, 88 bytes). */
#define CAR_TABLE 0x5efac8u
#define CAR_STATE 0x98u
#define CAR_BYTES 88
#define SYNC_PORT 0x7ea5
static int sync_on = -1;
static int my_slot = -1;                  /* client: my block in the bundles (learned) */
static int am_host, am_client;           /* seen: clients' controls coming in / bundles coming in */
static double last_race_pkt;             /* a bundle or controls packet: a race is on */
static uint8_t my_ctl[4]; static uint8_t sent_ctl[256][4]; static double sent_t[256];
static int slot_votes[8], votes_n;
static double rtt_s = 0.1;               /* host: round trip to the clients (min over recent acks) */
static double bundle_t[256];
static struct { int have; double t; float lat; uint8_t st[CAR_BYTES]; } remote[8];
static double human_seen[8];             /* host: a client's state for this car arrived (it owns it) */
static pthread_mutex_t sync_mu = PTHREAD_MUTEX_INITIALIZER;
/* each peer's one-way delay to us in seconds (half its round trip, from the page); natively the
 * simulated RT_NET_DELAY; -1 when not known */
static struct { uint8_t node[6]; float s; int32_t dmin[2]; double win_t; } peer_lat[16];
static int peer_lat_n;
static int peer_lat_slot(const uint8_t node[6]) {
    int i = 0;
    while (i < peer_lat_n && memcmp(peer_lat[i].node, node, 6)) i++;
    if (i == peer_lat_n) { if (peer_lat_n == 16) i = 0; else peer_lat_n++; memcpy(peer_lat[i].node, node, 6); peer_lat[i].s = -1.0f; peer_lat[i].dmin[0] = peer_lat[i].dmin[1] = INT32_MAX; peer_lat[i].win_t = 0; }
    return i;
}
static float lat_of(const uint8_t node[6]) {
    for (int i = 0; i < peer_lat_n; i++) if (!memcmp(peer_lat[i].node, node, 6)) return peer_lat[i].s;
    return net_delay > 0 ? (float)net_delay : -1.0f;
}
/* How much longer than usual a packet took: it carries the sender's clock in ms; the least
 * (ours - theirs) seen lately is the quickest trip (plus the clock difference, which cancels),
 * so anything above it is queueing on the way, and the car is that much further on. Two 8 s
 * windows, so a drifting clock or a route change is forgotten soon enough. */
static float extra_delay(const uint8_t node[6], uint32_t sent_ms, double now) {
    int i = peer_lat_slot(node);
    int32_t d = (int32_t)((uint32_t)(now * 1000.0) - sent_ms);
    if (now - peer_lat[i].win_t > 8.0) { peer_lat[i].win_t = now; peer_lat[i].dmin[1] = peer_lat[i].dmin[0]; peer_lat[i].dmin[0] = INT32_MAX; }
    if (d < peer_lat[i].dmin[0]) peer_lat[i].dmin[0] = d;
    int32_t m = peer_lat[i].dmin[1] < peer_lat[i].dmin[0] ? peer_lat[i].dmin[1] : peer_lat[i].dmin[0];
    int32_t x = d - m;
    return x > 0 && x < 1000 ? (float)x / 1000.0f : 0.0f;
}
static void set_peer_rtt(const uint8_t node[6], double rtt) {
    pthread_mutex_lock(&sync_mu);
    int i = peer_lat_slot(node);
    peer_lat[i].s = rtt > 0 && rtt < 2.0 ? (float)(rtt * 0.5) : -1.0f;
    pthread_mutex_unlock(&sync_mu);
}

static uint16_t game_crc(const uint8_t *p, int n) {
    uint16_t c = 0xFBEA;
    for (int i = 0; i < n; i++) c = (uint16_t)((c >> 8) ^ RD16(0x566b54u + 2u * (uint8_t)(c ^ p[i])));
    return c;
}
static int is_dat(const uint8_t *d, int n) { return n >= 10 && d[0] == 0xEA && d[1] == 'd' && d[2] == 'a' && d[3] == 't' && d[4] == 0xfe && d[5] + 10 == n; }
static int sync_enabled(void) {
    if (sync_on < 0) { const char *e = getenv("RT_NETSYNC"); sync_on = !e || atoi(e) != 0; }
    return sync_on && online;
}
static uint32_t car_ptr(int k) {
    uint32_t c = RD32(CAR_TABLE + 4u * (uint32_t)k);
    return c >= 0x400000u && c + 0x9ac < GUEST_SIZE ? c : 0;
}
/* a game packet going out (game thread) */
static void sync_out(const uint8_t *d, int n) {
    if (!sync_enabled() || !is_dat(d, n)) return;
    if (n == 16 && d[10] == 0x06) {          /* my controls (I'm a client) */
        pthread_mutex_lock(&sync_mu);
        memcpy(my_ctl, d + 12, 4); memcpy(sent_ctl[d[6]], d + 12, 4); sent_t[d[6]] = tnow();
        am_client = 1; last_race_pkt = tnow();
        pthread_mutex_unlock(&sync_mu);
    } else if (n == 43 && d[10] == 0x06) {   /* a bundle (I'm the host) */
        bundle_t[d[6]] = tnow();
    }
}
/* a game packet coming in (network thread): may rewrite a bundle in place */
static void sync_in(uint8_t *d, int n) {
    if (!sync_enabled() || !is_dat(d, n)) return;
    pthread_mutex_lock(&sync_mu);
    double now = tnow();
    if (n == 16 && d[10] == 0x06) {          /* a client's controls: its ack tells the round trip */
        am_host = 1; last_race_pkt = now;
        double t = bundle_t[d[7]];
        if (t > 0 && now - t < 1.0) { double r = now - t; rtt_s = r < rtt_s ? r : rtt_s + (r - rtt_s) * 0.02; }
    } else if (n == 43 && d[10] == 0x06) {   /* a bundle */
        am_client = 1; last_race_pkt = now;
        /* learn my block: the one holding what I sent with the acked seq */
        const uint8_t *sent = sent_ctl[d[7]];
        if (my_slot < 0 && sent_t[d[7]] > 0 && (sent[0] | sent[1] | sent[2] | sent[3])) {
            int hit = -1, hits = 0;             /* a client is never block 0 (the host's) */
            for (int k = 1; k < 8; k++) if (!memcmp(d + 11 + 4 * k, sent, 4)) { hit = k; hits++; }
            if (hits == 1) slot_votes[hit]++;
            if (++votes_n >= 8) {
                int best = 1; for (int k = 2; k < 8; k++) if (slot_votes[k] > slot_votes[best]) best = k;
                if (slot_votes[best] >= 6) { my_slot = best; rt_log("net: smoother play on, my car is %d", my_slot); }
                memset(slot_votes, 0, sizeof slot_votes); votes_n = 0;
            }
        }
        if (my_slot > 0) {                    /* my newest controls into my block */
            memcpy(d + 11 + 4 * my_slot, my_ctl, 4);
            d[8] = d[9] = 0;
            uint16_t c = game_crc(d + 4, n - 4); d[8] = (uint8_t)(c >> 8); d[9] = (uint8_t)c;
        }
    }
    pthread_mutex_unlock(&sync_mu);
}
/* another player's car states (network thread) */
static void sync_state_in(const uint8_t src[6], const uint8_t *d, int n) {
    if (!sync_enabled() || n < 4 || d[0] != 'S' || d[1] != 'Y') return;
    int from = d[2], cnt = d[3];
    if (n < 8 + cnt * (1 + CAR_BYTES)) return;
    uint32_t sent_ms; memcpy(&sent_ms, d + 4, 4);
    pthread_mutex_lock(&sync_mu);
    double now = tnow();
    float extra = extra_delay(src, sent_ms, now);
    for (int i = 0; i < cnt; i++) {
        const uint8_t *e = d + 8 + i * (1 + CAR_BYTES); int k = e[0];
        if (k > 7 || k == (am_host ? 0 : my_slot)) continue;        /* never overwrite my own car */
        remote[k].have = 1; remote[k].t = now; memcpy(remote[k].st, e + 1, CAR_BYTES);
        float lat = lat_of(src); remote[k].lat = lat < 0 ? lat : lat + extra;
        if (k == from && am_host) human_seen[k] = now;
    }
    pthread_mutex_unlock(&sync_mu);
}
/* which car this player drives: -1 offline, -2 online but not known (yet) */
int net_local_car(void) {
    if (!online) return -1;
    if (am_host) return 0;
    return my_slot > 0 ? my_slot : -2;
}
/* once a frame on the game thread: send my cars, apply the others' */
void net_frame(void) {
    if (!sync_enabled()) return;
    double now = tnow();
    if (now - last_race_pkt > 0.5) {
        if (now - last_race_pkt > 5.0 && (am_host || am_client)) {   /* race over: learn again next time */
            pthread_mutex_lock(&sync_mu);
            my_slot = -1; am_host = am_client = 0; memset(human_seen, 0, sizeof human_seen); memset(sent_t, 0, sizeof sent_t);
            pthread_mutex_unlock(&sync_mu);
            pace_log();
        }
        return;
    }
    if (!car_ptr(0)) return;
    int me = am_host ? 0 : my_slot;
    if (me < 0) return;
    {   /* RT_NET_STALL=every_ms:ms (testing): freeze this game now and then, like a slow computer */
        static double every = -1, len, last;
        if (every < 0) { const char *e = getenv("RT_NET_STALL"); every = e ? atof(e) / 1000.0 : 0; len = e && strchr(e, ':') ? atof(strchr(e, ':') + 1) / 1000.0 : 0; }
        if (every > 0 && now - last >= every) { if (last > 0) { rt_log("net: test stall %.0f ms", len * 1000); usleep((useconds_t)(len * 1e6)); now = tnow(); } last = now; }
    }
    static float ahead = -1;                  /* RT_SYNC_AHEAD (testing): how much of the delay to move a car ahead by */
    if (ahead < 0) { const char *e = getenv("RT_SYNC_AHEAD"); ahead = e ? (float)atof(e) : 1.0f; }
    static int old_rule = -1; if (old_rule < 0) old_rule = getenv("RT_SYNC_SNAP") != NULL;
    static double last_send;
    if (now - last_send >= 0.030) {
        last_send = now;
        uint8_t pkt[4 + 8 + 8 * (1 + CAR_BYTES)]; int cnt = 0, o = 12;
        for (int k = 0; k < 8; k++) {
            uint32_t c = car_ptr(k); if (!c) continue;
            int mine = k == me || (am_host && k != 0 && now - human_seen[k] > 2.0);
            if (!mine) continue;
            pkt[o] = (uint8_t)k; memcpy(pkt + o + 1, G + c + CAR_STATE, CAR_BYTES); o += 1 + CAR_BYTES; cnt++;
        }
        pkt[0] = (uint8_t)(SYNC_PORT >> 8); pkt[1] = (uint8_t)SYNC_PORT; pkt[2] = pkt[0]; pkt[3] = pkt[1];
        pkt[4] = 'S'; pkt[5] = 'Y'; pkt[6] = (uint8_t)me; pkt[7] = (uint8_t)cnt;
        uint32_t ms = (uint32_t)(now * 1000.0); memcpy(pkt + 8, &ms, 4);     /* our clock: the receiver sees how long this one took (extra_delay) */
        if (cnt) transport_send(BCAST, pkt, o);
    }
    pthread_mutex_lock(&sync_mu);
    for (int k = 0; k < 8; k++) {
        if (!remote[k].have || k == me) continue;
        remote[k].have = 0;
        if (now - remote[k].t > 0.25) continue;
        uint32_t c = car_ptr(k); if (!c) continue;
        float s[CAR_BYTES / 4]; memcpy(s, remote[k].st, CAR_BYTES);
        /* it is as old as its trip here: move it ahead by that (the host always did, with the
         * round trip to its quickest client; a client's own car runs on its newest controls) */
        float lat = remote[k].lat;
        if (lat < 0 && am_host) lat = (float)(rtt_s * 0.5);
        float dt = (lat > 0 ? lat * ahead : 0) + (float)(now - remote[k].t);
        if (dt > 0.5f) dt = 0.5f;
        for (int j = 0; j < 3; j++) s[j] += s[3 + j] * dt;
        /* the position error is taken out over a few updates (a visible jump otherwise): a
         * small one by half each time; a bigger one (its player's game froze for a moment and
         * it is somewhere else now) at most 1.5 m an update, so it slides into place over a
         * few tenths of a second; a huge one (a reset to the track far away) at once. The rest
         * of the state (speed, heading, spin) is set as is. */
        float cur[3]; memcpy(cur, G + c + CAR_STATE, 12);
        float ex = s[0] - cur[0], ey = s[1] - cur[1], ez = s[2] - cur[2], e = sqrtf(ex * ex + ey * ey + ez * ez);
        float f = e < 4.0f ? 0.5f : e < 40.0f ? fminf(0.5f, 1.5f / e) : 1.0f;
        if (old_rule) f = e < 4.0f ? 0.5f : 1.0f;                    /* RT_SYNC_SNAP (testing): the old rule */
        s[0] = cur[0] + ex * f; s[1] = cur[1] + ey * f; s[2] = cur[2] + ez * f;
        memcpy(G + c + CAR_STATE, s, CAR_BYTES);
    }
    pthread_mutex_unlock(&sync_mu);
}

/* ------------------------------------------------------------- steady beat
 * The game runs in lockstep: a client advances its whole simulation, and so its
 * picture, only when the next bundle from the host arrives, about every 31 ms,
 * in order (the host's packets are one numbered stream, bundles and the rare
 * reliable messages alike, acknowledged by the client's own packets and resent
 * when an ack stays behind). So every late or lost bundle (network jitter, a
 * relayed hop, a hiccup on the host) freezes the client's game for as long as
 * it takes. Real races show the longest gap between packets in a 2 s window at
 * 50 ms typically and over 150 ms in a tenth of the windows: the stutter
 * players report.
 *
 * The pacer takes the host's stream in and hands it to the game at a steady beat
 * a little behind the arrivals (a jitter buffer that grows when bundles come
 * late and shrinks again). When a bundle is late it hands the game a stand-in
 * made from the last one (the others' controls as last known), so the game keeps
 * its beat; the real one, once it comes, is dropped as old. The game's cars are
 * put right by the state updates (above) anyway, and this player's own car runs
 * on its newest controls (sync_in), so the cost is only that the others' inputs
 * reach this game a few tens of milliseconds later. Only when the host stays
 * silent longer than pace_standin does the game wait, as it always did.
 *
 * It runs on the clients only (the host's stream is the one with bundles), on that
 * stream only: another player's own numbered messages pass untouched.
 *
 * Numbering: the game sees our own sequence (pq_v), one per packet handed on,
 * stand-ins included, so a stand-in never collides with a real message that
 * takes the host's next number; the host's reliable messages pass at once with
 * the next of our numbers. The game's acks name our numbers, so on the way out
 * they are translated back (pq_vmap) to the newest of the host's numbers the game
 * really had, which is what the host's resend logic wants to know.
 * RT_PACE=buffer_ms[:standin_ms] (default 40:250, 0 = off). */
#define PQ 128                            /* the numbers run 0..127 */
#define SEQ(x) ((uint8_t)((x) & 0x7f))
static struct { int have; double arrived; uint8_t src[6]; uint8_t p[64]; int len; } pq[PQ];
static uint8_t pq_seen[16];               /* the host's numbers taken in lately */
static uint8_t pq_unacked[16];            /* ...and not yet named in an ack to the host (it resends a number
                                           * until it is named, so every one we got is named once) */
static uint8_t pq_ack_cur;                /* where to look for the next one to name */
static pthread_mutex_t pq_mu = PTHREAD_MUTEX_INITIALIZER; static pthread_cond_t pq_cv = PTHREAD_COND_INITIALIZER;
static int pace_on = -1; static double pace_buf = 0.040, pace_standin = 0.250;
#define PACE_BUF_MAX 0.160
static volatile int pq_on;                /* a stream is on */
static uint8_t pq_src[6];                 /* whose: the host's node (the one that sends bundles) */
static uint8_t pq_rrel;                   /* the host's next bundle to hand on */
static uint8_t pq_v;                      /* our number the game expects next */
static uint8_t pq_vmap[PQ];               /* our number -> the newest of the host's the game had by then */
static uint8_t pq_rlast;                  /* the newest of the host's numbers handed on */
static uint8_t pq_last_ack;               /* the newest ack of ours the host sent (a stand-in carries it: a stale one would hold the game's own sending back) */
static double pq_t, pq_tick = 1.0 / 32;   /* the next beat; the host's beat, measured */
static double pq_rate_t; static uint8_t pq_rate_seq; static int pq_rate_on;   /* the measurement: time and number at its start */
static double pq_buf, pq_arrival, pq_head, pq_late_t;   /* the buffer wanted now; last arrival; EWMA of what a real bundle waited; last late bundle */
static double pq_last_real; static uint8_t pq_last[64], pq_last_src[6]; static int pq_last_len;
static int pq_stalled; static double pq_stall_t;
static struct { unsigned real, standin, late, dup, msgs, stalls; double stall_s; } pstat;
static void queue_pkt(const uint8_t src[6], const uint8_t *p, int len, const char *dir);
static int seen(uint8_t r) { return (pq_seen[r >> 3] >> (r & 7)) & 1; }
static void set_seen(uint8_t r) { pq_seen[r >> 3] |= (uint8_t)(1 << (r & 7)); }
static void clr_seen(uint8_t r) { pq_seen[r >> 3] &= (uint8_t)~(1 << (r & 7)); }
static int unacked(uint8_t r) { return (pq_unacked[r >> 3] >> (r & 7)) & 1; }
static void set_unacked(uint8_t r) { pq_unacked[r >> 3] |= (uint8_t)(1 << (r & 7)); }
static void clr_unacked(uint8_t r) { pq_unacked[r >> 3] &= (uint8_t)~(1 << (r & 7)); }
static int is_bundle(const uint8_t *p, int len) { return len == 47 && p[14] == 0x06; }
static void pace_reset(void) { memset(pq, 0, sizeof pq); memset(pq_seen, 0, sizeof pq_seen); memset(pq_unacked, 0, sizeof pq_unacked); pq_on = 0; pq_last_len = 0; pq_head = 0; pq_stalled = 0; pq_rate_on = 0; }
static void pace_start(uint8_t r, double now) {
    pace_reset(); pq_on = 1; pq_rrel = r; pq_v = r; pq_rlast = SEQ(r - 1); pq_ack_cur = r; pq_t = now + pace_buf; pq_buf = pace_buf; pq_late_t = 0;
    for (int i = 0; i < PQ; i++) pq_vmap[i] = (uint8_t)i;
}
/* our number onto a packet for the game, and what its ack will mean */
static void renumber(uint8_t *out, int len) {
    out[10] = pq_v; pq_vmap[pq_v] = pq_rlast; pq_v = SEQ(pq_v + 1);
    out[12] = out[13] = 0;
    uint16_t c = game_crc(out + 8, len - 8); out[12] = (uint8_t)(c >> 8); out[13] = (uint8_t)c;
}
static void wait_until(double t) {         /* on pq_cv, until the monotonic time t or a signal */
    struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
    double w = t - tnow(); if (w <= 0) return;
    ts.tv_sec += (time_t)w; ts.tv_nsec += (long)((w - (double)(time_t)w) * 1e9);
    if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
    pthread_cond_timedwait(&pq_cv, &pq_mu, &ts);
}
static void *pace_main(void *unused) {
    (void)unused;
    pthread_mutex_lock(&pq_mu);
    for (;;) {
        if (!pq_on) { pthread_cond_wait(&pq_cv, &pq_mu); continue; }
        double now = tnow();
        if (pq_t - now > 0.0003) { wait_until(pq_t); continue; }
        uint8_t out[64], src[6]; int len, real;
        if (pq[pq_rrel].have) {
            real = 1; len = pq[pq_rrel].len; memcpy(out, pq[pq_rrel].p, (size_t)len); memcpy(src, pq[pq_rrel].src, 6); pq[pq_rrel].have = 0;
            pq_head += (now - pq[pq_rrel].arrived - pq_head) * 0.1;
            memcpy(pq_last, out, (size_t)len); pq_last_len = len; memcpy(pq_last_src, src, 6); pq_last_real = now;
            pq_rlast = pq_rrel; pstat.real++;
        } else if (pq_last_len && now - pq_last_real < pace_standin) {
            real = 0; len = pq_last_len; memcpy(out, pq_last, (size_t)len); memcpy(src, pq_last_src, 6);
            out[11] = pq_last_ack; pstat.standin++;
        } else {                               /* nothing to give: the game waits, as it always did */
            if (!pq_stalled) { pq_stalled = 1; pq_stall_t = now; pstat.stalls++; }
            pthread_cond_wait(&pq_cv, &pq_mu);
            if (!pq_on) continue;
            /* go on from the first bundle that came after the stall began (the one we waited for may never come) */
            for (int k = 0; k < 32; k++) if (pq[SEQ(pq_rrel + k)].have && pq[SEQ(pq_rrel + k)].arrived >= pq_stall_t) { pq_rrel = SEQ(pq_rrel + k); pq_t = tnow(); break; }
            continue;
        }
        if (pq_stalled) { pq_stalled = 0; pstat.stall_s += now - pq_stall_t; }
        renumber(out, len);
        pq_rrel = SEQ(pq_rrel + 1); clr_seen(SEQ(pq_rrel + 64));
        /* the next beat: the host's, nudged to keep about pq_buf in hand; the buffer eases off
         * again when no bundle has come late for a while */
        if (now - pq_late_t > 2.0 && pq_buf > pace_buf) pq_buf -= 0.0005;
        double err = real ? pq_buf - pq_head : 0;                           /* in hand too little: beat slower, too much: faster */
        double skew = 1.0 + (err > 0.08 ? 0.08 : err < -0.08 ? -0.08 : err);
        pq_t += pq_tick * skew;
        if (pq_t < now - 0.05) pq_t = now;     /* we overslept: no burst to make up for it */
        pthread_mutex_unlock(&pq_mu);
        sync_in(out + 4, len - 4);
        queue_pkt(src, out, len, real ? "in " : "in*");
        pthread_mutex_lock(&pq_mu);
    }
    return NULL;
}
/* a packet in: 1 when the pacer took it (one of the host's numbered packets) */
static int pace_take(const uint8_t src[6], const uint8_t *p, int len) {
    if (pace_on < 0) {
        const char *e = getenv("RT_PACE"); pace_on = 1;
        if (e) { double b = atof(e); const char *c = strchr(e, ':'); if (b <= 0) pace_on = 0; else { pace_buf = b / 1000; if (c) pace_standin = atof(c + 1) / 1000; } }
        if (pace_on) rt_log("net: steady beat on, %.0f ms in hand, stand-ins for up to %.0f ms", pace_buf * 1000, pace_standin * 1000);
    }
    if (!pace_on || !sync_enabled() || len > MAXPKT + 4 || !is_dat(p + 4, len - 4) || p[9] == 0 || !memcmp(src, self_node, 6)) return 0;
    /* only the host's stream, from its first bundle on (so never on the host itself, and never
     * another player's own numbered messages) */
    if (pq_on && tnow() - pq_arrival <= 2.0) { if (memcmp(src, pq_src, 6)) return 0; }
    else if (!is_bundle(p, len)) return 0;
    uint8_t r = SEQ(p[10]); double now = tnow();
    pthread_mutex_lock(&pq_mu);
    static int started; if (!started) { started = 1; pthread_t t; pthread_create(&t, NULL, pace_main, NULL); }
    if (!pq_on || now - pq_arrival > 2.0) { pace_start(r, now); memcpy(pq_src, src, 6); }   /* a new stream */
    trace_pkt("in>", src, (uint16_t)(p[0] << 8 | p[1]), (uint16_t)(p[2] << 8 | p[3]), p + 4, len - 4);
    pq_arrival = now;
    if (seen(r)) { pstat.dup++; pthread_mutex_unlock(&pq_mu); return 1; }  /* resent: we had it (or a stand-in did) */
    set_seen(r); set_unacked(r);
    if (((p[11] - pq_last_ack) & 0x7f) < 64 || !pstat.real) pq_last_ack = SEQ(p[11]);
    if (!is_bundle(p, len)) {                                                /* a reliable message: on it goes, with our next number */
        uint8_t out[MAXPKT + 4]; memcpy(out, p, (size_t)len);
        if (((r - pq_rlast) & 0x7f) < 64) pq_rlast = r;
        renumber(out, len); pstat.msgs++;
        pthread_mutex_unlock(&pq_mu);
        sync_in(out + 4, len - 4);
        queue_pkt(src, out, len, "in ");
        return 1;
    }
    int d = (r - pq_rrel) & 0x7f; if (d >= 64) d -= 128;
    if (d < 0) {                                                             /* late: a stand-in went in its place; keep more in hand */
        pstat.late++; pq_late_t = now; if (pq_buf < PACE_BUF_MAX) pq_buf += 0.010;
        pthread_mutex_unlock(&pq_mu); return 1;
    }
    if (d > 32) { pace_start(r, now); memcpy(pq_src, src, 6); }           /* the stream jumped: start again */
    else {                                                                   /* the host's beat: 32 numbers' worth of arrivals at a time (jitter averages out) */
        if (!pq_rate_on) { pq_rate_on = 1; pq_rate_t = now; pq_rate_seq = r; }
        int n = (r - pq_rate_seq) & 0x7f;
        if (n >= 32 && n < 64) {
            double tick = (now - pq_rate_t) / n;
            if (tick > 0.025 && tick < 0.040) pq_tick += (tick - pq_tick) * 0.5;
            pq_rate_t = now; pq_rate_seq = r;
        }
    }
    pq[r].have = 1; pq[r].arrived = now; pq[r].len = len; memcpy(pq[r].p, p, (size_t)len); memcpy(pq[r].src, src, 6);
    pthread_cond_signal(&pq_cv);
    pthread_mutex_unlock(&pq_mu);
    return 1;
}
/* a packet out to the host: the game's ack names our number; the host wants its own */
static void pace_out(const uint8_t *dst, uint8_t *d, int n) {
    if (!pq_on || memcmp(dst, pq_src, 6) || !is_dat(d, n)) return;
    uint8_t ack = pq_vmap[SEQ(d[7])];                /* what the game means, in the host's numbers */
    pthread_mutex_lock(&pq_mu);
    for (int k = 0; k < PQ; k++) {                   /* but first every number we got and never named */
        uint8_t r = SEQ(pq_ack_cur + k);
        if (unacked(r)) { ack = r; clr_unacked(r); pq_ack_cur = SEQ(r + 1); break; }
    }
    pthread_mutex_unlock(&pq_mu);
    d[7] = ack; d[8] = d[9] = 0;
    uint16_t c = game_crc(d + 4, n - 4); d[8] = (uint8_t)(c >> 8); d[9] = (uint8_t)c;
}
static void pace_log(void) {               /* at the end of a race */
    if (!pstat.real && !pstat.standin) return;
    rt_log("net: steady beat: %u bundles, %u stand-ins, %u late, %u resent, %u messages, %u stalls (%.1f s), buffer now %.0f ms",
           pstat.real, pstat.standin, pstat.late, pstat.dup, pstat.msgs, pstat.stalls, pstat.stall_s, pq_buf * 1000);
    pthread_mutex_lock(&pq_mu); memset(&pstat, 0, sizeof pstat); pace_reset(); pthread_mutex_unlock(&pq_mu);
}

static void queue_pkt(const uint8_t src[6], const uint8_t *p, int len, const char *dir) {
    uint16_t dport = (uint16_t)(p[0] << 8 | p[1]), sport = (uint16_t)(p[2] << 8 | p[3]);
    trace_pkt(dir, src, dport, sport, p + 4, len - 4);
    pthread_mutex_lock(&mu);
    stats.rx++; stats.rxb += (uint64_t)len;
    for (int i = 0; i < NSOCK; i++) {
        VSock *s = &socks[i];
        if (!s->used || !s->bound || s->port != dport) continue;
        if (((s->qh + 1) % QLEN) == s->qt) { stats.drop++; break; }
        Pkt *k = &s->q[s->qh];
        k->len = (uint16_t)(len - 4 > MAXPKT ? MAXPKT : len - 4); k->sport = sport; memcpy(k->src, src, 6);
        memcpy(k->data, p + 4, k->len);
        s->qh = (s->qh + 1) % QLEN;
        pthread_cond_broadcast(&cv);
        break;
    }
    pthread_mutex_unlock(&mu);
}
static void deliver_now(const uint8_t src[6], const uint8_t *p, int len) {
    uint16_t dport = (uint16_t)(p[0] << 8 | p[1]);
    if (dport == SYNC_PORT) { sync_state_in(src, p + 4, len - 4); return; }
    uint8_t buf[MAXPKT + 4];
    if (len > (int)sizeof buf) { queue_pkt(src, p, len, "in "); return; }
    memcpy(buf, p, (size_t)len);
    if (pace_take(src, buf, len)) return;             /* a bundle: the pacer hands it on at its beat */
    sync_in(buf + 4, len - 4);
    queue_pkt(src, buf, len, "in ");
}

#ifdef __EMSCRIPTEN__
/* the page owns the connection: packets out go to Module.netSend on the main
 * thread; packets in arrive via rt_net_packet */
/* Network worker (web/net-worker.js, when the page turns it on): packets for peers without a
 * direct WebRTC link go through two rings in this memory to a Web Worker that owns its own
 * relay socket, so they never wait for the busy main thread. Each record: u32 len, then
 * [node 6][packet]. Out: game threads -> worker (the worker sleeps on `head`). In: worker ->
 * net_in_main() below (sleeps on `head`). Packets still go to the main thread as well; it sends
 * only to peers with an open direct link, the worker only to the others. */
#define NRING (256u << 10)
typedef struct { volatile uint32_t head, tail; uint32_t cap, dropped; uint8_t data[NRING]; } NetRing;
static NetRing ring_out = { 0, 0, NRING, 0 }, ring_in = { 0, 0, NRING, 0 };
static volatile int use_worker;
static pthread_mutex_t out_mu = PTHREAD_MUTEX_INITIALIZER;
static void ring_put(NetRing *r, const uint8_t dst[6], const uint8_t *pkt, int len) {
    uint32_t n = (uint32_t)len + 6, h = r->head, t = __atomic_load_n(&r->tail, __ATOMIC_ACQUIRE);
    if (NRING - (h - t) < n + 4) { r->dropped++; return; }
    uint8_t hdr[10]; memcpy(hdr, &n, 4); memcpy(hdr + 4, dst, 6);
    for (uint32_t i = 0; i < 10; i++) r->data[(h + i) % NRING] = hdr[i];
    for (uint32_t i = 0; i < (uint32_t)len; i++) r->data[(h + 10 + i) % NRING] = pkt[i];
    __atomic_store_n(&r->head, h + 4 + n, __ATOMIC_RELEASE);
    __builtin_wasm_memory_atomic_notify((int *)&r->head, 1);
}
static void *net_in_main(void *unused) {
    (void)unused;
    static uint8_t buf[2048];
    for (;;) {
        uint32_t t = ring_in.tail, h = __atomic_load_n(&ring_in.head, __ATOMIC_ACQUIRE);
        if (t == h) { __builtin_wasm_memory_atomic_wait32((int *)&ring_in.head, (int)h, -1); continue; }
        uint32_t n = 0;
        for (uint32_t i = 0; i < 4; i++) n |= (uint32_t)ring_in.data[(t + i) % NRING] << (8 * i);
        if (n <= sizeof buf) {
            for (uint32_t i = 0; i < n; i++) buf[i] = ring_in.data[(t + 4 + i) % NRING];
            if (n > 6) net_deliver(buf, buf + 6, (int)n - 6);
        }
        __atomic_store_n(&ring_in.tail, t + 4 + n, __ATOMIC_RELEASE);
    }
    return NULL;
}
/* the page: [out ring, in ring] addresses; on = 0 turns the worker path off again (fallback) */
EMSCRIPTEN_KEEPALIVE uint32_t *rt_net_worker(int on) {
    static uint32_t addr[2]; static int started;
    addr[0] = (uint32_t)(uintptr_t)&ring_out; addr[1] = (uint32_t)(uintptr_t)&ring_in;
    if (on && !started) { started = 1; pthread_t th; pthread_create(&th, NULL, net_in_main, NULL); }
    use_worker = on;
    rt_log("net: network worker %s", on ? "on" : "off");
    return addr;
}
static void transport_send(const uint8_t dst[6], const uint8_t *pkt, int len) {
    if (use_worker) { pthread_mutex_lock(&out_mu); ring_put(&ring_out, dst, pkt, len); pthread_mutex_unlock(&out_mu); }
    uint8_t *b = malloc((size_t)len + 6);
    memcpy(b, dst, 6); memcpy(b + 6, pkt, (size_t)len);
    MAIN_THREAD_ASYNC_EM_ASM({ if (Module.netSend) Module.netSend($0, $1); else _free($0); }, b, len + 6);
}
EMSCRIPTEN_KEEPALIVE void rt_net_packet(const uint8_t *buf, int len) {   /* [src 6][packet] */
    if (len > 6) net_deliver(buf, buf + 6, len - 6);
}
/* the page: its round trip to a peer (direct link, or through the relay), every 2 s */
EMSCRIPTEN_KEEPALIVE void rt_net_peer_rtt(const char *n, int ms) {
    if (!n || strlen(n) != 12) return;
    uint8_t node[6];
    for (int i = 0; i < 6; i++) { unsigned v; sscanf(n + 2 * i, "%2x", &v); node[i] = (uint8_t)v; }
    set_peer_rtt(node, ms / 1000.0);
}
/* the page calls this after joining a room (before the game opens a socket) */
EMSCRIPTEN_KEEPALIVE void rt_net_set_node(const char *n) {
    if (!n || strlen(n) != 12) return;
    for (int i = 0; i < 6; i++) { unsigned v; sscanf(n + 2 * i, "%2x", &v); self_node[i] = (uint8_t)v; }
    online = 1;
    rt_log("net: joined room as node %s", n);
}
static void transport_init(void) {}
#else
static int relay_fd = -1;
static pthread_mutex_t tx_mu = PTHREAD_MUTEX_INITIALIZER;
static void raw_send(int kind, const void *body, size_t n) {
    uint8_t h[5]; uint32_t len = (uint32_t)n + 1;
    memcpy(h, &len, 4); h[4] = (uint8_t)kind;
    pthread_mutex_lock(&tx_mu);
    if (relay_fd >= 0) { (void)!write(relay_fd, h, 5); (void)!write(relay_fd, body, n); }
    pthread_mutex_unlock(&tx_mu);
}
static void transport_send(const uint8_t dst[6], const uint8_t *pkt, int len) {
    uint8_t b[MAXPKT + 16];
    memcpy(b, dst, 6); memcpy(b + 6, pkt, (size_t)len);
    raw_send(1, b, (size_t)len + 6);
}
static int read_full(int fd, void *p, size_t n) {
    for (size_t o = 0; o < n;) { ssize_t r = read(fd, (char *)p + o, n - o); if (r <= 0) return -1; o += (size_t)r; }
    return 0;
}
static volatile int welcomed;
static void *relay_rx(void *unused) {
    (void)unused;
    static uint8_t body[1 << 16];
    for (;;) {
        uint32_t n; if (read_full(relay_fd, &n, 4) || n < 1 || n >= sizeof body) break;   /* room for the 0 below */
        if (read_full(relay_fd, body, n)) break;
        if (body[0] == 1) { if (n > 7) net_deliver(body + 1, body + 7, (int)n - 7); continue; }
        body[n] = 0;
        const char *j = (const char *)body + 1;
        if (strstr(j, "\"t\":\"welcome\"")) {
            const char *id = strstr(j, "\"id\":\"");
            if (id) for (int i = 0; i < 6; i++) { unsigned v; sscanf(id + 6 + 2 * i, "%2x", &v); self_node[i] = (uint8_t)v; }
            online = 1; welcomed = 1;
        }
        rt_log("net: %s", j);
    }
    rt_log("net: relay connection lost");
    online = 0;
    return NULL;
}
static int connect_timeout(int fd, const struct sockaddr *sa, socklen_t len, int ms) {
    int fl = fcntl(fd, F_GETFL); fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    int r = connect(fd, sa, len);
    if (r && errno == EINPROGRESS) {
        struct pollfd p = { fd, POLLOUT, 0 };
        if (poll(&p, 1, ms) == 1) { int e = 0; socklen_t l = sizeof e; getsockopt(fd, SOL_SOCKET, SO_ERROR, &e, &l); r = e ? -1 : 0; }
        else r = -1;
    }
    fcntl(fd, F_SETFL, fl);
    return r;
}
static void transport_init(void) {
    /* RT_NET=host:port or unix:/path/to/socket */
    const char *addr = getenv("RT_NET"); if (!addr) return;
    int fd = -1;
    if (!strncmp(addr, "unix:", 5)) {
        struct sockaddr_un un = { .sun_family = AF_UNIX };
        snprintf(un.sun_path, sizeof un.sun_path, "%s", addr + 5);
        fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0 || connect_timeout(fd, (struct sockaddr *)&un, sizeof un, 3000)) { rt_log("net: cannot connect to relay %s", addr); if (fd >= 0) close(fd); return; }
    } else {
        char host[256]; snprintf(host, sizeof host, "%s", addr);
        char *colon = strrchr(host, ':'); if (!colon) return;
        *colon = 0;
        struct addrinfo hints = { .ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM }, *ai;
        if (getaddrinfo(host, colon + 1, &hints, &ai)) { rt_log("net: cannot resolve %s", addr); return; }
        fd = socket(ai->ai_family, SOCK_STREAM, 0);
        if (fd < 0 || connect_timeout(fd, ai->ai_addr, ai->ai_addrlen, 3000)) { rt_log("net: cannot connect to relay %s", addr); freeaddrinfo(ai); if (fd >= 0) close(fd); return; }
        freeaddrinfo(ai);
    }
    int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);   /* fails harmlessly on Unix sockets */
    relay_fd = fd;
    char hello[256];
    snprintf(hello, sizeof hello, "{\"t\":\"hello\",\"room\":\"%s\",\"name\":\"%s\"}",
             getenv("RT_ROOM") ? getenv("RT_ROOM") : "test", getenv("RT_NAME") ? getenv("RT_NAME") : "native");
    raw_send(0, hello, strlen(hello));
    pthread_t t; pthread_create(&t, NULL, relay_rx, NULL);
    for (int i = 0; i < 200 && !welcomed; i++) usleep(10000);
}
#endif

static void *stats_main(void *unused);
static int net_inited;
static void net_init(void) {
    if (net_inited) return;
    net_inited = 1;
    transport_init();
    if (getenv("RT_NET_STATS")) { pthread_t t; pthread_create(&t, NULL, stats_main, NULL); }
    rt_log("net: %s, node %02x:%02x:%02x:%02x:%02x:%02x", online ? "online" : "offline",
           self_node[0], self_node[1], self_node[2], self_node[3], self_node[4], self_node[5]);
}

/* ------------------------------------------------------------------ WSOCK32 */
static VSock *vs(uint32_t s) { return s >= SOCK_BASE && s < SOCK_BASE + NSOCK && socks[s - SOCK_BASE].used ? &socks[s - SOCK_BASE] : NULL; }
static uint32_t fail(uint32_t e) { last_err = e; return 0xFFFFFFFFu; }

static void write_ipx_addr(uint32_t p, const uint8_t node[6], uint16_t port) {
    WR16(p, AF_IPX_); memset(G + p + 2, 0, 4); memcpy(G + p + 6, node, 6);
    G[p + 12] = (uint8_t)(port >> 8); G[p + 13] = (uint8_t)port;
}

static uint32_t ws_WSAStartup(CPU *c, const uint32_t *a) {
    (void)c;
    uint32_t p = A(1);
    if (p) { memset(G + p, 0, 400); WR16(p, 0x0101); WR16(p + 2, 0x0101); strcpy(HSTR(p + 4), "nfs3-webgl virtual LAN"); }
    net_init();
    return 0;
}
static uint32_t ws_WSACleanup(CPU *c, const uint32_t *a) { (void)c; (void)a; return 0; }
static uint32_t ws_WSAGetLastError(CPU *c, const uint32_t *a) { (void)c; (void)a; return last_err; }

static uint32_t ws_socket(CPU *c, const uint32_t *a) {
    (void)c;
    net_init();
    if (A(0) != AF_IPX_ || A(1) != 2) { rt_log("socket(af=%u, type=%u, proto=%u): only IPX datagrams are supported", A(0), A(1), A(2)); return fail(WSAEAFNOSUPPORT); }
    if (!online) { rt_log("socket(IPX): not in an online room"); return fail(WSAENETDOWN); }
    pthread_mutex_lock(&mu);
    for (int i = 0; i < NSOCK; i++) if (!socks[i].used) {
        Pkt *q = socks[i].q; uint32_t g = socks[i].gen;
        socks[i] = (VSock){ .used = 1, .q = q, .gen = g + 1 };
        if (!socks[i].q) socks[i].q = malloc(sizeof(Pkt) * QLEN);
        pthread_mutex_unlock(&mu);
        rt_log("socket(IPX) -> %#x", SOCK_BASE + i);
        return SOCK_BASE + (uint32_t)i;
    }
    pthread_mutex_unlock(&mu);
    return fail(WSAEINVAL);
}
static uint32_t ws_closesocket(CPU *c, const uint32_t *a) {
    (void)c;
    VSock *s = vs(A(0)); if (!s) return fail(WSAENOTSOCK);
    pthread_mutex_lock(&mu); Pkt *q = s->q; uint32_t g = s->gen; *s = (VSock){0}; s->q = q; s->gen = g + 1;
    pthread_cond_broadcast(&cv); pthread_mutex_unlock(&mu);
    rt_log("closesocket(%#x)", A(0));
    return 0;
}
static uint32_t ws_bind(CPU *c, const uint32_t *a) {
    (void)c;
    VSock *s = vs(A(0)); if (!s) return fail(WSAENOTSOCK);
    uint32_t p = A(1);
    uint16_t port = (uint16_t)(G[p + 12] << 8 | G[p + 13]);
    pthread_mutex_lock(&mu);
    if (!port) { static uint16_t next = 0x4000; port = next++; }
    for (int i = 0; i < NSOCK; i++) if (socks[i].used && socks[i].bound && socks[i].port == port) { pthread_mutex_unlock(&mu); return fail(WSAEADDRINUSE); }
    s->port = port; s->bound = 1;
    pthread_mutex_unlock(&mu);
    rt_log("bind(%#x, IPX socket %#06x)", A(0), port);
    return 0;
}
static uint32_t ws_getsockname(CPU *c, const uint32_t *a) {
    (void)c;
    VSock *s = vs(A(0)); if (!s) return fail(WSAENOTSOCK);
    write_ipx_addr(A(1), self_node, s->port);
    if (A(2)) WR32(A(2), 14);
    return 0;
}
static uint32_t ws_setsockopt(CPU *c, const uint32_t *a) { (void)c; if (!vs(A(0))) return fail(WSAENOTSOCK); return 0; }
static uint32_t ws_ioctlsocket(CPU *c, const uint32_t *a) {
    (void)c;
    VSock *s = vs(A(0)); if (!s) return fail(WSAENOTSOCK);
    if (A(1) == 0x8004667eu) { s->nonblock = RD32(A(2)) != 0; return 0; }           /* FIONBIO */
    if (A(1) == 0x4004667fu) {                                                    /* FIONREAD */
        pthread_mutex_lock(&mu); WR32(A(2), s->qh != s->qt ? s->q[s->qt].len : 0); pthread_mutex_unlock(&mu);
        return 0;
    }
    return fail(WSAEINVAL);
}
static uint32_t ws_sendto(CPU *c, const uint32_t *a) {
    (void)c;
    VSock *s = vs(A(0)); if (!s) return fail(WSAENOTSOCK);
    uint32_t len = A(2), to = A(4);
    if (len > MAXPKT) return fail(WSAEMSGSIZE);
    if (!s->bound) { uint32_t tmp[3] = { A(0), 0, 0 }; (void)tmp; static uint16_t next = 0x5000; s->port = next++; s->bound = 1; }
    const uint8_t *node = G + to + 6;
    uint16_t dport = (uint16_t)(G[to + 12] << 8 | G[to + 13]);
    uint8_t pkt[MAXPKT + 4];
    pkt[0] = (uint8_t)(dport >> 8); pkt[1] = (uint8_t)dport; pkt[2] = (uint8_t)(s->port >> 8); pkt[3] = (uint8_t)s->port;
    memcpy(pkt + 4, G + A(1), len);
    stats.tx++; stats.txb += len;
    trace_pkt("out", node, dport, s->port, G + A(1), (int)len);
    sync_out(G + A(1), (int)len);
    pace_out(node, pkt + 4, (int)len);
    if (!memcmp(node, self_node, 6)) net_deliver(self_node, pkt, (int)len + 4);   /* to ourselves */
    else transport_send(node, pkt, (int)len + 4);
    if (rt_verbose > 1) rt_log("sendto(%#x, %u bytes -> %02x..%02x:%04x)", A(0), len, node[0], node[5], dport);
    return len;
}
static uint32_t ws_recvfrom(CPU *c, const uint32_t *a) {
    (void)c;
    VSock *s = vs(A(0)); if (!s) return fail(WSAENOTSOCK);
    pthread_mutex_lock(&mu);
    uint32_t gen = s->gen;
    while (s->qh == s->qt) {
        if (s->nonblock) { pthread_mutex_unlock(&mu); return fail(WSAEWOULDBLOCK); }
        pthread_cond_wait(&cv, &mu);
        if (s->gen != gen || !s->used) { pthread_mutex_unlock(&mu); return fail(10004 /* WSAEINTR */); }
    }
    Pkt *k = &s->q[s->qt];
    uint32_t n = k->len < A(2) ? k->len : A(2);
    memcpy(G + A(1), k->data, n);
    if (A(4)) write_ipx_addr(A(4), k->src, k->sport);
    if (A(5)) WR32(A(5), 14);
    int trunc = k->len > A(2);
    s->qt = (s->qt + 1) % QLEN;
    pthread_mutex_unlock(&mu);
    if (trunc) return fail(WSAEMSGSIZE);
    return n;
}

/* fd_set: u32 count, u32 fds[64] */
static int fdset_has(uint32_t set, uint32_t fd) {
    if (!set) return 0;
    uint32_t n = RD32(set);
    for (uint32_t i = 0; i < n && i < 64; i++) if (RD32(set + 4 + i * 4) == fd) return 1;
    return 0;
}
static uint32_t ws_select(CPU *c, const uint32_t *a) {
    (void)c;
    uint32_t rd = A(1), wr = A(2), ex = A(3), tv = A(4);
    struct timespec dl; clock_gettime(CLOCK_REALTIME, &dl);
    long ms = tv ? (long)RD32(tv) * 1000 + (long)RD32(tv + 4) / 1000 : -1;
    if (ms > 0) { dl.tv_sec += ms / 1000; dl.tv_nsec += (ms % 1000) * 1000000L; if (dl.tv_nsec >= 1000000000L) { dl.tv_sec++; dl.tv_nsec -= 1000000000L; } }
    uint32_t rin[65] = {0};
    if (rd) { rin[0] = RD32(rd); if (rin[0] > 64) rin[0] = 64; for (uint32_t i = 0; i < rin[0]; i++) rin[1 + i] = RD32(rd + 4 + i * 4); }
    uint32_t total;
    uint32_t gens[65] = {0};
    pthread_mutex_lock(&mu);
    for (uint32_t i = 0; i < rin[0]; i++) { VSock *s = vs(rin[1 + i]); gens[1 + i] = s ? s->gen : 0; }
    for (;;) {
        total = 0;
        uint32_t keep = 0;
        if (rd) {
            for (uint32_t i = 0; i < rin[0]; i++) {
                uint32_t fd = rin[1 + i];
                VSock *s = vs(fd);
                /* readable: data waiting, or closed meanwhile (the next recvfrom then fails, as on Windows) */
                int closed = !s || (fd >= SOCK_BASE && fd < SOCK_BASE + NSOCK && socks[fd - SOCK_BASE].gen != gens[1 + i]);
                if (closed || s->qh != s->qt) WR32(rd + 4 + keep++ * 4, fd);
            }
            WR32(rd, keep); total += keep;
        }
        if (total || ms == 0) break;
        if (wr && RD32(wr)) break;
        if (ms < 0) pthread_cond_wait(&cv, &mu);
        else if (pthread_cond_timedwait(&cv, &mu, &dl)) break;
    }
    pthread_mutex_unlock(&mu);
    if (wr) total += RD32(wr);         /* datagram sockets are always writable */
    if (ex) WR32(ex, 0);
    return total;
}
static uint32_t ws_FDIsSet(CPU *c, const uint32_t *a) { (void)c; return (uint32_t)fdset_has(A(1), A(0)); }

static uint32_t ws_htons(CPU *c, const uint32_t *a) { (void)c; return __builtin_bswap16((uint16_t)A(0)); }
static uint32_t ws_gethostname(CPU *c, const uint32_t *a) { (void)c; snprintf(HSTR(A(0)), A(1), "nfs3web"); return 0; }
static uint32_t ws_inet_addr(CPU *c, const uint32_t *a) {
    (void)c; unsigned b[4];
    if (sscanf(HSTR(A(0)), "%u.%u.%u.%u", &b[0], &b[1], &b[2], &b[3]) != 4) return 0xFFFFFFFFu;
    return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
}
static uint32_t ntoa_buf;
static uint32_t ws_inet_ntoa(CPU *c, const uint32_t *a) {
    (void)c;
    if (!ntoa_buf) ntoa_buf = galloc(32);
    uint32_t v = A(0);
    snprintf(HSTR(ntoa_buf), 32, "%u.%u.%u.%u", v & 255, (v >> 8) & 255, (v >> 16) & 255, v >> 24);
    return ntoa_buf;
}
static uint32_t ws_unsupported(CPU *c, const uint32_t *a) { (void)c; (void)a; return fail(WSAEAFNOSUPPORT); }
static uint32_t ws_null(CPU *c, const uint32_t *a) { (void)c; (void)a; last_err = WSAENETDOWN; return 0; }

#define W(n, args, fn) {"WSOCK32.DLL", #n, args, fn}
const ImportDef imp_wsock32[] = {
    W(WSAStartup, 2, ws_WSAStartup), W(WSACleanup, 0, ws_WSACleanup), W(WSAGetLastError, 0, ws_WSAGetLastError),
    W(socket, 3, ws_socket), W(closesocket, 1, ws_closesocket), W(bind, 3, ws_bind), W(getsockname, 3, ws_getsockname),
    W(setsockopt, 5, ws_setsockopt), W(ioctlsocket, 3, ws_ioctlsocket), W(sendto, 6, ws_sendto), W(recvfrom, 6, ws_recvfrom),
    W(select, 5, ws_select), W(__WSAFDIsSet, 2, ws_FDIsSet),
    W(htons, 1, ws_htons), W(ntohs, 1, ws_htons), W(gethostname, 2, ws_gethostname), W(inet_addr, 1, ws_inet_addr),
    W(inet_ntoa, 1, ws_inet_ntoa), W(gethostbyname, 1, ws_null),
    /* stream sockets (the game's TCP/IP mode) aren't available */
    W(listen, 2, ws_unsupported), W(shutdown, 2, ws_unsupported), W(connect, 3, ws_unsupported), W(accept, 3, ws_unsupported),
    W(send, 4, ws_unsupported), W(recv, 4, ws_unsupported),
    {0},
};

/* RT_NET_STATS=1: one traffic line per second */
static void *stats_main(void *unused) {
    (void)unused;
    uint64_t ptx = 0, prx = 0, ptxb = 0, prxb = 0;
    for (;;) {
        sleep(1);
        rt_log("net/s: tx %llu pkts %llu B, rx %llu pkts %llu B, drops %llu",
               (unsigned long long)(stats.tx - ptx), (unsigned long long)(stats.txb - ptxb),
               (unsigned long long)(stats.rx - prx), (unsigned long long)(stats.rxb - prxb), (unsigned long long)stats.drop);
        ptx = stats.tx; prx = stats.rx; ptxb = stats.txb; prxb = stats.rxb;
    }
    return NULL;
}
