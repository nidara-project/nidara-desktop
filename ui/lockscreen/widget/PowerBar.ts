import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { withGlassCapsule } from "../../lib/glass-capsule"
import { ndImageProps } from "../../lib/icons"
import { t } from "../lib/i18n"

// The three actions the shell's system menu also offers, drawn with the SAME
// shipped art it uses (Icons.moon / rotateCcw / power) instead of whatever the
// user's icon theme supplies — see ui/lib/icons.ts. The theme names stay as a
// last resort for a tree with no shipped assets.
const ACTION_ICONS = {
  suspend:  { name: "moon",       themeFallback: "media-playback-pause-symbolic" },
  restart:  { name: "rotate-ccw", themeFallback: "system-reboot-symbolic" },
  shutdown: { name: "power",      themeFallback: "system-shutdown-symbolic" },
} as const

function PowerButton(icon: { name: string; themeFallback: string }, label: string, action: () => void): Gtk.Button {
  const inner = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
  inner.append(new Gtk.Image(ndImageProps(icon.name, icon.themeFallback, 14)))
  inner.append(new Gtk.Label({ label }))

  const btn = new Gtk.Button({ css_classes: ["greeter-power-btn"], child: inner })
  btn.connect("clicked", action)
  return btn
}

export default function PowerBar(): Gtk.Widget {
  const bar = new Gtk.Box({ spacing: 4, halign: Gtk.Align.CENTER, css_classes: ["greeter-power-bar"] })

  bar.append(PowerButton(ACTION_ICONS.suspend, t("suspend"),
    () => execAsync(["systemctl", "suspend"]).catch(console.error)))
  bar.append(PowerButton(ACTION_ICONS.restart, t("restart"),
    () => execAsync(["systemctl", "reboot"]).catch(console.error)))
  bar.append(PowerButton(ACTION_ICONS.shutdown, t("shutdown"),
    () => execAsync(["systemctl", "poweroff"]).catch(console.error)))

  // The bar's pill is the translucent part (the buttons themselves are accent
  // and opaque), so the backdrop blur goes on the bar, not on each button.
  return withGlassCapsule(bar)
}
