/* hyalo-layer-glass-probe.c — a layer's own glass over its window's content, and a graded blur
 * (toolkit/PHASE1.md D7: the sidebar and the title bar float over the content). For
 * scripts/ci/hyalo-layer-glass-check.py.
 *
 * A 400×300 window whose content is a sharp pattern: 4 px white and black columns. Over it, two
 * layers (nidara-layers-v1, synchronized subsurfaces) with fully transparent buffers, each with
 * a material (nidara-material-v1) on its OWN surface:
 *   the sidebar   at (0, 0),   120×300, one shape, blurred (set_blur 4, 3);
 *   the title bar at (120, 0), 280×60,  one shape, the same blur graded from 1 at its top edge
 *                 to 0 at its bottom edge (set_shape_grade).
 * Whatever shows the pattern softened under them is Hyalo blurring the window's own content
 * under a layer's material.
 *
 *   --no-material  the control: the layers keep no material (the sidebar's columns stay sharp)
 *   --uniform      the control: the title bar's blur is not graded (as blurred at its bottom
 *                  edge as at its top)
 *
 *   wayland-scanner client-header/private-code for xdg-shell, nidara-layers-v1 and
 *   nidara-material-v1 (protocols/ at the repository root), then
 *   cc hyalo-layer-glass-probe.c xdg-shell-protocol.c nidara-layers-v1-protocol.c \
 *      nidara-material-v1-protocol.c -I<gen> $(pkg-config --cflags --libs wayland-client) \
 *      -o hyalo-layer-glass-probe
 *
 * What it prints:
 *   READY                mapped, both layers placed with their materials
 *   NO_LAYERS            the compositor offers no nidara-layers-v1 or nidara-material-v1
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

/* `stripes`: 4 px white and black columns; otherwise every pixel `colour`. */
static struct wl_buffer *buffer(int w, int h, int stripes, uint32_t colour, uint32_t format) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("probe", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    uint32_t *pix = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
            pix[y * w + x] = stripes ? ((x / 4) % 2 ? 0xff000000 : 0xffffffff) : colour;
    munmap(pix, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride, format);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buf;
}

/* A layer at (x, y), w×h, transparent; with its own material unless `bare`. */
static void make_layer(double x, double y, int w, int h, int bare, int graded) {
    struct wl_surface *s = wl_compositor_create_surface(compositor);
    wl_subcompositor_get_subsurface(subcompositor, s, window); /* sync mode: the default */
    struct nidara_layer_v1 *l = nidara_layers_manager_v1_get_layer(layers_mgr, s);
    nidara_layer_v1_add_listener(l, &layer_listener, NULL);
    nidara_layer_v1_set_position(l, wl_fixed_from_double(x), wl_fixed_from_double(y));
    if (!bare) {
        struct nidara_material_v1 *m = nidara_material_manager_v1_get_material(material_mgr, s);
        nidara_material_v1_add_listener(m, &material_listener, NULL);
        nidara_material_v1_set_blur(m, wl_fixed_from_double(4), 3);
        if (graded)
            nidara_material_v1_set_shape_grade(m, wl_fixed_from_double(1), wl_fixed_from_double(0));
        nidara_material_v1_add_shape(m, 0, 0, wl_fixed_from_int(w), wl_fixed_from_int(h), 0, wl_fixed_from_int(2));
    }
    wl_surface_attach(s, buffer(w, h, 0, 0x00000000, WL_SHM_FORMAT_ARGB8888), 0, 0);
    wl_surface_damage(s, 0, 0, w, h);
    wl_surface_commit(s);
}

int main(int argc, char **argv) {
    int bare = 0, uniform = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--no-material") == 0) bare = 1;
        else if (strcmp(argv[i], "--uniform") == 0) uniform = 1;
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
    xdg_toplevel_set_title(top, "hyalo-layer-glass-probe");
    xdg_toplevel_set_app_id(top, "hyalo-layer-glass-probe");
    wl_surface_commit(window);
    while (!configured && wl_display_dispatch(d) != -1) {}

    make_layer(0, 0, 120, 300, bare, 0);
    make_layer(120, 0, 280, 60, bare, !uniform);
    xdg_surface_set_window_geometry(xs, 0, 0, 400, 300);
    wl_surface_attach(window, buffer(400, 300, 1, 0, WL_SHM_FORMAT_XRGB8888), 0, 0);
    wl_surface_damage(window, 0, 0, 400, 300);
    wl_surface_commit(window);
    wl_display_roundtrip(d);
    printf("READY\n");
    fflush(stdout);
    while (wl_display_dispatch(d) != -1) {}
    return 0;
}
