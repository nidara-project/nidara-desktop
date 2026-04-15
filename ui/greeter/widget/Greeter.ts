import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import Clock from "./Clock"
import LoginCard from "./LoginCard"
import PowerBar from "./PowerBar"

export default function Greeter(monitor: Gdk.Monitor) {
  const win = new Gtk.ApplicationWindow({
    application: app,
    name: "crystal-greeter",
    css_classes: ["greeter-window"],
  })

  // ── Layout: Overlay with clock top, card center, power bottom ──────────────
  const fill = new Gtk.Box({ hexpand: true, vexpand: true })

  const clockWidget = Clock()
  clockWidget.halign = Gtk.Align.CENTER
  clockWidget.valign = Gtk.Align.START
  clockWidget.margin_top = 120

  const loginCard = LoginCard()
  loginCard.halign = Gtk.Align.CENTER
  loginCard.valign = Gtk.Align.CENTER
  loginCard.margin_bottom = 40  // slightly above center

  const powerBar = PowerBar()
  powerBar.halign = Gtk.Align.CENTER
  powerBar.valign = Gtk.Align.END
  powerBar.margin_bottom = 40

  const overlay = new Gtk.Overlay()
  overlay.set_child(fill)
  overlay.add_overlay(clockWidget)
  overlay.add_overlay(loginCard)
  overlay.add_overlay(powerBar)

  win.set_child(overlay)

  // ── LayerShell: fullscreen overlay, exclusive keyboard ─────────────────────
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
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
  } catch (e) {
    console.error("[Greeter] LayerShell failed — falling back to fullscreen:", e)
    win.fullscreen()
  }

  win.present()

  // Focus password field after layout settles
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    const card = loginCard as any
    // Walk to find GtkPasswordEntry and focus it
    const findAndFocusPassword = (widget: Gtk.Widget): boolean => {
      if (widget instanceof Gtk.PasswordEntry) {
        widget.grab_focus()
        return true
      }
      let child = widget.get_first_child()
      while (child) {
        if (findAndFocusPassword(child)) return true
        child = child.get_next_sibling()
      }
      return false
    }
    findAndFocusPassword(loginCard)
    return GLib.SOURCE_REMOVE
  })

  return win
}

// GLib needs to be imported for the timeout
import GLib from "gi://GLib"
