/*
 * pangotrace — answers ONE question about tech-debt #90: does anything ever
 * enter Pango on a thread other than the main one?
 *
 * The crash core has two threads inside Pango at the same moment: the main
 * thread in pango_renderer_draw_layout, and a GTask worker (GTK's icon LOAD
 * thread) in pango_cairo_show_glyph_string. Both of those symbols are UNDEFINED
 * in libgtk-4, so both resolve through the PLT and both can be interposed —
 * checked with `nm -D --undefined-only` before this file was written, because a
 * shim on an intra-library call would have been another instrument that cannot
 * fail.
 *
 * It reports, on exit AND the first time each happens:
 *   - total calls per symbol, so a run with zero calls is distinguishable from
 *     a shim that never loaded;
 *   - every distinct thread id that entered Pango, and which were not main;
 *   - overlap: two DIFFERENT threads inside Pango at the same instant, which is
 *     the actual bug condition and not merely a suspicious one.
 *
 *   cc -shared -fPIC -O2 -o /tmp/pangotrace.so scripts/dev/pangotrace.c -ldl
 *   LD_PRELOAD=/tmp/pangotrace.so gjs -m scripts/dev/icon-text-race.js
 *
 * ⚠️ Two of the four counters read 0 in a run that used raw pangocairo, and that
 * is not a defect: pango_renderer_activate is called by libpango on ITSELF, and
 * an intra-library call has no PLT entry to interpose. Both symbols that matter
 * here are called by libgtk-4, which is why they are seen. Prove the shim can
 * fail before trusting a green: two threads deliberately inside Pango make it
 * report a first off-main call, a first overlap, and non-zero totals.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>

#define MAXTID 64
static pid_t main_tid;
static atomic_int inflight;              /* distinct threads currently inside pango */
static atomic_int overlaps;
static atomic_int off_main_calls;
static atomic_long calls[4];
static const char *names[4] = { "pango_renderer_draw_layout",
                                "pango_renderer_draw_layout_line",
                                "pango_cairo_show_glyph_string",
                                "pango_renderer_activate" };
static atomic_int tids[MAXTID];
static atomic_int ntids;
static __thread int depth;               /* recursion must not read as concurrency */
static atomic_int said_off_main, said_overlap;

__attribute__((constructor)) static void init(void) {
    main_tid = (pid_t)syscall(SYS_gettid);
    fprintf(stderr, "[pangotrace] loaded, main tid=%d\n", main_tid);
}

static void note_tid(pid_t t) {
    int n = atomic_load(&ntids);
    for (int i = 0; i < n && i < MAXTID; i++)
        if (atomic_load(&tids[i]) == (int)t) return;
    int slot = atomic_fetch_add(&ntids, 1);
    if (slot < MAXTID) atomic_store(&tids[slot], (int)t);
}

static void enter(int which) {
    pid_t t = (pid_t)syscall(SYS_gettid);
    atomic_fetch_add(&calls[which], 1);
    note_tid(t);
    if (t != main_tid) {
        atomic_fetch_add(&off_main_calls, 1);
        if (!atomic_exchange(&said_off_main, 1))
            fprintf(stderr, "[pangotrace] FIRST off-main-thread pango call: tid=%d in %s\n",
                    t, names[which]);
    }
    if (depth++ == 0) {
        if (atomic_fetch_add(&inflight, 1) >= 1) {
            atomic_fetch_add(&overlaps, 1);
            if (!atomic_exchange(&said_overlap, 1))
                fprintf(stderr, "[pangotrace] FIRST OVERLAP: tid=%d entered %s while another thread was inside\n",
                        t, names[which]);
        }
    }
}

static void leave(void) { if (--depth == 0) atomic_fetch_sub(&inflight, 1); }

__attribute__((destructor)) static void report(void) {
    fprintf(stderr, "[pangotrace] --- summary ---\n");
    for (int i = 0; i < 4; i++)
        fprintf(stderr, "[pangotrace]   %-34s %ld calls\n", names[i], atomic_load(&calls[i]));
    int n = atomic_load(&ntids); if (n > MAXTID) n = MAXTID;
    fprintf(stderr, "[pangotrace]   threads that entered pango: %d (main=%d):", n, main_tid);
    for (int i = 0; i < n; i++) fprintf(stderr, " %d%s", atomic_load(&tids[i]),
                                        atomic_load(&tids[i]) == (int)main_tid ? "(main)" : "");
    fprintf(stderr, "\n[pangotrace]   off-main calls: %d   overlaps: %d\n",
            atomic_load(&off_main_calls), atomic_load(&overlaps));
}

#define WRAP(idx, ret, name, params, args)                       \
    ret name params {                                            \
        static ret (*real) params;                               \
        if (!real) real = dlsym(RTLD_NEXT, #name);               \
        enter(idx); real args; leave();                          \
    }

typedef struct _PangoRenderer PangoRenderer;
typedef struct _PangoLayout PangoLayout;
typedef struct _PangoLayoutLine PangoLayoutLine;
typedef struct _PangoFont PangoFont;
typedef struct _PangoGlyphString PangoGlyphString;
typedef struct _cairo cairo_t;

WRAP(0, void, pango_renderer_draw_layout,
     (PangoRenderer *r, PangoLayout *l, int x, int y), (r, l, x, y))
WRAP(1, void, pango_renderer_draw_layout_line,
     (PangoRenderer *r, PangoLayoutLine *l, int x, int y), (r, l, x, y))
WRAP(2, void, pango_cairo_show_glyph_string,
     (cairo_t *cr, PangoFont *f, PangoGlyphString *g), (cr, f, g))
WRAP(3, void, pango_renderer_activate, (PangoRenderer *r), (r))
