/* titlebar-grade-demo.c — the native window's title bar over content scrolling under it
 * (toolkit/PHASE1.md D7), for deciding its look live with the owner. Not a check.
 *
 * A window whose content (Settings-like rows, a picture, text) scrolls with the wheel under a
 * title bar layer (nidara-layers-v1) with a graded blur (nidara-material-v1 set_shape_grade).
 * Commands, one per line on stdin (or a FIFO: `mkfifo f; demo < f`), apply at once:
 *
 *   curve V0 V1 … Vn   the blur's strength from the window's top to the title bar's bottom,
 *                      n equal bands, each graded linearly from one value to the next
 *                      (Hyalo grades a shape linearly; bands make any curve). Default "1 0".
 *   blur SIZE PASSES   set_blur (default 4 3)
 *   height H           the graded zone's height, logical px (default 52 = the title bar)
 *   fade A             the window background laid over the zone, A at the top to 0 at its
 *                      bottom (painted in the layer's buffer; default 0)
 *   dark 0|1           the window's colours
 *   scroll Y           the content's scroll offset
 *   off / on           the title bar's material removed / back
 *
 *   wayland-scanner client-header/private-code for xdg-shell, nidara-layers-v1 and
 *   nidara-material-v1 into <gen>, then
 *   cc titlebar-grade-demo.c <gen>/*.c -I<gen> $(pkg-config --cflags --libs wayland-client \
 *      pangocairo) -lm -o titlebar-grade-demo
 */
#define _GNU_SOURCE
#include <math.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <cairo.h>
#include <pango/pangocairo.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "nidara-layers-v1-client-protocol.h"
#include "nidara-material-v1-client-protocol.h"

#define W 760
#define H 560
#define CONTENT_H 2200
#define TITLE_H 52

static struct wl_compositor *compositor;
static struct wl_subcompositor *subcompositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static struct wl_seat *seat;
static struct nidara_layers_manager_v1 *layers_mgr;
static struct nidara_material_manager_v1 *material_mgr;
static struct wl_surface *window, *bar;
static struct nidara_material_v1 *material;
static int configured;

static double curve[17] = { 1, 0 };
static int curve_n = 1; /* bands */
static double blur_size = 4;
static int blur_passes = 3;
static int zone_h = TITLE_H;
static double fade;
static int dark;
static double scroll;
static int material_on = 1;

static void global(void *data, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t version) {
    if (strcmp(iface, wl_compositor_interface.name) == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (strcmp(iface, wl_subcompositor_interface.name) == 0)
        subcompositor = wl_registry_bind(reg, name, &wl_subcompositor_interface, 1);
    else if (strcmp(iface, wl_shm_interface.name) == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, xdg_wm_base_interface.name) == 0)
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, wl_seat_interface.name) == 0)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, 5);
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
static void material_ink(void *d, struct nidara_material_v1 *m, uint32_t group, uint32_t dk) {}
static const struct nidara_material_v1_listener material_listener = { material_ink };

static void bg_rgb(double *r, double *g, double *b) {
    if (dark) { *r = 0.118; *g = 0.118; *b = 0.125; } else { *r = 0.965; *g = 0.965; *b = 0.97; }
}
static void ink(cairo_t *cr, double a) {
    if (dark) cairo_set_source_rgba(cr, 1, 1, 1, a); else cairo_set_source_rgba(cr, 0, 0, 0, a);
}

static void text(cairo_t *cr, const char *font, const char *s, double x, double y, int width) {
    PangoLayout *l = pango_cairo_create_layout(cr);
    PangoFontDescription *f = pango_font_description_from_string(font);
    pango_layout_set_font_description(l, f);
    if (width > 0) { pango_layout_set_width(l, width * PANGO_SCALE); pango_layout_set_wrap(l, PANGO_WRAP_WORD); }
    pango_layout_set_text(l, s, -1);
    cairo_move_to(cr, x, y);
    pango_cairo_show_layout(cr, l);
    pango_font_description_free(f);
    g_object_unref(l);
}

static void rounded(cairo_t *cr, double x, double y, double w, double h, double r) {
    cairo_new_sub_path(cr);
    cairo_arc(cr, x + w - r, y + r, r, -M_PI / 2, 0);
    cairo_arc(cr, x + w - r, y + h - r, r, 0, M_PI / 2);
    cairo_arc(cr, x + r, y + h - r, r, M_PI / 2, M_PI);
    cairo_arc(cr, x + r, y + r, r, M_PI, 3 * M_PI / 2);
    cairo_close_path(cr);
}

