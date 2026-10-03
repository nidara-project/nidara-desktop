/* hyalo-decoration-probe.c — a window that asks who draws its title bar, and draws itself as
 * kitty does with the answer: server-side → its buffer IS its box; client-side → a shadow
 * margin around it (`set_window_geometry` inset), the case Hyalo leaves square. Both protocols
 * Hyalo answers (hyalo/compositor/src/shell/decoration.rs): xdg-decoration, then KDE's
 * server-decoration on a second window. For scripts/ci/hyalo-decoration-check.sh.
 *
 *   wayland-scanner client-header/private-code for xdg-shell, xdg-decoration-unstable-v1 and
 *   server-decoration (the wayland-protocols-misc crate's XML), then
 *   cc hyalo-decoration-probe.c xdg-shell-protocol.c xdg-decoration-unstable-v1-protocol.c \
 *      server-decoration-protocol.c -I<gen> $(pkg-config --cflags --libs wayland-client) \
 *      -o hyalo-decoration-probe
 *   ./hyalo-decoration-probe     prints what it was told, then SHOWN, and stays up a minute
 *
 * What it prints (the check reads these lines):
 *   XDG_ASKED_CLIENT <mode>   the configure that answered set_mode(client_side)
 *   XDG_UNSET <mode>          the mode in force after unset_mode
 *   KDE_DEFAULT <mode>        the manager's default
 *   KDE_MODE <mode>           the last mode sent for the surface after request_mode(client)
 * <mode> is server, client or none (nothing was sent).
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <poll.h>
#include <sys/mman.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "xdg-decoration-unstable-v1-client-protocol.h"
#include "server-decoration-client-protocol.h"

#define W 300
#define H 200
#define MARGIN 12

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct zxdg_decoration_manager_v1 *xdg_deco_manager;
static struct org_kde_kwin_server_decoration_manager *kde_manager;
static int xdg_mode;       /* 0 = none sent yet */
static int kde_default = -1, kde_mode = -1;

static const char *xdg_name(int m) {
    return m == ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE ? "server"
         : m == ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE ? "client" : "none";
}
static const char *kde_name(int m) {
    return m == ORG_KDE_KWIN_SERVER_DECORATION_MODE_SERVER ? "server"
         : m == ORG_KDE_KWIN_SERVER_DECORATION_MODE_CLIENT ? "client" : "none";
}

static void kde_manager_default(void *d, struct org_kde_kwin_server_decoration_manager *m, uint32_t mode) {
    kde_default = (int)mode;
}
static const struct org_kde_kwin_server_decoration_manager_listener kde_manager_listener = { kde_manager_default };

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, xdg_wm_base_interface.name) == 0)
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, zxdg_decoration_manager_v1_interface.name) == 0)
        xdg_deco_manager = wl_registry_bind(reg, name, &zxdg_decoration_manager_v1_interface, 1);
    else if (strcmp(iface, org_kde_kwin_server_decoration_manager_interface.name) == 0) {
        kde_manager = wl_registry_bind(reg, name, &org_kde_kwin_server_decoration_manager_interface, 1);
        org_kde_kwin_server_decoration_manager_add_listener(kde_manager, &kde_manager_listener, NULL);
    }
}
static void global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

static void ping(void *data, struct xdg_wm_base *b, uint32_t serial) { xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wm_base_listener = { ping };

static void surface_configure(void *data, struct xdg_surface *s, uint32_t serial) {
    xdg_surface_ack_configure(s, serial);
    *(int *)data = 1;
}
static const struct xdg_surface_listener xdg_surface_listener = { surface_configure };

static void top_configure(void *d, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *s) {}
static void top_close(void *d, struct xdg_toplevel *t) {}
static void top_bounds(void *d, struct xdg_toplevel *t, int32_t w, int32_t h) {}
static void top_caps(void *d, struct xdg_toplevel *t, struct wl_array *c) {}
static const struct xdg_toplevel_listener toplevel_listener = { top_configure, top_close, top_bounds, top_caps };

static void deco_configure(void *d, struct zxdg_toplevel_decoration_v1 *deco, uint32_t mode) {
    xdg_mode = (int)mode;
}
static const struct zxdg_toplevel_decoration_v1_listener deco_listener = { deco_configure };

static void kde_mode_event(void *d, struct org_kde_kwin_server_decoration *deco, uint32_t mode) {
    kde_mode = (int)mode;
}
static const struct org_kde_kwin_server_decoration_listener kde_listener = { kde_mode_event };

static struct wl_buffer *grey_buffer(int w, int h) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("probe", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    uint32_t *px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int i = 0; i < w * h; i++) px[i] = 0xff808080;
    munmap(px, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *b = wl_shm_pool_create_buffer(pool, 0, w, h, stride, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return b;
}

/* Dispatches for `ms` milliseconds, answering pings. */
static void run_for(struct wl_display *d, int ms) {
    struct timespec t0, t;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (;;) {
        clock_gettime(CLOCK_MONOTONIC, &t);
        int left = ms - (int)((t.tv_sec - t0.tv_sec) * 1000 + (t.tv_nsec - t0.tv_nsec) / 1000000);
        if (left <= 0) return;
        wl_display_flush(d);
        struct pollfd p = { wl_display_get_fd(d), POLLIN, 0 };
        if (poll(&p, 1, left) > 0) wl_display_dispatch(d);
        else wl_display_dispatch_pending(d);
    }
}

/* A toplevel up to its first configure, not yet drawn. */
static struct wl_surface *toplevel(const char *title, int *configured, struct xdg_surface **xs_out,
                                   struct xdg_toplevel **top_out) {
    struct wl_surface *surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xdg_surface_listener, configured);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, title);
    *xs_out = xs;
    *top_out = top;
    return surface;
}

