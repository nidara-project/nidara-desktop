import app from "../lib/nidara-kit/platform/host"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
// @ts-ignore
import Gtk4SessionLock from "gi://Gtk4SessionLock"
import { Lock, LockOverlay } from "./widget/Lock"
import { initAppearance } from "../lib/nidara-kit/platform/appearance-css"
import { withKitSheet } from "../lib/nidara-kit/platform/kit-css"
import { applyCrispFontRendering } from "../lib/nidara-kit/platform/font-rendering"
import { useNoGtkTheme } from "../lib/nidara-kit/platform/gtk-theme"

// No GTK theme at all — the greeter's sheet is the only CSS there is (commandment 11).
useNoGtkTheme()

const cssPath = GLib.file_test("/usr/share/nidara/ui/greeter/style.css", GLib.FileTest.EXISTS)
  ? "/usr/share/nidara/ui/greeter/style.css"
  : "../greeter/style.css"


function startFallback(display: Gdk.Display) {
  console.log("[Lock] Starting OVERLAY layer fallback")
  const monitors: any = display.get_monitors()
  const n = monitors.get_n_items()
  for (let i = 0; i < n; i++) {
    try {
      LockOverlay(monitors.get_item(i) as Gdk.Monitor)
    } catch (e) {
      console.error(`[Lock] Overlay fallback failed on monitor ${i}:`, e)
    }
  }
}

app.start({
  applicationId: "org.nidara.lock",
  applicationName: "Nidara Lock Screen",
  logDomain: "nidara-lock",
  css: withKitSheet(cssPath),

  main() {
    // Before any window exists: put glyph baselines on the pixel grid. The lock
    // screen has no ThemeManager, so without this it renders text the shell would not.
    applyCrispFontRendering()

    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Lock] No display"); return }

    // The token ramp, the kit's Cairo seam and the glass rim — read from the Settings
    // portal like any application: the lock runs inside the user's own session, so the
    // portal there answers for exactly the person it is locking. See ui/lib/nidara-kit/platform/appearance.ts.
    // See the greeter's app.ts for why the login screens pin their ink (#612).
    initAppearance({ fixedDarkInk: true })

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
