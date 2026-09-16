import Gio from "gi://Gio"
import GLib from "gi://GLib"

/**
 * Nidara — the shipped icon set, reachable from the greeter and the lockscreen.
 *
 * The shell resolves these through `core/Icons.ts` against `SHELL_ROOT`. The
 * other two bundles have no `core/`, so they used to fall back to THEME icon
 * names (`system-shutdown-symbolic`, `system-reboot-symbolic`,
 * `media-playback-pause-symbolic`, `input-keyboard-symbolic`) — which means the
 * login and lock screens drew the very same three actions the shell's system
 * menu draws, in whatever art the user's icon theme happened to supply. On a
 * clean Arch install that is Adwaita's, so Nidara's own power bar was the one
 * surface in the DE not using Nidara's icons. Commandment 10.
 *
 * Resolution is the same route `avatar.ts` already uses for the user glyph:
 * the greeter and lockscreen always run from /usr/share (their bin wrappers)
 * and install.sh ships the shell's assets there in both dev and user mode;
 * NIDARA_SHELL_ROOT covers running from a source tree.
 *
 * ⚠️ These ARE symbolic icons since #587 — `<name>-symbolic.svg`, with the
 * symbolic classes on every shape — so GTK recolours them from CSS `color` and
 * nothing inverts them any more. Before that they rendered black and every
 * consumer had to remember the `nd-icon` class, whose `-gtk-icon-filter:
 * invert(1)` then turned a real symbolic icon BLACK as soon as an interface icon
 * theme was set. GTK gates recolouring on the FILENAME, so the suffix is not
 * decoration: drop it and the icon goes black again with no error anywhere.
 */

const SHELL_ROOT = GLib.getenv("NIDARA_SHELL_ROOT") ?? "/usr/share/nidara/ui/shell"
const DIR = `${SHELL_ROOT}/assets/icons/hicolor/scalable/actions`

/**
 * The shipped icon `name`, or `null` when the asset tree is not there.
 *
 * Returning null rather than throwing is deliberate: a missing icon must cost
 * an icon, never the login screen. Callers pair it with the theme name they
 * used before as a last resort — see `ndImage`.
 */
export function ndIcon(name: string): Gio.Icon | null {
    const path = `${DIR}/${name}-symbolic.svg`
    return GLib.file_test(path, GLib.FileTest.EXISTS)
        ? Gio.FileIcon.new(Gio.File.new_for_path(path))
        : null
}

/**
 * The official Nidara symbolic logo icon, recolourable by GTK CSS.
 */
export function nidaraLogoIcon(): Gio.Icon | null {
    const candidates = [
        `${SHELL_ROOT}/assets/nidara/assets/nidara-symbolic.svg`,
        "/usr/share/nidara/ui/shell/assets/nidara/assets/nidara-symbolic.svg",
    ]
    for (const path of candidates) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            return Gio.FileIcon.new(Gio.File.new_for_path(path))
        }
    }
    return null
}

/**
 * Properties for a `Gtk.Image` showing the shipped icon `name`, falling back to
 * the theme icon `themeFallback` when the asset tree is missing.
 *
 * Both branches are now symbolic and both follow CSS `color`, so neither needs a
 * class of its own. The `nd-icon` that used to ride along on the shipped path
 * was there to invert a black drawing; there is no black drawing left to invert.
 */
export function ndImageProps(name: string, themeFallback: string, pixelSize: number) {
    const gicon = ndIcon(name)
    return gicon
        ? { gicon, pixel_size: pixelSize }
        : { icon_name: themeFallback, pixel_size: pixelSize }
}
