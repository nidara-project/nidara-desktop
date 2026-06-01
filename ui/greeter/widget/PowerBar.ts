import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { t, onLocaleChange, type StringKey } from "../lib/i18n"

function PowerButton(icon: string, key: StringKey, action: () => void): Gtk.Button {
  const label = new Gtk.Label({ label: t(key) })
  const inner = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
  inner.append(new Gtk.Image({ icon_name: icon, pixel_size: 14 }))
  inner.append(label)

  const btn = new Gtk.Button({ css_classes: ["greeter-power-btn"], child: inner })
  btn.connect("clicked", action)
  onLocaleChange(() => { label.label = t(key) })
  return btn
}

export default function PowerBar(): Gtk.Widget {
  const bar = new Gtk.Box({ spacing: 4, halign: Gtk.Align.CENTER, css_classes: ["greeter-power-bar"] })

  bar.append(PowerButton("media-playback-pause-symbolic", "suspend",
    () => execAsync(["systemctl", "suspend"]).catch(console.error)))
  bar.append(PowerButton("system-reboot-symbolic", "restart",
    () => execAsync(["systemctl", "reboot"]).catch(console.error)))
  bar.append(PowerButton("system-shutdown-symbolic", "shutdown",
    () => execAsync(["systemctl", "poweroff"]).catch(console.error)))

  return bar
}
