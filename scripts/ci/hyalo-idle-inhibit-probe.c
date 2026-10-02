/* hyalo-idle-inhibit-probe.c — a shown window that holds idle off for N seconds, then lets go
 * (idle-inhibit-unstable-v1, what a video player does). For scripts/ci/hyalo-idle-check.sh.
 *
 *   wayland-scanner client-header/private-code for xdg-shell and idle-inhibit, then
 *   cc hyalo-idle-inhibit-probe.c xdg-shell-protocol.c idle-inhibit-unstable-v1-protocol.c \
 *      -I<gen> $(pkg-config --cflags --libs wayland-client) -o hyalo-idle-inhibit-probe
 *   ./hyalo-idle-inhibit-probe SECONDS     prints INHIBITING, then RELEASED, then exits
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
#include "idle-inhibit-unstable-v1-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct zwp_idle_inhibit_manager_v1 *inhibit_manager;
static int configured;

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, xdg_wm_base_interface.name) == 0)
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, zwp_idle_inhibit_manager_v1_interface.name) == 0)
        inhibit_manager = wl_registry_bind(reg, name, &zwp_idle_inhibit_manager_v1_interface, 1);
}
static void global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

static void ping(void *data, struct xdg_wm_base *b, uint32_t serial) { xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wm_base_listener = { ping };

static void surface_configure(void *data, struct xdg_surface *s, uint32_t serial) {
    xdg_surface_ack_configure(s, serial);
    configured = 1;
}
static const struct xdg_surface_listener xdg_surface_listener = { surface_configure };

static void top_configure(void *d, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *s) {}
static void top_close(void *d, struct xdg_toplevel *t) {}
static void top_bounds(void *d, struct xdg_toplevel *t, int32_t w, int32_t h) {}
static void top_caps(void *d, struct xdg_toplevel *t, struct wl_array *c) {}
static const struct xdg_toplevel_listener toplevel_listener = { top_configure, top_close, top_bounds, top_caps };

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

int main(int argc, char **argv) {
    int secs = argc > 1 ? atoi(argv[1]) : 5;
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!compositor || !shm || !wm_base || !inhibit_manager) {
        fprintf(stderr, "missing a global (inhibit manager: %s)\n", inhibit_manager ? "yes" : "NO");
        return 1;
    }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    struct wl_surface *surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xdg_surface_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, "idle-inhibit-probe");
    wl_surface_commit(surface);
    while (!configured && wl_display_dispatch(d) != -1) {}
    wl_surface_attach(surface, grey_buffer(160, 120), 0, 0);
    wl_surface_commit(surface);
    run_for(d, 300);

    struct zwp_idle_inhibitor_v1 *inhibitor = zwp_idle_inhibit_manager_v1_create_inhibitor(inhibit_manager, surface);
    wl_display_roundtrip(d);
    printf("INHIBITING\n");
    fflush(stdout);
    run_for(d, secs * 1000);
    zwp_idle_inhibitor_v1_destroy(inhibitor);
    wl_display_roundtrip(d);
    printf("RELEASED\n");
    fflush(stdout);
    run_for(d, 60 * 1000);   /* stays shown, no longer holding anything */
    return 0;
}
