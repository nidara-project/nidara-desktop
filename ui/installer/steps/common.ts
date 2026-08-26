// Common helpers for installer step pages.
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"

export function heading(text: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: ["installer-heading"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
  })
}

export function prose(text: string, extraClass?: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: extraClass ? ["installer-prose", extraClass] : ["installer-prose"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
    wrap: true,
    wrap_mode: Pango.WrapMode.WORD_CHAR,
  })
}
