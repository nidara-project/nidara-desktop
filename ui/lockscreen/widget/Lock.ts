import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import LockCard from "./LockCard"
import PowerBar from "./PowerBar"
import Clock from "./Clock"
import { resolveWallpaper } from "../../lib/wallpaper"
import { setCapsuleBackdrop } from "../../lib/glass-capsule"
import { playExit } from "../../lib/entrance"

// Every monitor's fadeable UI, so the exit covers all of them at once.
const exitTargets: Gtk.Widget[] = []
let unlocking = false

/**
 * Dissolve the lock UI, then unlock.
 *
 * ⚠️ This is a DELAY, not a transition, and that is not a compromise we chose: the
 * moment `unlock()` is called the compositor takes the surface down and the session
 * is there, so there is no window in which a cross-fade could happen. Every system
 * with a pretty unlock IS the compositor. 150ms is priced to read as "password
 * accepted" rather than as waiting.
 *
 * ⚠️ `playExit` guarantees the callback runs even if the frame clock stops. Losing
 * it here would leave the user locked out of their own machine.
 */
function requestUnlock(onUnlock: () => void) {
  if (unlocking) return
  unlocking = true
  playExit(exitTargets, onUnlock, 150)
}

function buildWindow(onUnlock: () => void): Gtk.ApplicationWindow {
  const win = new Gtk.ApplicationWindow({
    application: app,
    // The second class scopes the "capsules are painted, not CSS-drawn"
    // overrides to the lockscreen: the greeter shares this stylesheet but has
    // no painter (it gets compositor blur and keeps the CSS glass).
    css_classes: ["greeter-window", "nidara-lock-window"],
  })

  // The lockscreen runs inside the locked user's session, so its own config
  // dir is the right source — never getDefaultUser(), which points at the
  // first /etc/passwd user and reads the wrong home on multi-user machines.
  const wallpaperPath = resolveWallpaper("lockscreen")
  // Same image the glass elements blur behind themselves — they must show the
  // wallpaper that is actually on screen, not a second one.
  setCapsuleBackdrop(wallpaperPath)
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

  // The exit runs on EVERY monitor, not just the one that took the password, so
  // the fade targets are collected module-wide (`exitTargets`) and `buildWindow`
  // is called once per monitor. Without that, a two-screen setup would dissolve
  // one and hard-cut the other.
  const lockCard = LockCard(() => requestUnlock(onUnlock))
  lockCard.halign = Gtk.Align.CENTER
  lockCard.valign = Gtk.Align.CENTER

  const powerBar = PowerBar()
  powerBar.halign = Gtk.Align.CENTER
  powerBar.valign = Gtk.Align.END
  powerBar.margin_bottom = 40

  const overlay = new Gtk.Overlay()
  overlay.set_child(fill)

  // Wallpaper scrim — the hero text has no glass behind it and vanishes on a
  // light wallpaper. `can_target: false` is load-bearing: a full-size child of a
  // Gtk.Overlay takes input by default, so without it this box would swallow
  // every click meant for the card below.
  const scrim = new Gtk.Box({ hexpand: true, vexpand: true, css_classes: ["greeter-scrim"] })
  scrim.set_can_target(false)
  overlay.add_overlay(scrim)

  overlay.add_overlay(clockWidget)
  overlay.add_overlay(lockCard)
  overlay.add_overlay(powerBar)

  // The UI fades on unlock; the WALLPAPER and the scrim deliberately do not. The
  // lockscreen paints the same image the desktop does — the `surfaces` override in
  // wallpaper.ts is a reserved schema slot that nothing writes and Settings does
  // not expose — so holding it makes the final cut a change of what is ON the
  // wallpaper rather than a change of everything. See ui/lib/entrance.ts for what
  // to revisit if per-surface wallpapers ever ship.
  exitTargets.push(clockWidget, lockCard, powerBar)

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
