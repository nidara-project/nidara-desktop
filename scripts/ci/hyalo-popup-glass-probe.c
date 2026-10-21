/* hyalo-popup-glass-probe.c — an application's menu, as the toolkit's dropdown will open it
 * (#882): an xdg_popup of a toplevel, placed by an xdg_positioner, wearing a material of its own
 * (nidara-material-v1), with a grab. For scripts/ci/hyalo-popup-glass-check.py.
 *
 * A 400×300 window of 4 px white and black columns. A click in it (the grab needs the click's
 * serial) opens a 240×260 popup anchored at (300, 280, 20 × 20) — near the window's bottom-right
 * corner — gravity bottom-right, constraint flip-y: there is no room under the window on the
 * output, so Hyalo must flip it above, and its right part lies past the window's right edge.
 * The popup's buffer is transparent; its material is the compositor's glass, one shape the whole
 * popup with corners of 12, a white wash at 0.5, its own blur.
 *
 *   --no-flip       the positioner allows no adjustment: the popup goes where it was asked
 *   --no-material   no material on the popup: nothing of it shows
 *   --no-grab       no grab: a click outside does not close it, the keyboard does not enter it
 *
 *   wayland-scanner client-header/private-code for xdg-shell and nidara-material-v1, then
 *   cc hyalo-popup-glass-probe.c xdg-shell-protocol.c nidara-material-v1-protocol.c \
 *      -I<gen> $(pkg-config --cflags --libs wayland-client) -o hyalo-popup-glass-probe
 *
 * What it prints:
 *   READY                       the window is mapped
 *   POPUP <x> <y> <w> <h>       the popup's configure, relative to the window's geometry
 *   KEYBOARD POPUP|WINDOW       which surface the keyboard entered
 *   DONE                        the compositor dismissed the popup (popup_done)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "nidara-material-v1-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct wl_seat *seat;
static struct xdg_wm_base *wm_base;
static struct nidara_material_manager_v1 *material_mgr;
static struct wl_surface *window, *popup_surface;
static struct xdg_surface *window_xs;
static int configured, no_flip, no_material, no_grab, opened;

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, wl_seat_interface.name) == 0)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 5);
    else if (strcmp(iface, xdg_wm_base_interface.name) == 0)
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 3);
    else if (strcmp(iface, nidara_material_manager_v1_interface.name) == 0)
        material_mgr = wl_registry_bind(reg, name, &nidara_material_manager_v1_interface, 1);
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

static void material_ink(void *d, struct nidara_material_v1 *m, uint32_t group, uint32_t dark) {}
static const struct nidara_material_v1_listener material_listener = { material_ink };

/* `stripes`: 4 px white and black columns; otherwise transparent. */
static struct wl_buffer *buffer(int w, int h, int stripes) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("probe", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    uint32_t *pix = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
            pix[y * w + x] = stripes ? ((x / 4) % 2 ? 0xff000000 : 0xffffffff) : 0x00000000;
    munmap(pix, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride, stripes ? WL_SHM_FORMAT_XRGB8888 : WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buf;
}

static wl_fixed_t f(double v) { return wl_fixed_from_double(v); }

static int popup_w = 240, popup_h = 260;

static void popup_configure(void *d, struct xdg_popup *p, int32_t x, int32_t y, int32_t w, int32_t h) {
    printf("POPUP %d %d %d %d\n", x, y, w, h);
    fflush(stdout);
}
static void popup_done(void *d, struct xdg_popup *p) {
    printf("DONE\n");
    fflush(stdout);
}
static void popup_repositioned(void *d, struct xdg_popup *p, uint32_t token) {}
static const struct xdg_popup_listener popup_listener = { popup_configure, popup_done, popup_repositioned };

static int popup_configured;
static void popup_surface_configure(void *data, struct xdg_surface *s, uint32_t serial) {
    xdg_surface_ack_configure(s, serial);
    if (!popup_configured) {
        popup_configured = 1;
        wl_surface_attach(popup_surface, buffer(popup_w, popup_h, 0), 0, 0);
        wl_surface_damage(popup_surface, 0, 0, popup_w, popup_h);
    }
    wl_surface_commit(popup_surface);
}
static const struct xdg_surface_listener popup_surface_listener = { popup_surface_configure };

static void open_popup(uint32_t serial) {
    struct xdg_positioner *pos = xdg_wm_base_create_positioner(wm_base);
    xdg_positioner_set_size(pos, popup_w, popup_h);
    xdg_positioner_set_anchor_rect(pos, 300, 280, 20, 20);
    xdg_positioner_set_anchor(pos, XDG_POSITIONER_ANCHOR_BOTTOM_LEFT);
    xdg_positioner_set_gravity(pos, XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT);
    xdg_positioner_set_constraint_adjustment(pos, no_flip ? XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_NONE
                                                          : XDG_POSITIONER_CONSTRAINT_ADJUSTMENT_FLIP_Y);
    popup_surface = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, popup_surface);
    xdg_surface_add_listener(xs, &popup_surface_listener, NULL);
    struct xdg_popup *p = xdg_surface_get_popup(xs, window_xs, pos);
    xdg_popup_add_listener(p, &popup_listener, NULL);
    if (!no_grab) xdg_popup_grab(p, seat, serial);
    if (!no_material) {
        struct nidara_material_v1 *m = nidara_material_manager_v1_get_material(material_mgr, popup_surface);
        nidara_material_v1_add_listener(m, &material_listener, NULL);
        nidara_material_v1_set_glass(m, 0, 0, 0, 0, 0, 0, f(0), f(0), f(1));
        nidara_material_v1_set_tone(m, f(1), f(1), 0, f(1), f(1), f(1), f(1), f(0.5), 0, 0, f(1));
        nidara_material_v1_add_shape(m, 0, 0, f(popup_w), f(popup_h), f(12), f(2));
    }
    xdg_positioner_destroy(pos);
    wl_surface_commit(popup_surface);
}

