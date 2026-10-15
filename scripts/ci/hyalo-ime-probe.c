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
 *   ./hyalo-ime-probe --cursor  draws a green input-method-v2 popup and prints each
 *                               RECT x y width height (nk-layer-motion-check.py)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <sys/mman.h>
#include <poll.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "input-method-unstable-v2-client-protocol.h"

static struct wl_seat *seat;
static struct zwp_input_method_manager_v2 *manager;
static int active, done_count, committed, hold, scripted, cursor;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct zwp_input_popup_surface_v2 *popup;
static void cursor_rect(void *d, struct zwp_input_popup_surface_v2 *p,
                        int32_t x, int32_t y, int32_t w, int32_t h) {
    printf("RECT %d %d %d %d\n", x, y, w, h); fflush(stdout);
}
static const struct zwp_input_popup_surface_v2_listener popup_listener = { cursor_rect };
static void cursor_popup(struct zwp_input_method_v2 *im) {
    struct wl_surface *s = wl_compositor_create_surface(compositor);
    popup = zwp_input_method_v2_get_input_popup_surface(im, s);
    zwp_input_popup_surface_v2_add_listener(popup, &popup_listener, NULL);
    int size = 100 * 24 * 4;
    int fd = memfd_create("ime-cursor", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) exit(2);
    uint32_t *pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (pixels == MAP_FAILED) exit(2);
    for (int i = 0; i < 100 * 24; i++) pixels[i] = 0xff20e060;
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *buffer = wl_shm_pool_create_buffer(pool, 0, 100, 24, 400, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool); munmap(pixels, size); close(fd);
    wl_surface_attach(s, buffer, 0, 0); wl_surface_damage(s, 0, 0, 100, 24); wl_surface_commit(s);
}
static const char *text;
static struct zwp_input_method_keyboard_grab_v2 *grab;

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_seat_interface.name) == 0 && !seat)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
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
static void im_cause(void *d, struct zwp_input_method_v2 *im, uint32_t cause) {
    if (scripted) { printf("CAUSE %u\n", cause); fflush(stdout); }
}
static void im_content_type(void *d, struct zwp_input_method_v2 *im, uint32_t hint, uint32_t purpose) {}
static void im_done(void *d, struct zwp_input_method_v2 *im) {
    done_count++;
    if (cursor) {
        printf("STATE %d %d\n", active, done_count); fflush(stdout);
        if (active && !popup) cursor_popup(im);
        return;
    }
    if (scripted) { printf("STATE %d %d\n", active, done_count); fflush(stdout); return; }
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
    scripted = argc > 1 && strcmp(argv[1], "--script") == 0;
    cursor = argc > 1 && strcmp(argv[1], "--cursor") == 0;
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
    /* Scripted IME reuses the real server bridge, with the test in charge of
     * timing. Commands are acknowledged only after a protocol roundtrip. */
    if (scripted) {
        char line[4096];
        wl_display_roundtrip(d);
        while (1) {
            wl_display_dispatch_pending(d);
            wl_display_flush(d);
            struct pollfd fds[] = {{wl_display_get_fd(d), POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
            if (poll(fds, 2, -1) < 0) break;
            if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
                if (wl_display_dispatch(d) < 0) break;
            }
            if (fds[1].revents & (POLLHUP | POLLERR)) break;
            if (!(fds[1].revents & POLLIN)) continue;
            if (!fgets(line, sizeof line, stdin)) break;
            line[strcspn(line, "\n")] = 0;
            if (!active) { fprintf(stderr, "no active field\n"); break; }
            if (strncmp(line, "preedit ", 8) == 0) {
                const char *s = line + 8;
                zwp_input_method_v2_set_preedit_string(im, s, strlen(s), strlen(s));
            } else if (strcmp(line, "cancel") == 0) {
                zwp_input_method_v2_set_preedit_string(im, "", 0, 0);
            } else if (strncmp(line, "commit ", 7) == 0) {
                zwp_input_method_v2_commit_string(im, line + 7);
            } else { fprintf(stderr, "bad IME command\n"); break; }
            zwp_input_method_v2_commit(im, done_count);
            wl_display_roundtrip(d);
            printf("SENT %s\n", line); fflush(stdout);
        }
    } else {
        while ((cursor || hold || !committed) && wl_display_dispatch(d) != -1) {}
    }
    wl_display_roundtrip(d);
    return committed ? 0 : 1;
}
