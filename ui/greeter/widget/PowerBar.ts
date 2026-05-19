import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { t } from "../lib/i18n"

function PowerButton(icon: string, label: string, action: () => void): Gtk.Button {
  const inner = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
  inner.append(new Gtk.Image({ icon_name: icon, pixel_size: 14 }))
  inner.append(new Gtk.Label({ label }))

  const btn = new Gtk.Button({ css_classes: ["greeter-power-btn"], child: inner })
  btn.connect("clicked", action)
  return btn
}

export default function PowerBar(): Gtk.Widget {
  const bar = new Gtk.Box({ spacing: 4, halign: Gtk.Align.CENTER, css_classes: ["greeter-power-bar"] })

  bar.append(PowerButton("media-playback-pause-symbolic", t("suspend"),
    () => execAsync(["systemctl", "suspend"]).catch(console.error)))
  bar.append(PowerButton("system-reboot-symbolic", t("restart"),
    () => execAsync(["systemctl", "reboot"]).catch(console.error)))
  bar.append(PowerButton("system-shutdown-symbolic", t("shutdown"),
    () => execAsync(["systemctl", "poweroff"]).catch(console.error)))

  return bar
}
