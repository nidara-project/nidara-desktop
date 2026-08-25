import app from "../lib/host"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Greeter from "./widget/Greeter"
import { getPreferredUser } from "./lib/greeter-prefs"
import { initProcessLocale } from "./lib/i18n"
import { accentCssFor, ACCENT_HEX, type AccentKey } from "../lib/accent"
import { setAccentRim } from "../lib/glass-capsule"
import { applyCrispFontRendering } from "../lib/font-rendering"
import { chooseLoginSkin, applyLoginSkin } from "../lib/login-skin"

// Use our blank theme instead of Adwaita.
// With an empty gtk.css at /usr/share/themes/nidara/gtk-4.0/gtk.css,
// GTK4 loads zero theme rules — our app CSS is the only CSS that applies.
GLib.setenv("GTK_THEME", "nidara", true)

const cssPath = GLib.file_test("./style.css", GLib.FileTest.EXISTS)
  ? "./style.css"
  : "/usr/share/nidara/ui/greeter/style.css"

function readAppearanceJson(): Record<string, unknown> | null {
  // Try the last-logged-in user's home dir first (works if /home/<user> is not
  // 700). Fall back to /var/tmp/nidara/appearance.json — written by ThemeManager
  // as a world-readable mirror so the greeter (system user) can always read it.
  const candidates: string[] = [
    `${getPreferredUser().homeDir}/.config/nidara/appearance.json`,
    "/var/tmp/nidara/appearance.json",
  ]
  for (const path of candidates) {
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      return JSON.parse(new TextDecoder().decode(data as Uint8Array))
    } catch { /* try next */ }
  }
  return null
}

function loadAccentCss(): string {
  try {
    const cfg = readAppearanceJson()
    // ⚠️ THE PAINTED RIM NEEDS THE ACCENT AS A VALUE, not as a CSS custom property —
    // the capsules are drawn in Cairo and cannot read one. The lockscreen's copy of
    // this function has always done this; the greeter's did not, so its focus ring was
    // hardcoded `#0088ff` (the `accentRim` default) no matter what accent the user
    // picked, while every CSS-driven accent on the same screen followed them. Two
    // functions with the same name, the same input and the same job, one line apart in
    // behaviour — which is the shape this repo keeps finding under "the greeter and the
    // lockscreen duplicate code" (tech-debt #60).
    setAccentRim(ACCENT_HEX[cfg?.accent as AccentKey] ?? ACCENT_HEX.blue)
    return accentCssFor(cfg?.accent as string | undefined)
  } catch {
    return ""
  }
}

app.start({
  applicationId: "org.nidara.greeter",
  applicationName: "Nidara Greeter",
  logDomain: "nidara-greeter",
  css: cssPath,

  main() {
    // First thing after GTK init (which resets the locale to "C" — empty
    // greetd env): align the process locale with the greeter's language, so
    // the clock's date names AND Pango's CJK face selection are right from
    // the first frame. See lib/i18n.ts initProcessLocale().
    initProcessLocale()

    // Before any window exists: put glyph baselines on the pixel grid. The greeter
    // has no ThemeManager, so without this it renders text the shell would not.
    applyCrispFontRendering()

    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Greeter] No display"); return }

    const accentCss = loadAccentCss()
    if (accentCss) {
      // load_from_string with the same USER priority, but added AFTER the base CSS
      // → same priority + later order = wins in GTK4 cascade
      app.apply_css(accentCss)
    }

    // Login UI on the primary monitor only. The other outputs already show the
    // generic wallpaper painted by awww in the compositor (it covers all
    // outputs), so a per-monitor greeter window would only duplicate the
    // password field and race for keyboard focus.
    const monitors: any = display.get_monitors()
    if (monitors.get_n_items() === 0) { console.error("[Greeter] No monitors"); return }
    try {
      const monitor = monitors.get_item(0) as Gdk.Monitor
      const win = Greeter(monitor)

      // Which skin does this wallpaper want? (tech-debt #82 — see ui/lib/backdrop-skin.ts.)
      // Measured from the wallpaper this screen is about to be painted over, because
      // that is the ONLY thing that can be behind it: no window can sit under the
      // greeter. It is the one surface where the answer is not a guess.
      //
      // The monitor's own aspect, not the window's: the wallpaper is painted COVER-fit
      // by awww across the whole output, and the parts cropped away are not on the
      // screen to be read over.
      //
      // ⚠️ Its own try, INSIDE the one that already wraps the window. The catch below
      // reports "failed on primary monitor", which is true of a greeter that never
      // appeared and false — and alarming — for one that merely could not measure a
      // JPEG. A legibility choice must not be able to look like a login screen that
      // did not come up; it degrades to the skin this screen has always worn.
      try {
        const geo = monitor.get_geometry()
        const { skin, worst, path } = chooseLoginSkin(
          "greeter",
          geo.height > 0 ? geo.width / geo.height : 16 / 9,
          getPreferredUser().homeDir,
        )
        applyLoginSkin(win, skin)
        // Logged, and this is the line to read when someone reports the login screen
        // "changed colour": it names the wallpaper that decided and what the decision
        // bought. A skin chosen silently is a skin nobody can argue with.
        console.log(`[Greeter] skin=${skin} (worst text contrast ${worst.toFixed(2)}:1) from ${path ?? "no wallpaper"}`)
      } catch (e) {
        console.warn(`[Greeter] skin measurement failed, staying dark: ${e}`)
      }
    } catch (e) {
      console.error("[Greeter] Failed on primary monitor:", e)
    }
  },
})
