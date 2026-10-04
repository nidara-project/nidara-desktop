/* hyalo-title-bar-probe.c — a window that leaves its decorations to the compositor, as kitty
 * does (xdg-decoration, server-side), so Hyalo draws its title bar over it
 * (hyalo/compositor/src/render/title_bar.rs). Its top rows are light, the rest dark: the bar
 * must take the light colour, and dark ink on it. For scripts/ci/hyalo-title-bar-check.sh.
 *
 *   wayland-scanner client-header/private-code for xdg-shell, xdg-decoration-unstable-v1 and
 *   viewporter, then
 *   cc hyalo-title-bar-probe.c xdg-shell-protocol.c xdg-decoration-unstable-v1-protocol.c \
 *      viewporter-protocol.c -I<gen> $(pkg-config --cflags --libs wayland-client) \
 *      -o hyalo-title-bar-probe
 *
 * Server-side, it draws into a buffer TWICE as wide as its window, the right half black, and
 * crops it with a viewport — as Chrome does after a resize (measured, 2026-10-03): the bar
 * takes the colour of the window's top row, not of the buffer's.
 *
 * SIGUSR1: it switches to its own frame while it runs — asks for client-side and draws a
 * shadow margin around itself, as Chrome does when "Use system title bar and borders" is
 * turned off, and cuts its own corners round (CORNER px, transparent) as a GTK dialog does.
 * SIGUSR2: back to server-side, its buffer its box again.
 * SIGHUP: its own maximize button — asks to be maximized, or restored when it is.
 *
 * With its own frame it takes the size each configure gives it, as an app does, and it answers
 * a change of state the way real apps do (measured nested, 2026-10-04): before it acks the
 * configure that maximizes it, it commits a frame drawn for the new state over the OLD
 * geometry — opaque to its edges, no margin, as Chrome's web apps do; and right after it asks
 * to be restored, before any configure, it commits its maximized size again with its margin
 * back, as Telegram does. Neither frame is the size it chose.
 *
 * What it prints (the check reads these lines):
 *   SHOWN                      its first buffer is up
 *   POINTER enter|leave        the pointer on its surface
 *   BUTTON <state>             a button event reached it
 *   STATE <maximized|normal>   each configure
 *   SWITCHED <client|server>   it changed its decorations (the signals)
 *   CLOSED                     xdg_toplevel.close, then it exits
 */
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
#include <sys/mman.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "xdg-decoration-unstable-v1-client-protocol.h"
#include "viewporter-client-protocol.h"

#define W 400
#define H 250
#define TOP 40          /* rows of the light colour at the top */
#define MARGIN 12       /* its shadow margin, when it draws its own frame */
#define CORNER 8        /* the radius it cuts its own corners to, with its own frame */
#define LIGHT 0xffe6e6e6
#define DARK 0xff303030
/* Its shadow margin: translucent red (premultiplied), so a margin Hyalo should not draw shows
 * (render/window.rs `push`: it cuts a client-side frame to its box). Used only when it draws
 * its own frame. */
#define SHADOW 0x60600000

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct wl_seat *seat;
static struct zxdg_decoration_manager_v1 *deco_mgr;
static struct wp_viewporter *viewporter;
static struct wp_viewport *viewport;
static struct wl_surface *surface;
static struct xdg_surface *xs;
static struct zxdg_toplevel_decoration_v1 *deco;
static struct xdg_toplevel *top;
static int configured, closed, maximized;
static int own;            /* it draws its own frame */
static int cfg_w, cfg_h;   /* the size the last configure gave it (0: its own, W×H) */
static int was_maximized;  /* the state it last drew */
static volatile sig_atomic_t want_switch;   /* 1 client-side, 2 server-side */
static volatile sig_atomic_t want_maximize; /* SIGHUP: its own maximize button */

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wp_viewporter_interface.name) == 0)
        viewporter = wl_registry_bind(reg, name, &wp_viewporter_interface, 1);
    else if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, xdg_wm_base_interface.name) == 0)
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, wl_seat_interface.name) == 0 && !seat)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, zxdg_decoration_manager_v1_interface.name) == 0)
        deco_mgr = wl_registry_bind(reg, name, &zxdg_decoration_manager_v1_interface, 1);
}
static void global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

