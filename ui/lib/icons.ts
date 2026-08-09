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
 * ⚠️ These are Lucide SVGs, not symbolic icons: they render BLACK
 * (stroke=currentColor, non-symbolic) and GTK only recolours a file whose name
 * ends in `-symbolic`. So a consumer MUST add the `nd-icon` class, which
 * inverts them to white — the same mechanism as the shell's `_reset.scss`. An
 * unconditional invert is safe on these two surfaces: both are permanently dark
 * glass, with no light mode to flip to.
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
    const path = `${DIR}/${name}.svg`
    return GLib.file_test(path, GLib.FileTest.EXISTS)
        ? Gio.FileIcon.new(Gio.File.new_for_path(path))
        : null
}

/**
 * Properties for a `Gtk.Image` showing the shipped icon `name`, falling back to
 * the theme icon `themeFallback` when the asset tree is missing.
 *
 * The `nd-icon` class rides along ONLY on the shipped path: the theme fallback
 * is a symbolic icon that already follows the CSS colour, and inverting it
 * would turn it black on black.
 */
export function ndImageProps(name: string, themeFallback: string, pixelSize: number) {
    const gicon = ndIcon(name)
    return gicon
        ? { gicon, pixel_size: pixelSize, css_classes: ["nd-icon"] }
        : { icon_name: themeFallback, pixel_size: pixelSize }
}
