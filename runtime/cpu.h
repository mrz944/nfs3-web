/* Emulated x86 CPU state + helpers used by lifted code. */
#pragma once
#include <stdint.h>
#include <string.h>
#include <math.h>

typedef struct CPU {
    uint32_t r[8];          /* eax ecx edx ebx esp ebp esi edi */
    uint32_t df;            /* direction flag */
    uint32_t eflags_hi;     /* AC (bit 18) and ID (bit 21): toggled by CPU-detection code */
    uint32_t fs_base;       /* TEB address for fs: */
    uint16_t seg[6];        /* es cs ss ds fs gs selectors (flat model, values only) */
    double st[8];           /* x87 stack values (double precision) */
    uint8_t stx[8];         /* slot holds an exact int64 from fild m64 (FPU memcpy idiom) */
    int64_t sti[8];
    uint32_t top;
    uint16_t fsw, fcw;
    uint64_t mm[8];
    /* flags image for calls that need flags across function boundaries */
    uint32_t cf, zf, sf, of, pf;
} CPU;

enum { EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI };

/* Guest memory: guest VA == offset from G. On wasm32 G is 0 and the image
 * lives at its preferred base 0x400000 inside linear memory. */
extern uint8_t *G;

static inline uint8_t  RD8 (uint32_t a) { return G[a]; }
static inline uint16_t RD16(uint32_t a) { uint16_t v; memcpy(&v, G + a, 2); return v; }
static inline uint32_t RD32(uint32_t a) { uint32_t v; memcpy(&v, G + a, 4); return v; }
static inline uint64_t RD64(uint32_t a) { uint64_t v; memcpy(&v, G + a, 8); return v; }
static inline void WR8 (uint32_t a, uint8_t v)  { G[a] = v; }
static inline void WR16(uint32_t a, uint16_t v) { memcpy(G + a, &v, 2); }
static inline void WR32(uint32_t a, uint32_t v) { memcpy(G + a, &v, 4); }
static inline void WR64(uint32_t a, uint64_t v) { memcpy(G + a, &v, 8); }
static inline float  RDF32(uint32_t a) { float v;  memcpy(&v, G + a, 4); return v; }
static inline double RDF64(uint32_t a) { double v; memcpy(&v, G + a, 8); return v; }
static inline void WRF32(uint32_t a, float v)  { memcpy(G + a, &v, 4); }
static inline void WRF64(uint32_t a, double v) { memcpy(G + a, &v, 8); }
double RDF80(uint32_t a);
void   WRF80(uint32_t a, double v);

#define PUSH32(v) do { uint32_t _v = (v); c->r[ESP] -= 4; WR32(c->r[ESP], _v); } while (0)
#define POP32()   (c->r[ESP] += 4, RD32(c->r[ESP] - 4))

static inline uint32_t parity8(uint32_t v) { return !__builtin_parity(v & 0xFF); }

/* ---- x87 ---- */
#define ST(i) c->st[(c->top + (i)) & 7]
static inline void fpush(CPU *c, double v) { c->top = (c->top - 1) & 7; c->st[c->top] = v; c->stx[c->top] = 0; }
/* write ST(i) with a computed value: drops any exact-int64 shadow */
static inline void fset(CPU *c, int i, double v) { int p = (c->top + i) & 7; c->st[p] = v; c->stx[p] = 0; }
/* register-to-register moves keep the shadow */
static inline void fcopy(CPU *c, int dst, int src) {
    int d = (c->top + dst) & 7, s = (c->top + src) & 7;
    c->st[d] = c->st[s]; c->stx[d] = c->stx[s]; c->sti[d] = c->sti[s];
}
static inline void fpush_st(CPU *c, int src) {
    int s = (c->top + src) & 7; double v = c->st[s]; uint8_t x = c->stx[s]; int64_t iv = c->sti[s];
    fpush(c, v); c->stx[c->top] = x; c->sti[c->top] = iv;
}
static inline void fxch(CPU *c, int i) {
    int a = c->top & 7, b = (c->top + i) & 7;
    double t = c->st[a]; c->st[a] = c->st[b]; c->st[b] = t;
    uint8_t tx = c->stx[a]; c->stx[a] = c->stx[b]; c->stx[b] = tx;
    int64_t ti = c->sti[a]; c->sti[a] = c->sti[b]; c->sti[b] = ti;
}
static inline void fild64(CPU *c, int64_t v) { fpush(c, (double)v); c->stx[c->top] = 1; c->sti[c->top] = v; }
double fround(CPU *c, double v);
static inline int64_t fist64(CPU *c) { int p = c->top & 7; return c->stx[p] ? c->sti[p] : (int64_t)fround(c, c->st[p]); }
static inline void fpop(CPU *c) { c->top = (c->top + 1) & 7; }
static inline void fcompare(CPU *c, double a, double b) {
    uint16_t s = c->fsw & ~0x4500; /* clear C0 C2 C3 */
    if (a != a || b != b) s |= 0x4500;
    else if (a < b) s |= 0x0100;
    else if (a == b) s |= 0x4000;
    c->fsw = s;
}
static inline uint16_t fstsw(CPU *c) { return (c->fsw & ~0x3800) | ((c->top & 7) << 11); }
double fround(CPU *c, double v); /* honours fcw rounding control */

/* ---- dispatch / runtime hooks ---- */
typedef void (*gfn)(CPU *);
void call_indirect(CPU *c, uint32_t target);
void x86_trap(CPU *c, uint32_t addr, const char *what);
void x86_cpuid(CPU *c);
void x86_rdtsc(CPU *c);
void x86_int(CPU *c, uint32_t addr, uint32_t n);
void x86_fnsave(CPU *c, uint32_t a);
void x86_frstor(CPU *c, uint32_t a);

/* ---- optional call tracing (RT_TRACE=4edfe8,43b830 ...) ---- */
extern volatile int g_trace_any;
void trace_enter(CPU *c, uint32_t fn);
void trace_leave(CPU *c, uint32_t fn);
#define TRACE_ENTER(a) do { if (__builtin_expect(g_trace_any, 0)) trace_enter(c, a); } while (0)
#define TRACE_LEAVE(a) do { if (__builtin_expect(g_trace_any, 0)) trace_leave(c, a); } while (0)
