/* hyalo-ime-probe.c — the smallest input method: when a text field is activated it commits a
 * fixed string, then exits. For scripts/ci/hyalo-ime-check.sh; it stands in for fcitx5 (whose
 * Chinese engine is ~540 MiB), and exercises the same path: text-input-v3 in the app,
 * input-method-v2 here, Hyalo between them.
 *
 *   input-method-unstable-v2.xml comes from the wayland-protocols-misc crate Hyalo builds with
 *   (not packaged by wayland-protocols); generate its client header and code with wayland-scanner,
 *   then  cc hyalo-ime-probe.c input-method-unstable-v2-protocol.c -I<gen> \
 *            $(pkg-config --cflags --libs wayland-client) -o hyalo-ime-probe
 *   ./hyalo-ime-probe TEXT      prints ACTIVATED, then COMMITTED, and exits
 *   ./hyalo-ime-probe --hold    commits nothing and runs until killed, holding the keyboard while a
 *                               field is active and letting go when it is not, as fcitx5 does
 *                               (prints GRABBED / RELEASED) — for scripts/ci/hyalo-popup-check.sh
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "input-method-unstable-v2-client-protocol.h"

static struct wl_seat *seat;
static struct zwp_input_method_manager_v2 *manager;
static int active, done_count, committed, hold;
static const char *text;
static struct zwp_input_method_keyboard_grab_v2 *grab;

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_seat_interface.name) == 0 && !seat)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, zwp_input_method_manager_v2_interface.name) == 0)
        manager = wl_registry_bind(reg, name, &zwp_input_method_manager_v2_interface, 1);
}
static void global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

static void im_activate(void *d, struct zwp_input_method_v2 *im) { active = 1; }
static void im_deactivate(void *d, struct zwp_input_method_v2 *im) { active = 0; }
/* --hold: the grab follows the field, applied on `done` like everything else in the protocol. */
static void hold_follow(struct zwp_input_method_v2 *im) {
    if (active && !grab) {
        grab = zwp_input_method_v2_grab_keyboard(im);
        printf("GRABBED\n");
    } else if (!active && grab) {
        zwp_input_method_keyboard_grab_v2_release(grab);
        grab = NULL;
        printf("RELEASED\n");
    }
    fflush(stdout);
}
static void im_surrounding(void *d, struct zwp_input_method_v2 *im, const char *t, uint32_t c, uint32_t a) {}
static void im_cause(void *d, struct zwp_input_method_v2 *im, uint32_t cause) {}
static void im_content_type(void *d, struct zwp_input_method_v2 *im, uint32_t hint, uint32_t purpose) {}
static void im_done(void *d, struct zwp_input_method_v2 *im) {
    done_count++;
    if (hold) {
        hold_follow(im);
        return;
    }
    if (active && !committed) {
        printf("ACTIVATED\n");
        zwp_input_method_v2_commit_string(im, text);
        zwp_input_method_v2_commit(im, done_count);
        committed = 1;
        printf("COMMITTED\n");
        fflush(stdout);
    }
}
static void im_unavailable(void *d, struct zwp_input_method_v2 *im) {
    fprintf(stderr, "input method unavailable (another one is running)\n");
    exit(1);
}
static const struct zwp_input_method_v2_listener im_listener = {
    im_activate, im_deactivate, im_surrounding, im_cause, im_content_type, im_done, im_unavailable,
};

int main(int argc, char **argv) {
    hold = argc > 1 && strcmp(argv[1], "--hold") == 0;
    text = argc > 1 ? argv[1] : "hyalo-ime";
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!seat || !manager) { fprintf(stderr, "no input-method-v2 manager offered\n"); return 1; }
    struct zwp_input_method_v2 *im = zwp_input_method_manager_v2_get_input_method(manager, seat);
    zwp_input_method_v2_add_listener(im, &im_listener, NULL);
    printf("READY\n");
    fflush(stdout);
    while ((hold || !committed) && wl_display_dispatch(d) != -1) {}
    wl_display_roundtrip(d);
    return committed ? 0 : 1;
}
