import app from "../lib/host"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
// @ts-ignore
import Gtk4SessionLock from "gi://Gtk4SessionLock"
import { Lock, LockOverlay } from "./widget/Lock"
import { accentCssFor, ACCENT_HEX, type AccentKey } from "../lib/accent"
import { setAccentRim } from "../lib/glass-capsule"
import { applyCrispFontRendering } from "../lib/font-rendering"
import { chooseLoginSkin, applyLoginSkin } from "../lib/login-skin"
import type { Skin } from "../lib/backdrop-skin"

// Use our blank theme instead of Adwaita.
GLib.setenv("GTK_THEME", "nidara", true)

const cssPath = GLib.file_test("/usr/share/nidara/ui/greeter/style.css", GLib.FileTest.EXISTS)
  ? "/usr/share/nidara/ui/greeter/style.css"
  : "../greeter/style.css"

function loadAccentCss(): string {
  try {
    const path = `${GLib.get_user_config_dir()}/nidara/appearance.json`
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return ""
    const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
    // The capsules are painted, not CSS-drawn, so the painter needs the accent
    // as a value — it cannot read a CSS custom property (see GlassBackdrop.ts).
    setAccentRim(ACCENT_HEX[cfg.accent as AccentKey] ?? ACCENT_HEX.blue)
    return accentCssFor(cfg.accent as string | undefined)
  } catch {
    return ""
  }
}

// The skin both window paths dress themselves in — decided ONCE, for the whole lock.
//
// One screen, one skin: the alternative is per-monitor, and two monitors showing the
// same lock in opposite tones is not "adaptive", it is broken. It is also what the
// painter already assumes — `setGlassSkin` is process-global because there is one
// painter — so a per-window decision would give the LAST window's answer to all of
// them, which is worse than deciding on purpose.
let lockSkin: Skin = "dark"

function startFallback(display: Gdk.Display) {
  console.log("[Lock] Starting OVERLAY layer fallback")
  const monitors: any = display.get_monitors()
  const n = monitors.get_n_items()
  for (let i = 0; i < n; i++) {
    try {
      applyLoginSkin(LockOverlay(monitors.get_item(i) as Gdk.Monitor), lockSkin)
    } catch (e) {
      console.error(`[Lock] Overlay fallback failed on monitor ${i}:`, e)
    }
  }
}

app.start({
  applicationId: "org.nidara.lock",
  applicationName: "Nidara Lock Screen",
  logDomain: "nidara-lock",
  css: cssPath,

  main() {
    // Before any window exists: put glyph baselines on the pixel grid. The lock
    // screen has no ThemeManager, so without this it renders text the shell would not.
    applyCrispFontRendering()

    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Lock] No display"); return }

    // Accent override: same USER priority but added AFTER base CSS → later wins
    const accentCss = loadAccentCss()
    if (accentCss) app.apply_css(accentCss)

    // Which skin does this wallpaper want? (tech-debt #82 — see ui/lib/backdrop-skin.ts.)
    // Decided here, before any window exists, because both paths below create windows
    // and the fallback creates one per monitor.
    //
    // ⚠️ The lock is the one surface that MUST measure the image rather than trust the
    // compositor: under ext-session-lock-v1 nothing of the desktop is drawn behind it,
    // so it paints its own copy of the wallpaper (glass-capsule's backdrop). What is
    // behind the glass here is exactly the file this reads — no window, no blur it did
    // not apply itself.
    //
    // ⚠️ AND IT CANNOT BE ALLOWED TO FAIL THE LOCK. This runs before `lock()`, so an
    // exception here — a missing GdkPixbuf typelib, a wallpaper that is not an image —
    // would propagate out of main() and the screen would simply NOT LOCK. A legibility
    // choice must never hold a veto over the cerrojo. `chooseLoginSkin` already answers
    // "dark" for anything it cannot read; this catches the class of failure it cannot,
    // and lands on the same answer, which is the skin both screens have always worn.
    try {
      const primary: any = display.get_monitors().get_item(0)
      const geo = primary?.get_geometry?.()
      const aspect = geo && geo.height > 0 ? geo.width / geo.height : 16 / 9
      const { skin, worst, path } = chooseLoginSkin("lockscreen", aspect)
      lockSkin = skin
      console.log(`[Lock] skin=${skin} (worst text contrast ${worst.toFixed(2)}:1) from ${path ?? "no wallpaper"}`)
    } catch (e) {
      console.warn(`[Lock] skin measurement failed, staying dark: ${e}`)
    }

    try {
      const supported = Gtk4SessionLock.is_supported()
      console.log(`[Lock] ext-session-lock-v1 supported: ${supported}`)

      if (!supported) {
        startFallback(display)
        return
      }

      const lockInst = new Gtk4SessionLock.Instance()
      const lockWindows: any[] = []
      console.log("[Lock] Instance created, calling lock()")

      lockInst.connect("locked", () => {
        console.log("[Lock] Session locked successfully")
      })

      lockInst.connect("monitor", (_: any, monitor: Gdk.Monitor) => {
        console.log("[Lock] monitor signal — assigning window")
        try {
          const win = Lock(lockInst, monitor)
          applyLoginSkin(win, lockSkin)
          lockWindows.push(win)
          console.log("[Lock] Window assigned to monitor")
        } catch (e) {
          console.error("[Lock] assign_window_to_monitor failed:", e)
        }
      })

      lockInst.connect("unlocked", () => {
        console.log("[Lock] Session unlocked — destroying windows")
        for (const w of lockWindows) {
          try { w.destroy() } catch (e) { console.warn("[Lock] destroy:", e) }
        }
        lockWindows.length = 0
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          console.log("[Lock] Quitting")
          app.quit()
          return GLib.SOURCE_REMOVE
        })
      })

      lockInst.connect("failed", () => {
        console.error("[Lock] Session lock failed — falling back to overlay")
        startFallback(display)
      })

      lockInst.lock()
      console.log("[Lock] lock() called")

    } catch (e) {
      console.error("[Lock] Session lock init error:", e)
      startFallback(display)
    }
  },
})