static const char *LOREM =
    "La transparencia deja ver lo que hay detrás de cada superficie: el fondo de escritorio a "
    "través de la barra, el contenido de una ventana a través de su barra lateral. Cuando el "
    "contenido se desplaza por debajo de la barra de título, se difumina poco a poco hasta "
    "desaparecer, sin una línea que lo corte.";

/* The content at scroll offset `scroll`, the whole window. */
static void draw_content(cairo_t *cr) {
    double r, g, b;
    bg_rgb(&r, &g, &b);
    cairo_set_source_rgb(cr, r, g, b);
    cairo_paint(cr);
    cairo_save(cr);
    cairo_translate(cr, 0, TITLE_H + 12 - scroll);
    static const double icon[][3] = {
        { 0.0, 0.48, 1.0 }, { 0.2, 0.78, 0.35 }, { 1.0, 0.58, 0.0 }, { 1.0, 0.23, 0.19 },
        { 0.69, 0.32, 0.87 }, { 0.35, 0.34, 0.84 }, { 1.0, 0.8, 0.0 }, { 0.19, 0.69, 0.78 },
    };
    static const char *rows[] = {
        "Wi-Fi", "Bluetooth", "Red", "Notificaciones", "Sonido", "Concentración", "Apariencia",
        "Accesibilidad", "Fondo de pantalla", "Pantallas", "Batería", "Teclado", "Ratón",
        "Privacidad y seguridad", "Usuarios", "Fecha y hora",
    };
    double y = 0;
    for (int section = 0; y < CONTENT_H; section++) {
        ink(cr, 0.92);
        text(cr, "Sans Bold 20", section % 2 ? "Pantalla" : "Apariencia", 40, y, 0);
        y += 40;
        if (section % 3 == 1) {
            /* A picture: a wallpaper-like gradient with shapes. */
            cairo_pattern_t *p = cairo_pattern_create_linear(40, y, W - 40, y + 220);
            cairo_pattern_add_color_stop_rgb(p, 0, 0.98, 0.45, 0.2);
            cairo_pattern_add_color_stop_rgb(p, 0.5, 0.85, 0.2, 0.55);
            cairo_pattern_add_color_stop_rgb(p, 1, 0.2, 0.3, 0.85);
            rounded(cr, 40, y, W - 80, 220, 14);
            cairo_set_source(cr, p);
            cairo_fill(cr);
            cairo_pattern_destroy(p);
            cairo_set_source_rgba(cr, 1, 1, 1, 0.85);
            cairo_arc(cr, 200, y + 90, 46, 0, 2 * M_PI);
            cairo_fill(cr);
            cairo_set_source_rgba(cr, 0.05, 0.05, 0.15, 0.7);
            cairo_move_to(cr, 40, y + 220);
            cairo_line_to(cr, 330, y + 120); cairo_line_to(cr, 520, y + 200); cairo_line_to(cr, W - 40, y + 140);
            cairo_line_to(cr, W - 40, y + 220);
            cairo_close_path(cr);
            cairo_fill(cr);
            y += 244;
        }
        /* A group of rows. */
        int n = 5;
        rounded(cr, 40, y, W - 80, n * 44, 12);
        if (dark) cairo_set_source_rgb(cr, 0.17, 0.17, 0.18); else cairo_set_source_rgb(cr, 1, 1, 1);
        cairo_fill(cr);
        for (int i = 0; i < n; i++) {
            int k = (section * n + i) % 16;
            const double *c = icon[k % 8];
            rounded(cr, 54, y + i * 44 + 9, 26, 26, 6);
            cairo_set_source_rgb(cr, c[0], c[1], c[2]);
            cairo_fill(cr);
            ink(cr, 0.88);
            text(cr, "Sans 13", rows[k], 94, y + i * 44 + 12, 0);
            ink(cr, 0.4);
            text(cr, "Sans 13", i % 2 ? "Activado" : "›", W - 120, y + i * 44 + 12, 0);
            if (i < n - 1) {
                ink(cr, 0.08);
                cairo_rectangle(cr, 94, y + i * 44 + 43.5, W - 134, 1);
                cairo_fill(cr);
            }
        }
        y += n * 44 + 20;
        ink(cr, 0.55);
        text(cr, "Sans 12", LOREM, 44, y, W - 88);
        y += 110;
    }
    cairo_restore(cr);
}