static void p_enter(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y) {}
static void p_leave(void *d, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) {}
static void p_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) {}
static void p_button(void *d, struct wl_pointer *p, uint32_t serial, uint32_t t, uint32_t button, uint32_t state) {
    if (state == WL_POINTER_BUTTON_STATE_PRESSED && !opened) {
        opened = 1;
        open_popup(serial);
    }
}
static void p_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t a, wl_fixed_t v) {}
static void p_frame(void *d, struct wl_pointer *p) {}
static void p_source(void *d, struct wl_pointer *p, uint32_t s) {}
static void p_stop(void *d, struct wl_pointer *p, uint32_t t, uint32_t a) {}
static void p_discrete(void *d, struct wl_pointer *p, uint32_t a, int32_t v) {}
static const struct wl_pointer_listener pointer_listener = { p_enter, p_leave, p_motion, p_button, p_axis, p_frame, p_source, p_stop, p_discrete };

static void k_keymap(void *d, struct wl_keyboard *k, uint32_t fmt, int32_t fd, uint32_t size) { close(fd); }
static void k_enter(void *d, struct wl_keyboard *k, uint32_t serial, struct wl_surface *s, struct wl_array *keys) {
    printf("KEYBOARD %s\n", s && s == popup_surface ? "POPUP" : "WINDOW");
    fflush(stdout);
}
static void k_leave(void *d, struct wl_keyboard *k, uint32_t serial, struct wl_surface *s) {}
static void k_key(void *d, struct wl_keyboard *k, uint32_t serial, uint32_t t, uint32_t key, uint32_t state) {}
static void k_mods(void *d, struct wl_keyboard *k, uint32_t serial, uint32_t a, uint32_t b, uint32_t c, uint32_t g) {}
static void k_repeat(void *d, struct wl_keyboard *k, int32_t rate, int32_t delay) {}
static const struct wl_keyboard_listener keyboard_listener = { k_keymap, k_enter, k_leave, k_key, k_mods, k_repeat };

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--no-flip") == 0) no_flip = 1;
        else if (strcmp(argv[i], "--no-material") == 0) no_material = 1;
        else if (strcmp(argv[i], "--no-grab") == 0) no_grab = 1;
    }
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!compositor || !shm || !wm_base || !seat || !material_mgr) { fprintf(stderr, "missing globals\n"); return 1; }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    wl_pointer_add_listener(wl_seat_get_pointer(seat), &pointer_listener, NULL);
    wl_keyboard_add_listener(wl_seat_get_keyboard(seat), &keyboard_listener, NULL);

    window = wl_compositor_create_surface(compositor);
    window_xs = xdg_wm_base_get_xdg_surface(wm_base, window);
    xdg_surface_add_listener(window_xs, &xdg_surface_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(window_xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, "hyalo-popup-glass-probe");
    xdg_toplevel_set_app_id(top, "hyalo-popup-glass-probe");
    wl_surface_commit(window);
    while (!configured && wl_display_dispatch(d) != -1) {}
    xdg_surface_set_window_geometry(window_xs, 0, 0, 400, 300);
    wl_surface_attach(window, buffer(400, 300, 1), 0, 0);
    wl_surface_damage(window, 0, 0, 400, 300);
    wl_surface_commit(window);
    wl_display_roundtrip(d);
    printf("READY\n");
    fflush(stdout);
    while (wl_display_dispatch(d) != -1) {}
    return 0;
}