static void ping(void *data, struct xdg_wm_base *b, uint32_t serial) { xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wm_base_listener = { ping };

static void draw(int own_frame);
static void draw_frame(int margin, int w, int h, int gx, int gy, int gw, int gh, int opaque_all);

static void surface_configure(void *data, struct xdg_surface *s, uint32_t serial) {
    /* Maximized with its own frame: first a frame for the new state, over the old geometry. */
    if (own && configured && maximized && !was_maximized && cfg_w > 0)
        draw_frame(0, cfg_w, cfg_h, MARGIN, MARGIN, W, H, 1);
    xdg_surface_ack_configure(s, serial);
    if (own && configured) draw(1);
    configured = 1;
}
static const struct xdg_surface_listener xdg_surface_listener = { surface_configure };

static void top_configure(void *d, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {
    uint32_t *s;
    maximized = 0;
    wl_array_for_each(s, states) if (*s == XDG_TOPLEVEL_STATE_MAXIMIZED) maximized = 1;
    cfg_w = w;
    cfg_h = h;
    printf("STATE %s\n", maximized ? "maximized" : "normal");
    fflush(stdout);
}
static void top_close(void *d, struct xdg_toplevel *t) { closed = 1; }
static void top_bounds(void *d, struct xdg_toplevel *t, int32_t w, int32_t h) {}
static void top_caps(void *d, struct xdg_toplevel *t, struct wl_array *c) {}
static const struct xdg_toplevel_listener toplevel_listener = { top_configure, top_close, top_bounds, top_caps };

static void deco_configure(void *d, struct zxdg_toplevel_decoration_v1 *dc, uint32_t mode) {}
static const struct zxdg_toplevel_decoration_v1_listener deco_listener = { deco_configure };

static void p_enter(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y) {
    printf("POINTER enter\n");
    fflush(stdout);
}
static void p_leave(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) {
    printf("POINTER leave\n");
    fflush(stdout);
}
static void p_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) {}
static void p_button(void *d, struct wl_pointer *p, uint32_t serial, uint32_t t, uint32_t b, uint32_t st) {
    printf("BUTTON %u\n", st);
    fflush(stdout);
}
static void p_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t a, wl_fixed_t v) {}
static const struct wl_pointer_listener pointer_listener = { p_enter, p_leave, p_motion, p_button, p_axis };

/* Its content at W×H — light top rows, dark below — with `margin` px of shadow room around
 * it (0: its buffer is its box), and `extra` px of black on the right that the viewport crops. */
/* Whether (x, y) of a bw×bh box is outside its own rounded corner. */
static int cut(int x, int y, int bw, int bh) {
    double dx = x < CORNER ? CORNER - x - 0.5 : x >= bw - CORNER ? x - (bw - CORNER) + 0.5 : 0;
    double dy = y < CORNER ? CORNER - y - 0.5 : y >= bh - CORNER ? y - (bh - CORNER) + 0.5 : 0;
    return dx > 0 && dy > 0 && dx * dx + dy * dy > CORNER * CORNER;
}

