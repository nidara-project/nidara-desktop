/* hyalo-sandbox-probe.c — what a sandboxed client sees, against what a normal one sees.
 *
 * Does what Flatpak does (wp-security-context-v1): opens a listening socket of its own,
 * hands it to the compositor as a security context, connects a SECOND client through it,
 * and compares the globals each connection is offered. The privileged globals must be
 * offered OUTSIDE (that is the control — a probe that never saw them would pass anything)
 * and hidden INSIDE; what an ordinary application needs must still be there inside.
 * hyalo/compositor/src/sandbox.rs is the other side.
 *
 *   cc hyalo-sandbox-probe.c security-context-v1-protocol.c -I<gen> \
 *      $(pkg-config --cflags --libs wayland-client) -o hyalo-sandbox-probe
 *   WAYLAND_DISPLAY=… ./hyalo-sandbox-probe        # exits 1 on any failure
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <wayland-client.h>
#include "security-context-v1-client-protocol.h"

#define MAX_GLOBALS 128

struct seen {
    char *names[MAX_GLOBALS];
    int n;
    struct wp_security_context_manager_v1 *manager;
};

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    struct seen *s = data;
    if (s->n < MAX_GLOBALS) s->names[s->n++] = strdup(iface);
    if (strcmp(iface, wp_security_context_manager_v1_interface.name) == 0 && s->manager == NULL)
        s->manager = wl_registry_bind(reg, name, &wp_security_context_manager_v1_interface, 1);
}
static void global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

static int has(const struct seen *s, const char *iface) {
    for (int i = 0; i < s->n; i++) if (strcmp(s->names[i], iface) == 0) return 1;
    return 0;
}

static void list(struct wl_display *d, struct seen *s) {
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, s);
    wl_display_roundtrip(d);
}

/* What an app must not see from inside a sandbox. */
static const char *hidden[] = {
    "zwlr_virtual_pointer_manager_v1",
    "zwp_virtual_keyboard_manager_v1",
    "ext_foreign_toplevel_list_v1",
    "ext_foreign_toplevel_image_capture_source_manager_v1",
    "ext_image_copy_capture_manager_v1",
    "ext_output_image_capture_source_manager_v1",
    "ext_data_control_manager_v1",
    "zwlr_data_control_manager_v1",
    "zwlr_screencopy_manager_v1",
    "zwlr_layer_shell_v1",
    "hyprland_focus_grab_manager_v1",
    "nidara_material_manager_v1",
    "wp_security_context_manager_v1",
};
/* What it still needs. */
static const char *kept[] = { "wl_compositor", "wl_seat", "wl_output", "xdg_wm_base", "wl_shm", "wl_data_device_manager" };

int main(void) {
    int failures = 0;
    struct wl_display *outside = wl_display_connect(NULL);
    if (!outside) { fprintf(stderr, "FAIL: no compositor\n"); return 1; }
    struct seen out = {0};
    list(outside, &out);
    if (!out.manager) { fprintf(stderr, "FAIL: no wp_security_context_manager_v1 offered\n"); return 1; }

    /* The sandbox's socket, and the pipe whose hang-up tells the compositor to stop listening. */
    const char *dir = getenv("XDG_RUNTIME_DIR");
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    snprintf(addr.sun_path, sizeof addr.sun_path, "%s/hyalo-sandbox-probe-%d", dir ? dir : "/tmp", getpid());
    unlink(addr.sun_path);
    int listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int close_fds[2];
    if (listen_fd < 0 || bind(listen_fd, (struct sockaddr *)&addr, sizeof addr) < 0 || listen(listen_fd, 4) < 0 || pipe2(close_fds, O_CLOEXEC) < 0) {
        perror("FAIL: socket"); return 1;
    }
    struct wp_security_context_v1 *ctx = wp_security_context_manager_v1_create_listener(out.manager, listen_fd, close_fds[0]);
    wp_security_context_v1_set_sandbox_engine(ctx, "org.nidara.probe");
    wp_security_context_v1_set_app_id(ctx, "probe");
    wp_security_context_v1_commit(ctx);
    wl_display_roundtrip(outside);

    struct wl_display *inside = wl_display_connect(addr.sun_path);
    if (!inside) { fprintf(stderr, "FAIL: could not connect through the sandbox's socket\n"); return 1; }
    struct seen in = {0};
    list(inside, &in);

    for (size_t i = 0; i < sizeof hidden / sizeof *hidden; i++) {
        int o = has(&out, hidden[i]), n = has(&in, hidden[i]);
        if (!o) { printf("FAIL  %-54s not offered even outside (control)\n", hidden[i]); failures++; }
        else if (n) { printf("FAIL  %-54s offered INSIDE the sandbox\n", hidden[i]); failures++; }
        else printf("ok    %-54s outside only\n", hidden[i]);
    }
    for (size_t i = 0; i < sizeof kept / sizeof *kept; i++) {
        if (!has(&in, kept[i])) { printf("FAIL  %-54s missing inside the sandbox\n", kept[i]); failures++; }
        else printf("ok    %-54s inside too\n", kept[i]);
    }
    printf("RESULT %d globals outside, %d inside, %d failure(s)\n", out.n, in.n, failures);

    wl_display_disconnect(inside);
    close(close_fds[1]);
    unlink(addr.sun_path);
    wl_display_disconnect(outside);
    return failures ? 1 : 0;
}
