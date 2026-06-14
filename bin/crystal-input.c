// ─────────────────────────────────────────────────────────────────────────────
// crystal-input — synthetic POINTER for the computer-use layer (Phase 2b-ii).
// A minimal Wayland client that injects a pointer move / left-click via the
// wlroots zwlr_virtual_pointer_v1 protocol (Hyprland supports it). No daemon,
// no uinput, no root — the Wayland-native pointer path.
//
//   crystal-input move       <x> <y> <w> <h>
//   crystal-input click      <x> <y> <w> <h>          # left button
//   crystal-input rightclick <x> <y> <w> <h>          # right button
//   crystal-input scroll     <x> <y> <w> <h> <dx> <dy> # wheel notches at (x,y)
//   crystal-input drag       <x> <y> <w> <h> <x2> <y2> # press at (x,y), glide to (x2,y2), release
//
// (x,y) is the target position and (w,h) the output's extent, BOTH in the same
// (logical) units — motion_absolute maps x/w → output fraction, so the caller
// passes logical output-relative coords + the output's logical size. For scroll,
// <dx>/<dy> are signed wheel-notch counts (dy>0 = down, dx>0 = right); for drag,
// <x2>/<y2> are the drop point in the same units as <x>/<y>. This is a
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

// Emit |notches| discrete wheel steps on `axis` (sign of notches = direction).
// One frame per notch, mimicking a real mouse wheel: source + continuous value +
// discrete step count. value is the continuous fallback (15 units/notch — the
// wlroots wheel convention); `discrete` is the integer step apps use for line/
// notch scrolling. axis is called before axis_discrete (the latter extends it).
// No axis_stop — wheel sources have no kinetic end (unlike touchpad/finger).
static void emit_scroll(struct zwlr_virtual_pointer_v1 *vp, uint32_t axis, int notches) {
    if (notches == 0) return;
    int step = notches > 0 ? 1 : -1;
    int n = notches > 0 ? notches : -notches;
    wl_fixed_t value = wl_fixed_from_double(15.0 * step);
    for (int i = 0; i < n; i++) {
        uint32_t t = now_ms();
        zwlr_virtual_pointer_v1_axis_source(vp, WL_POINTER_AXIS_SOURCE_WHEEL);
        zwlr_virtual_pointer_v1_axis(vp, t, axis, value);
        zwlr_virtual_pointer_v1_axis_discrete(vp, t, axis, value, step);
        zwlr_virtual_pointer_v1_frame(vp);
    }
}

static void nap_ms(long ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

// Press at (x1,y1), glide to (x2,y2) over several interpolated motion steps with
// small real-time gaps, then release — drag-threshold / DnD detection needs the
// pointer to actually travel while the button is held, like a human drag (a
// single press→jump→release at a new spot usually does NOT register as a drag).
// Flush between steps so the events reach the compositor spread over time. The
// caller has already positioned the pointer at (x1,y1). Left button only.
static void emit_drag(struct wl_display *dpy, struct zwlr_virtual_pointer_v1 *vp,
                      uint32_t x1, uint32_t y1, uint32_t x2, uint32_t y2,
                      uint32_t w, uint32_t h) {
    const int STEPS = 24;
    wl_display_flush(dpy);   // make sure the initial positioning motion landed
    nap_ms(40);
    uint32_t t = now_ms();
    zwlr_virtual_pointer_v1_button(vp, t, BTN_LEFT, WL_POINTER_BUTTON_STATE_PRESSED);
    zwlr_virtual_pointer_v1_frame(vp);
    wl_display_flush(dpy);
    nap_ms(50);              // brief hold so the press registers before motion
    for (int s = 1; s <= STEPS; s++) {
        double f = (double)s / STEPS;
        uint32_t ix = (uint32_t)((double)x1 + ((double)x2 - (double)x1) * f + 0.5);
        uint32_t iy = (uint32_t)((double)y1 + ((double)y2 - (double)y1) * f + 0.5);
        t = now_ms();
        zwlr_virtual_pointer_v1_motion_absolute(vp, t, ix, iy, w, h);
        zwlr_virtual_pointer_v1_frame(vp);
        wl_display_flush(dpy);
        nap_ms(12);          // ~290ms glide total
    }
    nap_ms(50);              // settle at the target before dropping
    t = now_ms();
    zwlr_virtual_pointer_v1_button(vp, t, BTN_LEFT, WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(vp);
}

int main(int argc, char **argv) {
    const char *verb = argc >= 2 ? argv[1] : "";
    int is_move   = strcmp(verb, "move") == 0;
    int is_click  = strcmp(verb, "click") == 0;
    int is_right  = strcmp(verb, "rightclick") == 0;
    int is_scroll = strcmp(verb, "scroll") == 0;
    int is_drag   = strcmp(verb, "drag") == 0;
    if ((!is_move && !is_click && !is_right && !is_scroll && !is_drag) ||
        ((is_scroll || is_drag) ? argc != 8 : argc != 6)) {
        fprintf(stderr,
            "usage: crystal-input move|click|rightclick <x> <y> <w> <h>\n"
            "       crystal-input scroll <x> <y> <w> <h> <dx> <dy>\n"
            "       crystal-input drag   <x> <y> <w> <h> <x2> <y2>\n");
        return 2;
    }
    uint32_t x = (uint32_t)strtoul(argv[2], NULL, 10);
    uint32_t y = (uint32_t)strtoul(argv[3], NULL, 10);
    uint32_t w = (uint32_t)strtoul(argv[4], NULL, 10);
    uint32_t h = (uint32_t)strtoul(argv[5], NULL, 10);
    int dx = 0, dy = 0;
    uint32_t x2 = 0, y2 = 0;
    if (is_scroll) {
        dx = (int)strtol(argv[6], NULL, 10);
        dy = (int)strtol(argv[7], NULL, 10);
    } else if (is_drag) {
        x2 = (uint32_t)strtoul(argv[6], NULL, 10);
        y2 = (uint32_t)strtoul(argv[7], NULL, 10);
    }

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

    if (is_click || is_right) {
        uint32_t btn = is_right ? BTN_RIGHT : BTN_LEFT;
        t = now_ms();
        zwlr_virtual_pointer_v1_button(vp, t, btn, WL_POINTER_BUTTON_STATE_PRESSED);
        zwlr_virtual_pointer_v1_frame(vp);
        t = now_ms();
        zwlr_virtual_pointer_v1_button(vp, t, btn, WL_POINTER_BUTTON_STATE_RELEASED);
        zwlr_virtual_pointer_v1_frame(vp);
    } else if (is_scroll) {
        emit_scroll(vp, WL_POINTER_AXIS_VERTICAL_SCROLL, dy);
        emit_scroll(vp, WL_POINTER_AXIS_HORIZONTAL_SCROLL, dx);
    } else if (is_drag) {
        emit_drag(dpy, vp, x, y, x2, y2, w, h);
    }

    // Flush + roundtrip so the events actually reach the compositor before exit.
    wl_display_flush(dpy);
    wl_display_roundtrip(dpy);

    zwlr_virtual_pointer_v1_destroy(vp);
    wl_display_disconnect(dpy);
    return 0;
}
