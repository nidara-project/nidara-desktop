// output-mode WIDTHxHEIGHT — sets every head of a wlroots compositor to a custom mode of that size,
// through wlr-output-management. The glass lab's exports run in a headless cage, whose output is
// 1280×720 with no way to ask for another; this makes it the export's exact size (1080×1920 for a
// 9:16 video), so the file is drawn at its own resolution — never enlarged from a smaller frame.
// Built by glass-lab.sh into its sandbox when an export asks for a size.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "wlr-output-management-unstable-v1-client-protocol.h"

static struct zwlr_output_manager_v1 *manager;
static struct zwlr_output_head_v1 *heads[8];
static int n_heads, done, result;
static uint32_t serial;

static void head_name(void *d, struct zwlr_output_head_v1 *h, const char *n) {}
static void head_desc(void *d, struct zwlr_output_head_v1 *h, const char *s) {}
static void head_phys(void *d, struct zwlr_output_head_v1 *h, int32_t w, int32_t hh) {}
static void head_mode(void *d, struct zwlr_output_head_v1 *h, struct zwlr_output_mode_v1 *m) {}
static void head_enabled(void *d, struct zwlr_output_head_v1 *h, int32_t e) {}
static void head_cur(void *d, struct zwlr_output_head_v1 *h, struct zwlr_output_mode_v1 *m) {}
static void head_pos(void *d, struct zwlr_output_head_v1 *h, int32_t x, int32_t y) {}
static void head_tr(void *d, struct zwlr_output_head_v1 *h, int32_t t) {}
static void head_scale(void *d, struct zwlr_output_head_v1 *h, wl_fixed_t s) {}
static void head_finished(void *d, struct zwlr_output_head_v1 *h) {}
static void head_make(void *d, struct zwlr_output_head_v1 *h, const char *s) {}
static void head_model(void *d, struct zwlr_output_head_v1 *h, const char *s) {}
static void head_serial(void *d, struct zwlr_output_head_v1 *h, const char *s) {}
static void head_adaptive(void *d, struct zwlr_output_head_v1 *h, uint32_t a) {}
static const struct zwlr_output_head_v1_listener head_listener = {
    head_name, head_desc, head_phys, head_mode, head_enabled, head_cur, head_pos, head_tr, head_scale,
    head_finished, head_make, head_model, head_serial, head_adaptive,
};
static void mgr_head(void *d, struct zwlr_output_manager_v1 *m, struct zwlr_output_head_v1 *h) {
    if (n_heads < 8) heads[n_heads++] = h;
    zwlr_output_head_v1_add_listener(h, &head_listener, NULL);
}
static void mgr_done(void *d, struct zwlr_output_manager_v1 *m, uint32_t s) { serial = s; done = 1; }
static void mgr_finished(void *d, struct zwlr_output_manager_v1 *m) {}
static const struct zwlr_output_manager_v1_listener mgr_listener = { mgr_head, mgr_done, mgr_finished };

static void cfg_ok(void *d, struct zwlr_output_configuration_v1 *c) { result = 1; }
static void cfg_fail(void *d, struct zwlr_output_configuration_v1 *c) { result = -1; }
static void cfg_cancel(void *d, struct zwlr_output_configuration_v1 *c) { result = -2; }
static const struct zwlr_output_configuration_v1_listener cfg_listener = { cfg_ok, cfg_fail, cfg_cancel };

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t v) {
    if (strcmp(iface, zwlr_output_manager_v1_interface.name) == 0)
        manager = wl_registry_bind(r, name, &zwlr_output_manager_v1_interface, v < 2 ? v : 2);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t name) {}
static const struct wl_registry_listener reg_listener = { reg_global, reg_remove };

int main(int argc, char **argv) {
    int w, h;
    if (argc != 2 || sscanf(argv[1], "%dx%d", &w, &h) != 2) { fprintf(stderr, "usage: output-mode WxH\n"); return 2; }
    struct wl_display *dpy = wl_display_connect(NULL);
    if (!dpy) { fprintf(stderr, "output-mode: no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_listener, NULL);
    wl_display_roundtrip(dpy);
    if (!manager) { fprintf(stderr, "output-mode: no wlr-output-management\n"); return 1; }
    zwlr_output_manager_v1_add_listener(manager, &mgr_listener, NULL);
    while (!done && wl_display_dispatch(dpy) != -1) {}
    struct zwlr_output_configuration_v1 *cfg = zwlr_output_manager_v1_create_configuration(manager, serial);
    zwlr_output_configuration_v1_add_listener(cfg, &cfg_listener, NULL);
    for (int i = 0; i < n_heads; i++) {
        struct zwlr_output_configuration_head_v1 *ch = zwlr_output_configuration_v1_enable_head(cfg, heads[i]);
        zwlr_output_configuration_head_v1_set_custom_mode(ch, w, h, 0);
    }
    zwlr_output_configuration_v1_apply(cfg);
    while (!result && wl_display_dispatch(dpy) != -1) {}
    if (result != 1) fprintf(stderr, "output-mode: the compositor refused %dx%d (%d)\n", w, h, result);
    return result == 1 ? 0 : 1;
}
