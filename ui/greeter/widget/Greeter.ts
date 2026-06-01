import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import LoginCard from "./LoginCard"
import PowerBar from "./PowerBar"
import LocaleBar from "./LocaleBar"
import Clock from "./Clock"

export default function Greeter(monitor: Gdk.Monitor) {
  const win = new Gtk.ApplicationWindow({
    application: app,
    name: "crystal-greeter",
    css_classes: ["greeter-window"],
  })

  // Fully-transparent backdrop. The generic login wallpaper is painted by awww
  // in the compositor (see hyprland-greeter.lua); it shows through crisp because
  // the crystal-greeter layer_rule uses ignore_alpha, so blur frosts only the
  // semi-transparent widgets (card, password, buttons), never the background.
  const fill = new Gtk.Box({ hexpand: true, vexpand: true, css_classes: ["greeter-backdrop"] })

  const overlay = new Gtk.Overlay()
  overlay.set_child(fill)

  const clockWidget = Clock()
  clockWidget.halign = Gtk.Align.CENTER
  clockWidget.valign = Gtk.Align.START
  clockWidget.margin_top = 72

  const loginCard = LoginCard()
  loginCard.halign = Gtk.Align.CENTER
  loginCard.valign = Gtk.Align.CENTER

  const localeBar = LocaleBar()
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
