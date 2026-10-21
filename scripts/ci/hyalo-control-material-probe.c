/* hyalo-control-material-probe.c — a control on glass answers its backdrop (toolkit/CONTRACT.md,
 * "Floating control capsule"; nidara-material-v1 set_response, add_state_region, set_ink_colors,
 * add_ink_coverage). For scripts/ci/hyalo-control-material-check.py.
 *
 * A 400×300 window, one colour (the page: --page white, the default, or --page black). Over it a
 * capsule layer (nidara-layers-v1) at (100, 100), 160×40, its buffer transparent but for two 16 px
 * green squares — the glyphs: A at (20, 12), inside an ink coverage rectangle; B at (124, 12),
 * outside any. Its material: the compositor's glass (set_glass), a dark tone and a light ink tone
 * (the shell's control tones), a shadow, an answer to the backdrop (set_response, settle 0 unless
 * --settle MS), one shape, a translucent red wash at (60, 4), 32×32 (add_state_region), white and
 * black inks (set_ink_colors) and A's coverage (add_ink_coverage).
 *
 * Each flag drops one part, for the check's controls:
 *   --no-response      no set_response: no answer
 *   --no-ink-tone      no set_ink_tone: the tone has nothing to move towards
 *   --no-shadow-gain   set_response with both shadow gains 0
 *   --no-state         the wash's alpha 0
 *   --no-ink           no set_ink_colors: the coverage is drawn as painted
 *   --overlap          a second coverage rectangle overlapping A's: a protocol error
 *   --flip-after MS    the page turns black MS after READY (the answer then eases, --settle)
 *
 *   wayland-scanner client-header/private-code for xdg-shell, nidara-layers-v1 and
 *   nidara-material-v1 (protocols/ at the repository root), then
 *   cc hyalo-control-material-probe.c xdg-shell-protocol.c nidara-layers-v1-protocol.c \
 *      nidara-material-v1-protocol.c -I<gen> $(pkg-config --cflags --libs wayland-client) \
 *      -o hyalo-control-material-probe
 *
 * What it prints:
 *   READY                mapped, the capsule placed with its material
 *   FLIPPED              the page turned black (--flip-after)
 *   ERROR <interface> <code>   the compositor sent a protocol error
 *   NO_LAYERS            the compositor offers no nidara-layers-v1 or nidara-material-v1
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <poll.h>
#include <unistd.h>
#include <sys/mman.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "nidara-layers-v1-client-protocol.h"
#include "nidara-material-v1-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_subcompositor *subcompositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct nidara_layers_manager_v1 *layers_mgr;
static struct nidara_material_manager_v1 *material_mgr;
static struct wl_surface *window;
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
    else if (strcmp(iface, nidara_layers_manager_v1_interface.name) == 0)
        layers_mgr = wl_registry_bind(reg, name, &nidara_layers_manager_v1_interface, 1);
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

static void layer_done(void *d, struct nidara_layer_v1 *l, uint32_t serial, uint32_t hi, uint32_t lo, uint32_t ns) {}
static void layer_cancelled(void *d, struct nidara_layer_v1 *l, uint32_t serial) {}
static const struct nidara_layer_v1_listener layer_listener = { layer_done, layer_cancelled };

static void material_ink(void *d, struct nidara_material_v1 *m, uint32_t group, uint32_t dark) {}
static const struct nidara_material_v1_listener material_listener = { material_ink };

/* Every pixel `colour`, or transparent with the two glyph squares (`glyphs`). */
static struct wl_buffer *buffer(int w, int h, uint32_t colour, int glyphs) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("probe", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    uint32_t *pix = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            int in_glyph = y >= 12 && y < 28 && ((x >= 20 && x < 36) || (x >= 124 && x < 140));
            pix[y * w + x] = glyphs ? (in_glyph ? 0xff00ff00 : 0x00000000) : colour;
        }
    munmap(pix, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride, glyphs ? WL_SHM_FORMAT_ARGB8888 : WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buf;
}

static wl_fixed_t f(double v) { return wl_fixed_from_double(v); }

static void page(uint32_t colour) {
    wl_surface_attach(window, buffer(400, 300, colour, 0), 0, 0);
    wl_surface_damage(window, 0, 0, 400, 300);
    wl_surface_commit(window);
}

static long long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000LL + t.tv_nsec / 1000000;
}