/* Each frame's buffers are new: destroyed once the compositor lets them go. */
static void buffer_release(void *d, struct wl_buffer *b) { wl_buffer_destroy(b); }
static const struct wl_buffer_listener buffer_listener = { buffer_release };

static struct wl_buffer *buffer(int w, int h, uint32_t format, void (*paint)(cairo_t *, int, int)) {
    int stride = w * 4, size = stride * h;
    int fd = memfd_create("titlebar-demo", 0);
    if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
    unsigned char *pix = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    cairo_surface_t *s = cairo_image_surface_create_for_data(pix, CAIRO_FORMAT_ARGB32, w, h, stride);
    cairo_t *cr = cairo_create(s);
    paint(cr, w, h);
    cairo_destroy(cr);
    cairo_surface_destroy(s);
    munmap(pix, size);
    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
    struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride, format);
    wl_buffer_add_listener(buf, &buffer_listener, NULL);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buf;
}

static void paint_content(cairo_t *cr, int w, int h) { draw_content(cr); }

/* The title bar's own pixels: the fade, the title, the controls' room left empty. */
static void paint_bar(cairo_t *cr, int w, int h) {
    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
    cairo_paint(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
    if (fade > 0) {
        double r, g, b;
        bg_rgb(&r, &g, &b);
        cairo_pattern_t *p = cairo_pattern_create_linear(0, 0, 0, h);
        cairo_pattern_add_color_stop_rgba(p, 0, r, g, b, fade);
        cairo_pattern_add_color_stop_rgba(p, 1, r, g, b, 0);
        cairo_rectangle(cr, 0, 0, w, h);
        cairo_set_source(cr, p);
        cairo_fill(cr);
        cairo_pattern_destroy(p);
    }
    ink(cr, 0.9);
    text(cr, "Sans Bold 13", "Ajustes", w / 2.0 - 28, (TITLE_H - 18) / 2.0, 0);
}

static void apply_material(void) {
    if (!material) return;
    nidara_material_v1_clear_shapes(material);
    if (!material_on) {
        nidara_material_v1_set_blur(material, 0, 0);
        return;
    }
    nidara_material_v1_set_blur(material, wl_fixed_from_double(blur_size), blur_passes);
    /* Whole pixels per band, the last one taking the remainder: no gap, no overlap. */
    int top = 0;
    for (int i = 0; i < curve_n; i++) {
        int bottom = i == curve_n - 1 ? zone_h : (int)lround((double)zone_h * (i + 1) / curve_n);
        nidara_material_v1_set_shape_grade(material, wl_fixed_from_double(curve[i]), wl_fixed_from_double(curve[i + 1]));
        nidara_material_v1_add_shape(material, 0, wl_fixed_from_int(top), wl_fixed_from_int(W),
                                     wl_fixed_from_int(bottom - top), 0, wl_fixed_from_int(2));
        top = bottom;
    }
}

static void redraw(void) {
    apply_material();
    wl_surface_attach(bar, buffer(W, zone_h, WL_SHM_FORMAT_ARGB8888, paint_bar), 0, 0);
    wl_surface_damage(bar, 0, 0, W, zone_h);
    wl_surface_commit(bar);
    wl_surface_attach(window, buffer(W, H, WL_SHM_FORMAT_XRGB8888, paint_content), 0, 0);
    wl_surface_damage(window, 0, 0, W, H);
    wl_surface_commit(window);
}

static int dirty;
static void pointer_enter(void *d, struct wl_pointer *p, uint32_t s, struct wl_surface *sf, wl_fixed_t x, wl_fixed_t y) {}
static void pointer_leave(void *d, struct wl_pointer *p, uint32_t s, struct wl_surface *sf) {}
static void pointer_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) {}
static void pointer_button(void *d, struct wl_pointer *p, uint32_t s, uint32_t t, uint32_t b, uint32_t st) {}
static void pointer_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t axis, wl_fixed_t v) {
    if (axis != WL_POINTER_AXIS_VERTICAL_SCROLL) return;
    scroll = fmin(fmax(scroll + wl_fixed_to_double(v), 0), CONTENT_H - H + TITLE_H);
    dirty = 1;
}
static void pointer_frame(void *d, struct wl_pointer *p) {}
static void pointer_axis_source(void *d, struct wl_pointer *p, uint32_t s) {}
static void pointer_axis_stop(void *d, struct wl_pointer *p, uint32_t t, uint32_t a) {}
static void pointer_axis_discrete(void *d, struct wl_pointer *p, uint32_t a, int32_t v) {}
static const struct wl_pointer_listener pointer_listener = {
    pointer_enter, pointer_leave, pointer_motion, pointer_button, pointer_axis,
    pointer_frame, pointer_axis_source, pointer_axis_stop, pointer_axis_discrete,
};

