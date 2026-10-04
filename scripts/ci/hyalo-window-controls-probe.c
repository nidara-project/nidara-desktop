/* hyalo-window-controls-probe.c — a window that leaves room for Hyalo's window controls
 * (nidara-window-controls-v1, hyalo/compositor/src/protocols/window_controls.rs), as the kit
 * does (ui/lib/nidara-kit/platform/window-controls.ts): it reserves the box the compositor
 * gives, 12 px from its top corner on the side the compositor says, and moves it when the side
 * changes. For scripts/ci/hyalo-window-controls-check.sh and hyalo-minimize-check.sh.
 *
 * SIGUSR1: it asks for close alone (set_buttons), as an About window does.
 * SIGUSR2: it asks for every button again, but stops changing size (min = max), as a window
 *          that is not resizable does: nothing to maximize.
 * SIGHUP:  it can change size again.
 * SIGURG:  it asks to be minimized (xdg_toplevel.set_minimized), as an app's own minimize
 *          button does.
 * HYALO_PROBE_DIALOG=1: it also opens a dialog of its window (xdg_toplevel.set_parent), which
 *          leaves room for its controls the same way.
 *
 *   wayland-scanner client-header/private-code for xdg-shell and nidara-window-controls-v1
 *   (protocols/ at the repository root), then
 *   cc hyalo-window-controls-probe.c xdg-shell-protocol.c nidara-window-controls-v1-protocol.c \
 *      -I<gen> $(pkg-config --cflags --libs wayland-client) -o hyalo-window-controls-probe
 *
 * What it prints (the check reads these lines; the dialog's start with "CHILD "):
 *   LAYOUT <right|left> <width> <height>   each layout event
 *   PLACED <x> <y>                         the position it sent, surface-local
 *   POINTER enter|leave                    the pointer on its surface
 *   STATE <maximized|normal>               each configure
 *   CLOSED                                 xdg_toplevel.close, then it exits
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
#include "nidara-window-controls-v1-client-protocol.h"

#define INSET 12

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct wl_seat *seat;
static struct nidara_window_controls_manager_v1 *controls_mgr;
static int closed;
static volatile sig_atomic_t want;   /* the last signal, 0 none */
static void on_signal(int sig) { want = sig; }

struct win {
    const char *tag;   /* "" for the window, "CHILD " for its dialog */
    int w, h;
    uint32_t colour;
    struct wl_surface *surface;
    struct xdg_toplevel *top;
    struct nidara_window_controls_v1 *controls;
    int configured, have_layout, pending_place;
    unsigned side;
    double box_w, box_h;
};
static struct win main_win = { "", 400, 200, 0xff404040 };
static struct win child_win = { "CHILD ", 300, 150, 0xff606060 };

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, xdg_wm_base_interface.name) == 0)
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, wl_seat_interface.name) == 0 && !seat)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, nidara_window_controls_manager_v1_interface.name) == 0)
        controls_mgr = wl_registry_bind(reg, name, &nidara_window_controls_manager_v1_interface, 1);
}
static void global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

