// ─────────────────────────────────────────────────────────────────────────────
// crystal-input — synthetic POINTER for the computer-use layer (Phase 2b-ii).
// A minimal Wayland client that injects a pointer move / left-click via the
// wlroots zwlr_virtual_pointer_v1 protocol (Hyprland supports it). No daemon,
// no uinput, no root — the Wayland-native pointer path.
//
//   crystal-input move  <x> <y> <w> <h>
//   crystal-input click <x> <y> <w> <h>
//
// (x,y) is the target position and (w,h) the output's extent, BOTH in the same
// (logical) units — motion_absolute maps x/w → output fraction, so the caller
// passes logical output-relative coords + the output's logical size. This is a
// DUMB injector: all gating, focus verification, AT-SPI node resolution and
// geometry mapping live in the crystal-click GJS wrapper. Single-output for now
// (default seat/output); multi-monitor output targeting is a follow-up.
//
// Build (see install.sh): wayland-scanner generates the protocol glue from
// /usr/share/wlr-protocols/unstable/wlr-virtual-pointer-unstable-v1.xml, then
//   cc crystal-input.c <generated>.c $(pkg-config --cflags --libs wayland-client)
// ─────────────────────────────────────────────────────────────────────────────

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <linux/input-event-codes.h>   // BTN_LEFT
#include <wayland-client.h>
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static struct wl_seat *seat = NULL;
static struct zwlr_virtual_pointer_manager_v1 *mgr = NULL;

static void reg_global(void *data, struct wl_registry *reg, uint32_t name,
                       const char *iface, uint32_t version) {
    (void)data; (void)version;
    if (strcmp(iface, wl_seat_interface.name) == 0)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name) == 0)
        mgr = wl_registry_bind(reg, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d; (void)r; (void)n; }
static const struct wl_registry_listener reg_listener = { reg_global, reg_remove };

// Monotonic milliseconds for the protocol's time argument.
static uint32_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

int main(int argc, char **argv) {
    if (argc != 6 || (strcmp(argv[1], "move") && strcmp(argv[1], "click"))) {
        fprintf(stderr, "usage: crystal-input move|click <x> <y> <w> <h>\n");
        return 2;
    }
    int click = strcmp(argv[1], "click") == 0;
    uint32_t x = (uint32_t)strtoul(argv[2], NULL, 10);
    uint32_t y = (uint32_t)strtoul(argv[3], NULL, 10);
    uint32_t w = (uint32_t)strtoul(argv[4], NULL, 10);
    uint32_t h = (uint32_t)strtoul(argv[5], NULL, 10);

    struct wl_display *dpy = wl_display_connect(NULL);
    if (!dpy) { fprintf(stderr, "crystal-input: cannot connect to Wayland display\n"); return 1; }

    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_listener, NULL);
    wl_display_roundtrip(dpy);   // populate globals

    if (!mgr) {
        fprintf(stderr, "crystal-input: compositor does not expose zwlr_virtual_pointer_manager_v1\n");
        return 1;
    }

    struct zwlr_virtual_pointer_v1 *vp =
        zwlr_virtual_pointer_manager_v1_create_virtual_pointer(mgr, seat);

    uint32_t t = now_ms();
    zwlr_virtual_pointer_v1_motion_absolute(vp, t, x, y, w, h);
    zwlr_virtual_pointer_v1_frame(vp);

    if (click) {
        t = now_ms();
        zwlr_virtual_pointer_v1_button(vp, t, BTN_LEFT, WL_POINTER_BUTTON_STATE_PRESSED);
        zwlr_virtual_pointer_v1_frame(vp);
        t = now_ms();
        zwlr_virtual_pointer_v1_button(vp, t, BTN_LEFT, WL_POINTER_BUTTON_STATE_RELEASED);
        zwlr_virtual_pointer_v1_frame(vp);
    }

    // Flush + roundtrip so the events actually reach the compositor before exit.
    wl_display_flush(dpy);
    wl_display_roundtrip(dpy);

    zwlr_virtual_pointer_v1_destroy(vp);
    wl_display_disconnect(dpy);
    return 0;
}
