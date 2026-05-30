import app from "ags/gtk4/app"
import { Gdk } from "ags/gtk4"
import GLib from "gi://GLib"
// @ts-ignore
import Gtk4SessionLock from "gi://Gtk4SessionLock"
import { Lock, LockOverlay } from "./widget/Lock"
import { accentCssFor } from "../lib/accent"

// Use our blank theme instead of Adwaita.
GLib.setenv("GTK_THEME", "crystal-shell", true)

const cssPath = GLib.file_test("/usr/share/crystal-shell/ui/greeter/style.css", GLib.FileTest.EXISTS)
  ? "/usr/share/crystal-shell/ui/greeter/style.css"
  : "../greeter/style.css"

function loadAccentCss(): string {
  try {
    const path = `${GLib.get_user_config_dir()}/crystal-shell/appearance.json`
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return ""
    const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
    return accentCssFor(cfg.accent as string | undefined)
  } catch {
    return ""
  }
}

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
  instanceName: "crystal-lock",
  css: cssPath,

  main() {
    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Lock] No display"); return }

    // Accent override: same USER priority but added AFTER base CSS → later wins
    const accentCss = loadAccentCss()
    if (accentCss) app.apply_css(accentCss)

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
