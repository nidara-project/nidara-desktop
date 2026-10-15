/* hyalo-layer-motion-probe.c — a window with two layers Hyalo animates for it
 * (nidara-layers-v1, hyalo/compositor/src/protocols/layers.rs): test 5 of the toolkit's
 * phase 0 (#818, toolkit/CONTRACT.md). For scripts/ci/hyalo-layer-motion-check.py.
 *
 * A 400×300 dark window; layer A (80×60, red, the "button") at (20, 40) and layer B (80×60,
 * blue, a plain pane) at (20, 180), both subsurfaces in sync mode.
 *
 * SIGUSR1: both get a 2 s linear transition to x = 300, committed with the window, and then
 *          the probe BLOCKS for 1.5 s without reading or committing anything: whatever moves
 *          on screen meanwhile, Hyalo moves. The clicks that arrive meanwhile are read when it
 *          wakes.
 *
 *   wayland-scanner client-header/private-code for xdg-shell and nidara-layers-v1 (protocols/
 *   at the repository root), then
 *   cc hyalo-layer-motion-probe.c xdg-shell-protocol.c nidara-layers-v1-protocol.c \
 *      -I<gen> $(pkg-config --cflags --libs wayland-client) -o hyalo-layer-motion-probe
 *
 * What it prints:
 *   READY                                 mapped, both layers placed
 *   NO_LAYERS                             the compositor offers no nidara-layers-v1; it exits
 *   MOVED                                 the transitions are committed; it blocks now
 *   AWAKE                                 it reads again
 *   PRESS <A|B|WINDOW> <x> <y>            a button press, on that surface, surface-local
 *   DONE <serial> / CANCELLED <serial>    the layer's events
 */
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <poll.h>
#include <errno.h>
#include <sys/mman.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "nidara-layers-v1-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_subcompositor *subcompositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct wl_seat *seat;
static struct nidara_layers_manager_v1 *layers_mgr;
static volatile sig_atomic_t go;
static void on_signal(int sig) { go = 1; }

static struct wl_surface *window, *surf_a, *surf_b, *entered;
static struct nidara_layer_v1 *layer_a, *layer_b;
static double px, py;
static int configured;

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_subcompositor_interface.name) == 0)
        subcompositor = wl_registry_bind(reg, name, &wl_subcompositor_interface, 1);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, xdg_wm_base_interface.name) == 0)
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, wl_seat_interface.name) == 0 && !seat)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, nidara_layers_manager_v1_interface.name) == 0)
        layers_mgr = wl_registry_bind(reg, name, &nidara_layers_manager_v1_interface, 1);
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
static void top_close(void *d, struct xdg_toplevel *t) { exit(0); }
static void top_bounds(void *d, struct xdg_toplevel *t, int32_t w, int32_t h) {}
static void top_caps(void *d, struct xdg_toplevel *t, struct wl_array *c) {}
static const struct xdg_toplevel_listener toplevel_listener = { top_configure, top_close, top_bounds, top_caps };

static void layer_done(void *d, struct nidara_layer_v1 *l, uint32_t serial, uint32_t hi, uint32_t lo, uint32_t ns) {
    printf("DONE %u\n", serial);
    fflush(stdout);
}
static void layer_cancelled(void *d, struct nidara_layer_v1 *l, uint32_t serial) {
    printf("CANCELLED %u\n", serial);
    fflush(stdout);
}
static const struct nidara_layer_v1_listener layer_listener = { layer_done, layer_cancelled };

static const char *name_of(struct wl_surface *s) {
    return s == surf_a ? "A" : s == surf_b ? "B" : s == window ? "WINDOW" : "?";
}
static void p_enter(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y) {
    entered = s;
    px = wl_fixed_to_double(x);
    py = wl_fixed_to_double(y);
}
static void p_leave(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) { entered = NULL; }
static void p_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) {
    px = wl_fixed_to_double(x);
    py = wl_fixed_to_double(y);
}
static void p_button(void *d, struct wl_pointer *p, uint32_t serial, uint32_t t, uint32_t b, uint32_t st) {
    if (st != WL_POINTER_BUTTON_STATE_PRESSED) return;
    printf("PRESS %s %.1f %.1f\n", name_of(entered), px, py);
    fflush(stdout);
}
static void p_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t a, wl_fixed_t v) {}
static const struct wl_pointer_listener pointer_listener = { p_enter, p_leave, p_motion, p_button, p_axis };

