import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import LockCard from "./LockCard"
import PowerBar from "./PowerBar"
import Clock from "./Clock"
import { resolveWallpaper } from "../../lib/wallpaper"

function buildWindow(onUnlock: () => void): Gtk.ApplicationWindow {
  const win = new Gtk.ApplicationWindow({
    application: app,
    css_classes: ["greeter-window"],
  })

  // The lockscreen runs inside the locked user's session, so its own config
  // dir is the right source — never getDefaultUser(), which points at the
  // first /etc/passwd user and reads the wrong home on multi-user machines.
  const wallpaperPath = resolveWallpaper("lockscreen")
  const fill: Gtk.Widget = wallpaperPath
    ? (() => {
        const pic = new Gtk.Picture({ hexpand: true, vexpand: true, content_fit: Gtk.ContentFit.COVER })
        pic.set_filename(wallpaperPath)
        return pic
      })()
    : new Gtk.Box({ hexpand: true, vexpand: true, css_classes: ["greeter-backdrop"] })

  const clockWidget = Clock()
  clockWidget.halign = Gtk.Align.CENTER
  clockWidget.valign = Gtk.Align.START
  clockWidget.margin_top = 72

  const lockCard = LockCard(onUnlock)
  lockCard.halign = Gtk.Align.CENTER
  lockCard.valign = Gtk.Align.CENTER

  const powerBar = PowerBar()
  powerBar.halign = Gtk.Align.CENTER
  powerBar.valign = Gtk.Align.END
  powerBar.margin_bottom = 40

  const overlay = new Gtk.Overlay()
  overlay.set_child(fill)
  overlay.add_overlay(clockWidget)
  overlay.add_overlay(lockCard)
  overlay.add_overlay(powerBar)

  win.set_child(overlay)
  return win
}

// Session-lock protocol variant — assign_window_to_monitor() calls present() internally
export function Lock(lockInstance: any, monitor: Gdk.Monitor) {
  const win = buildWindow(() => lockInstance.unlock())
  lockInstance.assign_window_to_monitor(win, monitor)
  return win
}

// OVERLAY layer fallback
export function LockOverlay(monitor: Gdk.Monitor) {
  const win = buildWindow(() => app.quit())

  try {
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "nidara-lock")
    Gtk4LayerShell.set_monitor(win, monitor)
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    Gtk4LayerShell.set_exclusive_zone(win, -1)
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
  } catch (e) {
    console.error("[Lock] LayerShell failed:", e)
    win.fullscreen()
  }

  win.present()
  return win
}
