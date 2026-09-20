// gtk-theme — commandment 11, as one line every bundle calls before its first window.
//
// "We use GTK, with OUR styles. Nothing by default." (Owner, 2026-09-20 —
// tech-debt #107, a standing decision.) A Nidara process loads NO GTK widget
// theme: whatever our stylesheets do not draw is drawn by nothing, which is the
// only arrangement in which "does our CSS own this widget?" has an answer you can
// see rather than infer.
//
// ⚠️ This is about OUR processes only. `GTK_THEME` is an environment variable and
// reaches nothing else; third-party applications keep following gsettings
// `org.gnome.desktop.interface gtk-theme`, a different lever entirely.
//
// ── Why `Empty` and not a blank theme of our own ────────────────────────────
// Until 2026-09-20 this was `GTK_THEME=nidara`, naming a three-line gtk.css we
// installed into `/usr/share/themes/nidara/`. Three things were wrong with it and
// the third is the one that bites:
//
//   1. It was a file to ship, to package, to keep installed and to keep out of
//      every theme list — `ThemeManager` carried three separate guards against our
//      own artefact, because `/usr/share/themes/` is the SHARED namespace and any
//      theme chooser offered it.
//   2. Loading a theme in order to neutralise it is paying twice for having none.
//   3. **A GTK_THEME that names nothing falls back to GTK's built-in Default —
//      silently.** Measured 2026-09-20: `GTK_THEME=NoSuchTheme42` renders
//      pixel-identical to `GTK_THEME=Default`, not to a blank. So every process
//      that missed the install step — the installer on a live medium built without
//      `nidara-desktop`, a `--dev` checkout before `install.sh` reached that line —
//      ran the full default theme while the code said "blank", and nothing said so.
//
// `Empty` is a theme GTK ships INSIDE its own gresource
// (`/org/gtk/libgtk/theme/Empty/gtk.css`, 28 bytes of comment). It cannot be
// missing, it is in nobody's `/usr/share/themes`, and it is what GTK's own test
// suite uses for exactly this purpose. Measured with
// `scripts/dev/kit-gallery-probe.ts`: one of each kit component under `Empty` and
// under the blank theme we used to install differs by **0 pixels of 495 000**.
import GLib from "gi://GLib"

/** The theme name GTK resolves out of its own gresource. Never a path, never a file. */
export const NO_GTK_THEME = "Empty"

/**
 * Select no GTK theme for THIS process. Call it before the first window — the
 * setting is read when GTK builds its style cascade, and a later change means a
 * frame already drawn under something else.
 */
export function useNoGtkTheme(): void {
    GLib.setenv("GTK_THEME", NO_GTK_THEME, true)
}

/**
 * The name GTK's own built-in widget theme answers to — the one in its gresource
 * beside `Empty`, and the honest value for "no custom theme" in gsettings
 * `org.gnome.desktop.interface gtk-theme`.
 *
 * ⚠️ It is NOT `Adwaita`. That was the seed until 2026-09-20 and it named a ghost:
 * a clean Arch has no `/usr/share/themes/Adwaita` at all, GTK 4.22 calls its
 * built-in `Default`, and everything worked only because an unresolvable name
 * falls back to exactly that (measured: `GTK_THEME=NoSuchTheme42` renders
 * pixel-identical to `GTK_THEME=Default`). A value nothing can resolve is also a
 * value no dropdown can offer, which is how Settings came to display a theme that
 * was not among its own options — tech-debt #107, step 2 and step 3 of the same bug.
 *
 * ⚠️ This is the theme for THIRD-PARTY applications. Ours use `NO_GTK_THEME`.
 */
export const GTK_BUILTIN_THEME = "Default"

/**
 * The same thing for GTK3 — and it is a DIFFERENT NAME, which is a dark-mode bug
 * waiting for anyone who assumes otherwise.
 *
 * GTK3's built-in theme is `Adwaita` (`gresource list /usr/lib/libgtk-3.so.0` →
 * `theme/Adwaita/…`), and it is the only name whose dark variant GTK3 can find.
 * Measured 2026-09-20 on a bare GTK3 window with
 * `gtk-application-prefer-dark-theme = 1`:
 *
 *     Adwaita        → bg rgb(53,53,53)     DARK
 *     Default        → bg rgb(246,245,244)  light
 *     NoSuchTheme42  → bg rgb(246,245,244)  light
 *
 * ⚠️ GTK3 does NOT fall back to "the built-in with prefer-dark honoured" — an
 * unresolvable name lands on the LIGHT theme. GTK4 is the forgiving one here.
 *
 * So `gtk-theme-name` is written per toolkit: `core/AppearanceSync.ts` puts this
 * name in `~/.config/gtk-3.0/settings.ini` and `GTK_BUILTIN_THEME` in the gtk-4.0
 * one, whenever the user's choice is "no custom theme". A theme the user actually
 * picked goes to both files unchanged.
 */
export const GTK3_BUILTIN_THEME = "Adwaita"