/* Drawn as kitty would be with `server_side`: its buffer is its box, or a margin around it. */
static void draw(struct wl_surface *surface, struct xdg_surface *xs, int server_side) {
    if (server_side) {
        wl_surface_attach(surface, grey_buffer(W, H), 0, 0);
    } else {
        xdg_surface_set_window_geometry(xs, MARGIN, MARGIN, W, H);
        wl_surface_attach(surface, grey_buffer(W + 2 * MARGIN, H + 2 * MARGIN), 0, 0);
    }
    wl_surface_commit(surface);
}

int main(void) {
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    wl_display_roundtrip(d);   /* the KDE manager's default_mode */
    if (!compositor || !shm || !wm_base) { fprintf(stderr, "missing a core global\n"); return 1; }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);

    /* 1. xdg-decoration, asked for client-side before the first commit, as a client that
     *    prefers its own bar would. */
    struct xdg_surface *xs;
    struct xdg_toplevel *top;
    int configured = 0;
    struct wl_surface *surface = toplevel("decoration-probe-xdg", &configured, &xs, &top);
    struct zxdg_toplevel_decoration_v1 *deco = NULL;
    if (xdg_deco_manager) {
        deco = zxdg_decoration_manager_v1_get_toplevel_decoration(xdg_deco_manager, top);
        zxdg_toplevel_decoration_v1_add_listener(deco, &deco_listener, NULL);
        zxdg_toplevel_decoration_v1_set_mode(deco, ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
    }
    wl_surface_commit(surface);
    while (!configured && wl_display_dispatch(d) != -1) {}
    printf("XDG_ASKED_CLIENT %s\n", xdg_name(xdg_mode));
    /* The mode is only sent again when it changes: what counts is the one in force. */
    if (deco) {
        zxdg_toplevel_decoration_v1_unset_mode(deco);
        wl_display_roundtrip(d);
        wl_display_roundtrip(d);
    }
    printf("XDG_UNSET %s\n", xdg_name(xdg_mode));
    draw(surface, xs, xdg_mode == ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE);

    /* 2. KDE's server-decoration (Qt), on a second window, asking for client-side. */
    struct xdg_surface *kxs;
    struct xdg_toplevel *ktop;
    int kconfigured = 0;
    struct wl_surface *ksurface = toplevel("decoration-probe-kde", &kconfigured, &kxs, &ktop);
    if (kde_manager) {
        struct org_kde_kwin_server_decoration *kdeco = org_kde_kwin_server_decoration_manager_create(kde_manager, ksurface);
        org_kde_kwin_server_decoration_add_listener(kdeco, &kde_listener, NULL);
        org_kde_kwin_server_decoration_request_mode(kdeco, ORG_KDE_KWIN_SERVER_DECORATION_MODE_CLIENT);
    }
    wl_surface_commit(ksurface);
    while (!kconfigured && wl_display_dispatch(d) != -1) {}
    wl_display_roundtrip(d);
    printf("KDE_DEFAULT %s\n", kde_name(kde_default));
    printf("KDE_MODE %s\n", kde_name(kde_mode));
    draw(ksurface, kxs, kde_mode == ORG_KDE_KWIN_SERVER_DECORATION_MODE_SERVER);

    run_for(d, 300);
    printf("SHOWN\n");
    fflush(stdout);
    run_for(d, 60 * 1000);
    return 0;
}