static void ping(void *data, struct xdg_wm_base *b, uint32_t serial) { xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wm_base_listener = { ping };

static void surface_configure(void *data, struct xdg_surface *s, uint32_t serial) {
    xdg_surface_ack_configure(s, serial);
    ((struct win *)data)->configured = 1;
}
static const struct xdg_surface_listener xdg_surface_listener = { surface_configure };

static void top_configure(void *d, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states) {
    struct win *win = d;
    int maximized = 0;
    uint32_t *s;
    wl_array_for_each(s, states) if (*s == XDG_TOPLEVEL_STATE_MAXIMIZED) maximized = 1;
    printf("%sSTATE %s\n", win->tag, maximized ? "maximized" : "normal");
    fflush(stdout);
}
static void top_close(void *d, struct xdg_toplevel *t) { if (d == &main_win) closed = 1; }
static void top_bounds(void *d, struct xdg_toplevel *t, int32_t w, int32_t h) {}
static void top_caps(void *d, struct xdg_toplevel *t, struct wl_array *c) {}
static const struct xdg_toplevel_listener toplevel_listener = { top_configure, top_close, top_bounds, top_caps };

static void layout(void *data, struct nidara_window_controls_v1 *c, uint32_t s, wl_fixed_t w, wl_fixed_t h) {
    struct win *win = data;
    win->side = s;
    win->box_w = wl_fixed_to_double(w);
    win->box_h = wl_fixed_to_double(h);
    win->have_layout = 1;
    win->pending_place = 1;
    printf("%sLAYOUT %s %g %g\n", win->tag, s == NIDARA_WINDOW_CONTROLS_V1_SIDE_LEFT ? "left" : "right", win->box_w, win->box_h);
    fflush(stdout);
}
static const struct nidara_window_controls_v1_listener controls_listener = { layout };

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

static struct wl_buffer *solid_buffer(int w, int h, uint32_t colour) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("probe", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    uint32_t *px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int i = 0; i < w * h; i++) px[i] = colour;
    munmap(px, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *b = wl_shm_pool_create_buffer(pool, 0, w, h, stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return b;
}

/* The box, INSET from the top corner on the layout's side; committed with a fresh buffer. */
static void place(struct win *win) {
    double x = win->side == NIDARA_WINDOW_CONTROLS_V1_SIDE_LEFT ? INSET : win->w - INSET - win->box_w;
    nidara_window_controls_v1_set_position(win->controls, wl_fixed_from_double(x), wl_fixed_from_double(INSET));
    wl_surface_attach(win->surface, solid_buffer(win->w, win->h, win->colour), 0, 0);
    wl_surface_damage(win->surface, 0, 0, win->w, win->h);
    wl_surface_commit(win->surface);
    printf("%sPLACED %g %d\n", win->tag, x, INSET);
    fflush(stdout);
    win->pending_place = 0;
}

static void open_window(struct wl_display *d, struct win *win, const char *title, struct xdg_toplevel *parent) {
    win->surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, win->surface);
    xdg_surface_add_listener(xs, &xdg_surface_listener, win);
    win->top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(win->top, &toplevel_listener, win);
    xdg_toplevel_set_title(win->top, title);
    xdg_toplevel_set_app_id(win->top, "hyalo-window-controls-probe");
    if (parent) xdg_toplevel_set_parent(win->top, parent);
    win->controls = nidara_window_controls_manager_v1_get_window_controls(controls_mgr, win->surface);
    nidara_window_controls_v1_add_listener(win->controls, &controls_listener, win);
    wl_surface_commit(win->surface);
    while ((!win->configured || !win->have_layout) && wl_display_dispatch(d) != -1) {}
    place(win);
}

int main(void) {
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!compositor || !shm || !wm_base || !seat) { fprintf(stderr, "missing a core global\n"); return 1; }
    if (!controls_mgr) { printf("NO_CONTROLS\n"); fflush(stdout); return 1; }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    wl_pointer_add_listener(wl_seat_get_pointer(seat), &pointer_listener, NULL);
    signal(SIGUSR1, on_signal);
    signal(SIGUSR2, on_signal);
    signal(SIGHUP, on_signal);
    signal(SIGURG, on_signal);

    open_window(d, &main_win, "window-controls-probe", NULL);
    const char *dialog = getenv("HYALO_PROBE_DIALOG");
    if (dialog && strcmp(dialog, "1") == 0) open_window(d, &child_win, "window-controls-probe-dialog", main_win.top);

    while (!closed) {
        wl_display_flush(d);
        struct pollfd p = { wl_display_get_fd(d), POLLIN, 0 };
        if (poll(&p, 1, 100) > 0) wl_display_dispatch(d);
        else wl_display_dispatch_pending(d);
        if (want) {
            int sig = want;
            want = 0;
            if (sig == SIGUSR1) {
                nidara_window_controls_v1_set_buttons(main_win.controls, NIDARA_WINDOW_CONTROLS_V1_BUTTON_CLOSE);
            } else if (sig == SIGUSR2) {
                nidara_window_controls_v1_set_buttons(main_win.controls, NIDARA_WINDOW_CONTROLS_V1_BUTTON_CLOSE
                    | NIDARA_WINDOW_CONTROLS_V1_BUTTON_MINIMIZE | NIDARA_WINDOW_CONTROLS_V1_BUTTON_MAXIMIZE);
                xdg_toplevel_set_min_size(main_win.top, main_win.w, main_win.h);
                xdg_toplevel_set_max_size(main_win.top, main_win.w, main_win.h);
            } else if (sig == SIGURG) {
                xdg_toplevel_set_minimized(main_win.top);
            } else {
                xdg_toplevel_set_min_size(main_win.top, 0, 0);
                xdg_toplevel_set_max_size(main_win.top, 0, 0);
            }
            printf("ASKED %d\n", sig);
            fflush(stdout);
            if (sig != SIGURG) main_win.pending_place = 1;   /* committed with its buffer, as the kit commits */
        }
        if (main_win.pending_place) place(&main_win);
        if (child_win.surface && child_win.pending_place) place(&child_win);
    }
    printf("CLOSED\n");
    fflush(stdout);
    return 0;
}