int main(int argc, char **argv) {
    int black = 0, no_response = 0, no_ink_tone = 0, no_shadow_gain = 0, no_state = 0, no_ink = 0, overlap = 0;
    int flip_after = -1, settle = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--page") == 0 && i + 1 < argc) black = strcmp(argv[++i], "black") == 0;
        else if (strcmp(argv[i], "--no-response") == 0) no_response = 1;
        else if (strcmp(argv[i], "--no-ink-tone") == 0) no_ink_tone = 1;
        else if (strcmp(argv[i], "--no-shadow-gain") == 0) no_shadow_gain = 1;
        else if (strcmp(argv[i], "--no-state") == 0) no_state = 1;
        else if (strcmp(argv[i], "--no-ink") == 0) no_ink = 1;
        else if (strcmp(argv[i], "--overlap") == 0) overlap = 1;
        else if (strcmp(argv[i], "--flip-after") == 0 && i + 1 < argc) flip_after = atoi(argv[++i]);
        else if (strcmp(argv[i], "--settle") == 0 && i + 1 < argc) settle = atoi(argv[++i]);
    }
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!layers_mgr || !material_mgr) { printf("NO_LAYERS\n"); return 2; }
    if (!compositor || !subcompositor || !shm || !wm_base) { fprintf(stderr, "missing globals\n"); return 1; }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);

    window = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, window);
    xdg_surface_add_listener(xs, &xdg_surface_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, "hyalo-control-material-probe");
    xdg_toplevel_set_app_id(top, "hyalo-control-material-probe");
    wl_surface_commit(window);
    while (!configured && wl_display_dispatch(d) != -1) {}

    struct wl_surface *s = wl_compositor_create_surface(compositor);
    wl_subcompositor_get_subsurface(subcompositor, s, window); /* sync mode: the default */
    struct nidara_layer_v1 *l = nidara_layers_manager_v1_get_layer(layers_mgr, s);
    nidara_layer_v1_add_listener(l, &layer_listener, NULL);
    nidara_layer_v1_set_position(l, f(100), f(100));
    struct nidara_material_v1 *m = nidara_material_manager_v1_get_material(material_mgr, s);
    nidara_material_v1_add_listener(m, &material_listener, NULL);
    nidara_material_v1_set_glass(m, 0, 0, 0, 0, 0, 0, f(0), f(0), f(1));
    /* The shell's control tones (tokens/glass.json, dark face): dark, and light under dark ink. */
    nidara_material_v1_set_tone(m, f(1.3), f(0.6), f(0.125), f(1.125), 0, 0, 0, 0, 0, 0, f(1));
    if (!no_ink_tone)
        nidara_material_v1_set_ink_tone(m, f(1.2), f(0.94), f(0.4), f(1.03), f(1), f(1), f(1), f(0.2), 0, 0, f(1));
    nidara_material_v1_set_shadow(m, f(0.3), f(0.3), f(4), f(4), f(6));
    if (!no_response)
        nidara_material_v1_set_response(m, f(0.25), f(0.35), f(0.02), f(0.10),
                                        f(no_shadow_gain ? 0 : 1.5), 0, settle);
    nidara_material_v1_add_shape(m, 0, 0, f(160), f(40), f(20), f(2));
    nidara_material_v1_add_state_region(m, 1, f(60), f(4), f(32), f(32), f(16), f(1), 0, 0, f(no_state ? 0 : 0.5), 0);
    if (!no_ink)
        nidara_material_v1_set_ink_colors(m, f(1), f(1), f(1), f(1), 0, 0, 0, f(1));
    nidara_material_v1_add_ink_coverage(m, f(20), f(12), f(16), f(16), 0, 0, 0, 0);
    if (overlap)
        nidara_material_v1_add_ink_coverage(m, f(30), f(12), f(16), f(16), 0, 0, 0, 0);
    wl_surface_attach(s, buffer(160, 40, 0, 1), 0, 0);
    wl_surface_damage(s, 0, 0, 160, 40);
    wl_surface_commit(s);

    xdg_surface_set_window_geometry(xs, 0, 0, 400, 300);
    page(black ? 0xff000000 : 0xffffffff);
    if (wl_display_roundtrip(d) == -1) {
        const struct wl_interface *iface = NULL;
        uint32_t code = wl_display_get_protocol_error(d, &iface, NULL);
        printf("ERROR %s %u\n", iface ? iface->name : "?", code);
        return 3;
    }
    printf("READY\n");
    fflush(stdout);
    long long flip_at = flip_after >= 0 ? now_ms() + flip_after : -1;
    struct pollfd pfd = { wl_display_get_fd(d), POLLIN, 0 };
    for (;;) {
        wl_display_flush(d);
        int wait = flip_at < 0 ? -1 : (int)(flip_at - now_ms() > 0 ? flip_at - now_ms() : 0);
        if (poll(&pfd, 1, wait) > 0 && wl_display_dispatch(d) == -1) break;
        if (flip_at >= 0 && now_ms() >= flip_at) {
            page(0xff000000);
            flip_at = -1;
            printf("FLIPPED\n");
            fflush(stdout);
        }
    }
    return 0;
}
