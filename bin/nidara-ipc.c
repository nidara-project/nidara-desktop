// ─────────────────────────────────────────────────────────────────────────────
// nidara-ipc — the shell's command surface, spoken directly.
// Compiled to /usr/bin/nidara-ipc (install.sh §5, PKGBUILD build()).
//
//   nidara-ipc listActions              # discover every command
//   nidara-ipc dumpState                # live shell state as JSON
//   nidara-ipc setConfig dock.autoHide true
//   nidara-ipc toggleAppGrid
//
// This replaces `ags request <cmd>`, which was never a protocol of AGS's own
// invention: it is a D-Bus method call, `Request(as) → s`. By hand, no AGS:
//
//   gdbus call --session --dest org.nidara.Shell
//        --object-path /org/nidara/Shell
//        --method org.nidara.Shell.Request '["dumpState"]'
//
// ── Why C, when every other nidara-* helper is GJS ───────────────────────────
//
// Because this one is on a KEYBIND. `hyprland.lua` binds Super+Space, Super+A and
// five more to a shell command, and that command runs on every press. Measured
// 2026-08-18, per invocation of the cheapest possible request:
//
//     ags request     2.9 ms      gdbus (C)   3.1 ms      GJS client   30 ms
//
// The 27 ms difference is the GJS interpreter starting up, and it is paid before
// the shell hears anything. A first version of this file WAS GJS (~90 lines, and
// much prettier); it went to C the moment that number appeared, because shipping
// it would have made every keybind ten times slower than the `ags request` it
// replaces. The other helpers (nidara-a11y, nidara-act, nidara-click…) stay GJS:
// an agent step already costs hundreds of milliseconds, so 27 ms there is noise.
//
// The precedent for compiling a helper is bin/nidara-input.c, and the toolchain
// is already a dependency of both install paths.
//
// ── One door ─────────────────────────────────────────────────────────────────
//
// It asks `org.nidara.Shell`. Until 2026-09-23 it fell back to AGS's
// `io.Astal.ags`, which the shell also served so that the ~35 consumers could
// migrate one at a time instead of in a flag day; the owner closed that door
// then (tech-debt #76), and a migration rewrote `ags request` in users' own
// keybinds. The list below stays a list so a door can be added without
// reshaping the loop.
//
// Exit codes: 0 on a reply, 1 when no shell answered, 2 on bad usage. The reply
// goes to stdout VERBATIM — the shell returns JSON where it means JSON, so this
// must not reformat, re-quote or re-wrap it, or every caller parsing it breaks.
//
//   cc -O2 bin/nidara-ipc.c $(pkg-config --cflags --libs gio-2.0) -o nidara-ipc
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>

/* Doors in preference order. */
static const struct { const char *name, *path, *iface; } DOORS[] = {
    { "org.nidara.Shell", "/org/nidara/Shell",      "org.nidara.Shell" },
};

/* Long enough for the slowest command (listWindows shells out to hyprctl,
 * screenshot writes a PNG), short enough that a wedged shell cannot hang a
 * keybind forever. */
#define TIMEOUT_MS 15000

/* "Nobody owns that name" is the ordinary shape of "the shell is not running",
 * and it is the ONLY failure worth trying the next door for: anything else came
 * from a shell that did answer, and retrying would run the command twice.
 *
 * Both names, and the first is the one that actually fires: with NO_AUTO_START
 * the bus reports NameHasNoOwner because it never attempts activation.
 * ServiceUnknown is what an activatable name gives, kept for the day this ships
 * a D-Bus service file. */
static gboolean is_unowned(const GError *e)
{
    if (!g_dbus_error_is_remote_error((GError *)e)) return FALSE;
    gchar *remote = g_dbus_error_get_remote_error((GError *)e);
    gboolean unowned = remote && (
        !strcmp(remote, "org.freedesktop.DBus.Error.NameHasNoOwner") ||
        !strcmp(remote, "org.freedesktop.DBus.Error.ServiceUnknown"));
    g_free(remote);
    return unowned;
}

static void usage(FILE *out)
{
    fputs("usage: nidara-ipc <command> [args...]\n"
          "       nidara-ipc listActions     # every command, with its arguments\n", out);
}

int main(int argc, char **argv)
{
    if (argc < 2) { usage(stderr); return 2; }
    if (!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help")) { usage(stdout); return 0; }

    /* `ags request -- <cmd>` was a real idiom in our own call sites (yieldInput,
     * agentPointer): AGS's CLI needed the separator so it would not eat an
     * argument beginning with a dash. This client passes everything after argv[0]
     * through verbatim, so a copied `--` would arrive as the COMMAND NAME and the
     * shell would answer "unknown command". Skip one leading separator rather than
     * fail — someone migrating their own hyprland-user.lua will paste it. */
    int first = 1;
    if (!strcmp(argv[1], "--")) {
        if (argc < 3) { usage(stderr); return 2; }
        first = 2;
    }

    GError *err = NULL;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &err);
    if (!bus) {
        fprintf(stderr, "nidara-ipc: no session bus: %s\n", err->message);
        g_error_free(err);
        return 1;
    }

    /* The command and its arguments, exactly as typed, as a D-Bus string array. */
    GVariantBuilder b;
    g_variant_builder_init(&b, G_VARIANT_TYPE("as"));
    for (int i = first; i < argc; i++) g_variant_builder_add(&b, "s", argv[i]);
    GVariant *args = g_variant_new("(as)", &b);
    /* One floating reference, consumed by the first call_sync. Held across the
     * loop with a ref of our own so the second door can reuse it. */
    g_variant_ref_sink(args);

    char *fault = NULL;
    for (size_t i = 0; i < G_N_ELEMENTS(DOORS); i++) {
        err = NULL;
        GVariant *reply = g_dbus_connection_call_sync(
            bus, DOORS[i].name, DOORS[i].path, DOORS[i].iface, "Request",
            g_variant_ref(args), G_VARIANT_TYPE("(s)"),
            G_DBUS_CALL_FLAGS_NO_AUTO_START, TIMEOUT_MS, NULL, &err);

        if (reply) {
            const gchar *out = NULL;
            g_variant_get(reply, "(&s)", &out);
            /* fwrite, not printf: the payload is arbitrary JSON and must not be
             * read as a format string. The trailing newline matches what every
             * caller's `$(…)` strips. */
            if (out) fwrite(out, 1, strlen(out), stdout);
            fputc('\n', stdout);
            g_variant_unref(reply);
            g_variant_unref(args);
            g_object_unref(bus);
            return 0;
        }

        if (!is_unowned(err)) {
            fault = g_strdup(err->message);
            g_error_free(err);
            break;
        }
        g_error_free(err);
    }

    fprintf(stderr, "nidara-ipc: %s\n", fault ? fault : "no shell is running");
    g_free(fault);
    g_variant_unref(args);
    g_object_unref(bus);
    return 1;
}
