import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import LoginCard from "./LoginCard"
import PowerBar from "./PowerBar"
import LocaleBar from "./LocaleBar"
import Clock from "./Clock"
import { getDefaultUser } from "../lib/users"
import { CrystalOverlayManager } from "../../lib/crystal-ui"

function readWallpaperPath(): string | null {
  try {
    const user = getDefaultUser()
    const path = `${user.homeDir}/.config/crystal-shell/wallpaper`
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return null
    const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
    return (cfg.path as string) || null
  } catch {
    return null
  }
}

export default function Greeter(monitor: Gdk.Monitor) {
  const win = new Gtk.ApplicationWindow({
    application: app,
    name: "crystal-greeter",
    css_classes: ["greeter-window"],
  })

  const wallpaperPath = readWallpaperPath()
  const fill: Gtk.Widget = (wallpaperPath && GLib.file_test(wallpaperPath, GLib.FileTest.EXISTS))
    ? (() => {
        const pic = new Gtk.Picture({ hexpand: true, vexpand: true, content_fit: Gtk.ContentFit.COVER })
        pic.set_filename(wallpaperPath)
        return pic
      })()
    : new Gtk.Box({ hexpand: true, vexpand: true, css_classes: ["greeter-backdrop"] })

  // Build overlay first so the manager can be created before child widgets
  const overlay = new Gtk.Overlay()
  overlay.set_child(fill)

  // The manager is the single source of truth for all floating UI in this window
  const manager = new CrystalOverlayManager(overlay)

  const clockWidget = Clock()
  clockWidget.halign = Gtk.Align.CENTER
  clockWidget.valign = Gtk.Align.START
  clockWidget.margin_top = 72

  const loginCard = LoginCard(manager)
  loginCard.halign = Gtk.Align.CENTER
  loginCard.valign = Gtk.Align.CENTER

  const localeBar = LocaleBar(manager)
  localeBar.halign = Gtk.Align.START
  localeBar.valign = Gtk.Align.END
  localeBar.margin_start = 40
  localeBar.margin_bottom = 40

  const powerBar = PowerBar()
  powerBar.halign = Gtk.Align.END
  powerBar.valign = Gtk.Align.END
  powerBar.margin_end = 40
  powerBar.margin_bottom = 40

  overlay.add_overlay(clockWidget)
  overlay.add_overlay(loginCard)
  overlay.add_overlay(localeBar)
  overlay.add_overlay(powerBar)

  win.set_child(overlay)

  try {
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "crystal-greeter")
    Gtk4LayerShell.set_monitor(win, monitor)
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.BOTTOM, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.RIGHT, true)
    Gtk4LayerShell.set_exclusive_zone(win, -1)
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
  } catch (e) {
    console.error("[Greeter] LayerShell failed — falling back to fullscreen:", e)
    win.fullscreen()
  }

  win.present()
  return win
}
