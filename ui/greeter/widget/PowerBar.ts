import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { withGlassCapsule } from "../../lib/glass-capsule"
import { ndImageProps } from "../../lib/icons"
import { t, onLocaleChange, type StringKey } from "../lib/i18n"

// The three actions the shell's system menu also offers, drawn with the SAME
// shipped art it uses (Icons.moon / rotateCcw / power) instead of whatever the
// user's icon theme supplies — see ui/lib/icons.ts. The theme names stay as a
// last resort for a tree with no shipped assets.
const ACTION_ICONS = {
  suspend:  { name: "moon",       themeFallback: "media-playback-pause-symbolic" },
  restart:  { name: "rotate-ccw", themeFallback: "system-reboot-symbolic" },
  shutdown: { name: "power",      themeFallback: "system-shutdown-symbolic" },
} as const

function PowerButton(icon: { name: string; themeFallback: string }, key: StringKey, action: () => void): Gtk.Button {
  const label = new Gtk.Label({ label: t(key) })
  const inner = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
  inner.append(new Gtk.Image(ndImageProps(icon.name, icon.themeFallback, 14)))
  inner.append(label)

  const btn = new Gtk.Button({ css_classes: ["greeter-power-btn"], child: inner })
  btn.connect("clicked", action)
  onLocaleChange(() => { label.label = t(key) })
  return btn
}

export default function PowerBar(): Gtk.Widget {
  const bar = new Gtk.Box({ spacing: 4, halign: Gtk.Align.CENTER, css_classes: ["greeter-power-bar"] })

  bar.append(PowerButton(ACTION_ICONS.suspend, "suspend",
    () => execAsync(["systemctl", "suspend"]).catch(console.error)))
  bar.append(PowerButton(ACTION_ICONS.restart, "restart",
    () => execAsync(["systemctl", "reboot"]).catch(console.error)))
  bar.append(PowerButton(ACTION_ICONS.shutdown, "shutdown",
    () => execAsync(["systemctl", "poweroff"]).catch(console.error)))

  // The bar's pill is the translucent surface; the buttons are only their
  // content until you touch them. Wrapped WITHOUT followFocus on purpose: a
  // container reports FOCUS_WITHIN whenever any child has focus, which would
  // paint the whole bar accent when what is focused is one button inside it.
  return withGlassCapsule(bar)
}