static struct wl_buffer *solid_buffer(int w, int h, uint32_t colour) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("probe", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    uint32_t *pix = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int i = 0; i < w * h; i++) pix[i] = colour;
    munmap(pix, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buf;
}

static struct nidara_layer_v1 *make_layer(struct wl_surface **s, uint32_t colour, double x, double y) {
    *s = wl_compositor_create_surface(compositor);
    wl_subcompositor_get_subsurface(subcompositor, *s, window); /* sync mode: the default */
    struct nidara_layer_v1 *l = nidara_layers_manager_v1_get_layer(layers_mgr, *s);
    nidara_layer_v1_add_listener(l, &layer_listener, NULL);
    nidara_layer_v1_set_position(l, wl_fixed_from_double(x), wl_fixed_from_double(y));
    wl_surface_attach(*s, solid_buffer(80, 60, colour), 0, 0);
    wl_surface_damage(*s, 0, 0, 80, 60);
    wl_surface_commit(*s);
    return l;
}

/* Both layers to x = 300 in 2 s, linear, landed with one commit of the window. */
static void move_layers(void) {
    nidara_layer_v1_set_curve_transition(layer_a, NIDARA_LAYER_V1_PROPERTY_POSITION, 1,
        wl_fixed_from_double(0), wl_fixed_from_double(0), wl_fixed_from_double(1), wl_fixed_from_double(1), 2000);
    nidara_layer_v1_set_position(layer_a, wl_fixed_from_double(300), wl_fixed_from_double(40));
    nidara_layer_v1_set_curve_transition(layer_b, NIDARA_LAYER_V1_PROPERTY_POSITION, 2,
        wl_fixed_from_double(0), wl_fixed_from_double(0), wl_fixed_from_double(1), wl_fixed_from_double(1), 2000);
    nidara_layer_v1_set_position(layer_b, wl_fixed_from_double(300), wl_fixed_from_double(180));
    wl_surface_commit(surf_a);
    wl_surface_commit(surf_b);
    wl_surface_commit(window);
}

int main(void) {
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!layers_mgr) { printf("NO_LAYERS\n"); return 2; }
    if (!compositor || !subcompositor || !shm || !wm_base || !seat) { fprintf(stderr, "missing globals\n"); return 1; }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    wl_pointer_add_listener(wl_seat_get_pointer(seat), &pointer_listener, NULL);
    signal(SIGUSR1, on_signal);

    window = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, window);
    xdg_surface_add_listener(xs, &xdg_surface_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, "hyalo-layer-motion-probe");
    xdg_toplevel_set_app_id(top, "hyalo-layer-motion-probe");
    wl_surface_commit(window);
    while (!configured && wl_display_dispatch(d) != -1) {}

    layer_a = make_layer(&surf_a, 0xffe02020, 20, 40);
    layer_b = make_layer(&surf_b, 0xff2040e0, 20, 180);
    xdg_surface_set_window_geometry(xs, 0, 0, 400, 300);
    wl_surface_attach(window, solid_buffer(400, 300, 0xff202020), 0, 0);
    wl_surface_damage(window, 0, 0, 400, 300);
    wl_surface_commit(window);
    wl_display_roundtrip(d);
    printf("READY\n");
    fflush(stdout);

    struct pollfd pfd = { wl_display_get_fd(d), POLLIN, 0 };
    for (;;) {
        if (go) {
            go = 0;
            move_layers();
            wl_display_flush(d);
            printf("MOVED\n");
            fflush(stdout);
            /* Blocked: no read, no commit. Whatever moves now, Hyalo moves. */
            struct timespec nap = { 1, 500000000 };
            while (nanosleep(&nap, &nap) == -1 && errno == EINTR) {}
            printf("AWAKE\n");
            fflush(stdout);
        }
        while (wl_display_prepare_read(d) != 0) wl_display_dispatch_pending(d);
        wl_display_flush(d);
        if (poll(&pfd, 1, 50) > 0) {
            wl_display_read_events(d);
            wl_display_dispatch_pending(d);
        } else {
            wl_display_cancel_read(d);
        }
    }
}