static void command(char *line) {
    char *cmd = strtok(line, " \t\n");
    if (!cmd) return;
    if (strcmp(cmd, "curve") == 0) {
        int n = 0;
        for (char *v; n < 17 && (v = strtok(NULL, " \t\n"));) curve[n++] = atof(v);
        if (n >= 2) curve_n = n - 1;
    } else if (strcmp(cmd, "blur") == 0) {
        char *a = strtok(NULL, " \t\n"), *b = strtok(NULL, " \t\n");
        if (a) blur_size = atof(a);
        if (b) blur_passes = atoi(b);
    } else if (strcmp(cmd, "height") == 0) {
        char *a = strtok(NULL, " \t\n");
        if (a && atoi(a) > 0) zone_h = atoi(a);
    } else if (strcmp(cmd, "fade") == 0) {
        char *a = strtok(NULL, " \t\n");
        if (a) fade = atof(a);
    } else if (strcmp(cmd, "dark") == 0) {
        char *a = strtok(NULL, " \t\n");
        if (a) dark = atoi(a);
    } else if (strcmp(cmd, "scroll") == 0) {
        char *a = strtok(NULL, " \t\n");
        if (a) scroll = atof(a);
    } else if (strcmp(cmd, "off") == 0) material_on = 0;
    else if (strcmp(cmd, "on") == 0) material_on = 1;
    else { fprintf(stderr, "unknown: %s\n", cmd); return; }
    dirty = 1;
}

int main(void) {
    struct wl_display *d = wl_display_connect(NULL);
    if (!d) { fprintf(stderr, "no Wayland display\n"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(d);
    wl_registry_add_listener(reg, &registry_listener, NULL);
    wl_display_roundtrip(d);
    if (!layers_mgr || !material_mgr) { fprintf(stderr, "this compositor has no layers/material\n"); return 2; }
    xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    if (seat) wl_pointer_add_listener(wl_seat_get_pointer(seat), &pointer_listener, NULL);

    window = wl_compositor_create_surface(compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm_base, window);
    xdg_surface_add_listener(xs, &xdg_surface_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, "Barra de título — demo");
    xdg_toplevel_set_app_id(top, "titlebar-grade-demo");
    wl_surface_commit(window);
    while (!configured && wl_display_dispatch(d) != -1) {}

    bar = wl_compositor_create_surface(compositor);
    wl_subcompositor_get_subsurface(subcompositor, bar, window);
    struct nidara_layer_v1 *l = nidara_layers_manager_v1_get_layer(layers_mgr, bar);
    nidara_layer_v1_add_listener(l, &layer_listener, NULL);
    nidara_layer_v1_set_position(l, 0, 0);
    material = nidara_material_manager_v1_get_material(material_mgr, bar);
    nidara_material_v1_add_listener(material, &material_listener, NULL);
    xdg_surface_set_window_geometry(xs, 0, 0, W, H);
    redraw();
    printf("READY\n");
    fflush(stdout);

    char line[512];
    size_t used = 0;
    struct pollfd fds[2] = { { wl_display_get_fd(d), POLLIN, 0 }, { 0, POLLIN, 0 } };
    for (;;) {
        wl_display_flush(d);
        if (poll(fds, 2, -1) < 0) break;
        if (fds[0].revents & POLLIN && wl_display_dispatch(d) == -1) break;
        if (fds[1].revents & (POLLIN | POLLHUP)) {
            ssize_t n = read(0, line + used, sizeof line - 1 - used);
            if (n <= 0) fds[1].fd = -1;
            else {
                used += n;
                line[used] = 0;
                char *nl;
                while ((nl = strchr(line, '\n'))) {
                    *nl = 0;
                    command(line);
                    memmove(line, nl + 1, used - (nl + 1 - line) + 1);
                    used -= nl + 1 - line;
                }
            }
        }
        if (dirty) { dirty = 0; redraw(); }
    }
    fprintf(stderr, "disconnected: error %d\n", wl_display_get_error(d));
    return 1;
}
