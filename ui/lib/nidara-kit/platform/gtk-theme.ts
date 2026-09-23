// SPDX-License-Identifier: LGPL-3.0-or-later
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
 * The value we store in gsettings `org.gnome.desktop.interface gtk-theme` when the
 * user has chosen no custom theme — the name THIRD-PARTY applications are told.
 * Ours use `NO_GTK_THEME` and are not affected by it at all.
 *
 * ⚠️ It has to satisfy TWO toolkits, and they do not agree. This value has now been
 * wrong in both directions inside a week, so the measurements are here:
 *
 *   · GTK4's built-in is called `Default` (`gresource list libgtk-4.so.1` →
 *     theme/Default/gtk.css), and an unresolvable name falls back to it SILENTLY.
 *     So for GTK4 the two names are interchangeable — measured through the real
 *     settings.ini path, `Adwaita` and `Default` render **0 differing pixels**.
 *   · GTK3's built-in is called `Adwaita` (`libgtk-3.so.0` → theme/Adwaita/…), and
 *     it is the ONLY name whose dark variant GTK3 can find. GTK3 does not fall back
 *     to "the built-in with prefer-dark honoured" — an unresolvable name lands on
 *     the LIGHT theme. Measured with `gtk-application-prefer-dark-theme = 1`:
 *     `Adwaita` → bg rgb(53,53,53) DARK; `Default`, `nidara` and `NoSuchTheme42` →
 *     rgb(246,245,244) light.
 *
 * So `Adwaita` is free for GTK4 and load-bearing for GTK3, and one name serves both.
 *
 * ⚠️ It was `Default` for one day (tech-debt #107 step 2), on the reasoning that
 * `Adwaita` "named a ghost" because no `/usr/share/themes/Adwaita` exists. That
 * reasoning was GTK4-only: a name GTK4 cannot resolve is a harmless fallback, while
 * the SAME name is GTK3's real built-in. The owner found the symptom the same week —
 * GTK3 apps, Chrome and Telegram all going light on selecting the theme, because all
 * three ask GTK for the theme NAME and derive dark from it.
 *
 * ⚠️ And the fix belongs HERE, at the value, not in `settings.ini`. The Settings
 * portal SERVES this key (`gdbus … Settings.Read "org.gnome.desktop.interface"
 * "gtk-theme"` answers with it), so a Wayland application reads it straight from
 * gsettings and never consults the per-toolkit file. A mapping applied while writing
 * `~/.config/gtk-3.0/settings.ini` is therefore bypassed by every app in a Wayland
 * session — which was the first attempt at this fix, and it changed nothing on screen.
 */
export const GTK_BUILTIN_THEME = "Adwaita"