static struct wl_buffer *content(int margin, int extra, int bw, int bh) {
    int w = bw + 2 * margin + extra, h = bh + 2 * margin, stride = w * 4, size = stride * h;
    int fd = memfd_create("probe", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    uint32_t *px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            int in = x >= margin && x < margin + bw && y >= margin && y < margin + bh;
            px[y * w + x] = x >= bw + 2 * margin ? 0xff000000
                          : !in ? SHADOW
                          : margin && cut(x - margin, y - margin, bw, bh) ? 0x00000000
                          : (y - margin < TOP ? LIGHT : DARK);
        }
    munmap(px, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *b = wl_shm_pool_create_buffer(pool, 0, w, h, stride, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return b;
}

/* A frame drawn for one state, declared with a geometry that may be another's: a w×h box with
 * `margin` px of shadow around it, the window geometry (gx, gy, gw, gh), opaque over its whole
 * buffer when `opaque_all`. Own frame only. */
static void draw_frame(int margin, int w, int h, int gx, int gy, int gw, int gh, int opaque_all) {
    xdg_surface_set_window_geometry(xs, gx, gy, gw, gh);
    wp_viewport_set_source(viewport, wl_fixed_from_int(-1), wl_fixed_from_int(-1), wl_fixed_from_int(-1), wl_fixed_from_int(-1));
    wp_viewport_set_destination(viewport, -1, -1);
    wl_surface_attach(surface, content(margin, 0, w, h), 0, 0);
    wl_surface_damage(surface, 0, 0, w + 2 * margin, h + 2 * margin);
    struct wl_region *r = wl_compositor_create_region(compositor);
    if (opaque_all) {
        wl_region_add(r, 0, 0, w + 2 * margin, h + 2 * margin);
    } else {
        wl_region_add(r, margin + CORNER, margin, w - 2 * CORNER, h);
        wl_region_add(r, margin, margin + CORNER, w, h - 2 * CORNER);
    }
    wl_surface_set_opaque_region(surface, r);
    wl_region_destroy(r);
    wl_surface_commit(surface);
}

static void draw(int own_frame) {
    own = own_frame;
    if (own_frame) {
        /* Its own frame: the size it was given, no margin maximized. */
        int w = cfg_w > 0 ? cfg_w : W, h = cfg_h > 0 ? cfg_h : H, m = maximized ? 0 : MARGIN;
        was_maximized = maximized;
        draw_frame(m, w, h, m, m, w, h, 0);
        return;
    }
    xdg_surface_set_window_geometry(xs, 0, 0, W, H);
    wp_viewport_set_source(viewport, 0, 0, wl_fixed_from_int(W), wl_fixed_from_int(H));
    wp_viewport_set_destination(viewport, W, H);
    wl_surface_attach(surface, content(0, W, W, H), 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    /* Opaque where its content is: a client that drops its frame says so (wm/mod.rs). */
    struct wl_region *r = wl_compositor_create_region(compositor);
    wl_region_add(r, 0, 0, W, H);
    wl_surface_set_opaque_region(surface, r);
    wl_region_destroy(r);
    wl_surface_commit(surface);
}

static void on_signal(int sig) { want_switch = sig == SIGUSR1 ? 1 : 2; }
static void on_maximize(int sig) { want_maximize = 1; }

int main(void) {
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!compositor || !shm || !wm_base || !seat || !viewporter) { fprintf(stderr, "missing a core global\n"); return 1; }
    if (!deco_mgr) { printf("NO_DECORATIONS\n"); fflush(stdout); return 1; }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    wl_pointer_add_listener(wl_seat_get_pointer(seat), &pointer_listener, NULL);
    signal(SIGUSR1, on_signal);
    signal(SIGUSR2, on_signal);
    signal(SIGHUP, on_maximize);

    surface = wl_compositor_create_surface(compositor);
    viewport = wp_viewporter_get_viewport(viewporter, surface);
    xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xdg_surface_listener, NULL);
    top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, "Title bar probe");
    xdg_toplevel_set_app_id(top, "hyalo-title-bar-probe");
    deco = zxdg_decoration_manager_v1_get_toplevel_decoration(deco_mgr, top);
    zxdg_toplevel_decoration_v1_add_listener(deco, &deco_listener, NULL);
    zxdg_toplevel_decoration_v1_set_mode(deco, ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE);
    wl_surface_commit(surface);
    while (!configured && wl_display_dispatch(d) != -1) {}
    draw(0);
    wl_display_roundtrip(d);
    printf("SHOWN\n");
    fflush(stdout);

    while (!closed) {
        wl_display_flush(d);
        struct pollfd p = { wl_display_get_fd(d), POLLIN, 0 };
        if (poll(&p, 1, 100) > 0) wl_display_dispatch(d);
        else wl_display_dispatch_pending(d);
        if (want_switch) {
            int own = want_switch == 1;
            want_switch = 0;
            zxdg_toplevel_decoration_v1_set_mode(deco, own ? ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE
                                                           : ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE);
            draw(own);
            printf("SWITCHED %s\n", own ? "client" : "server");
            fflush(stdout);
        }
        if (want_maximize) {
            want_maximize = 0;
            if (maximized) {
                xdg_toplevel_unset_maximized(top);
                /* Restoring with its own frame: its maximized size again, margin back, before
                 * any configure tells it its size. */
                if (own && cfg_w > 0) draw_frame(MARGIN, cfg_w, cfg_h, MARGIN, MARGIN, cfg_w, cfg_h, 0);
            } else {
                xdg_toplevel_set_maximized(top);
            }
        }
    }
    printf("CLOSED\n");
    fflush(stdout);
    return 0;
}
