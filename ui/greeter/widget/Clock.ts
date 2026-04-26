import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { t } from "../lib/i18n"
import { getDefaultUser } from "../lib/users"

function readRegionConfig(): { timeFormat: "24h" | "12h"; showSeconds: boolean } {
  try {
    const user = getDefaultUser()
    const path = `${user.homeDir}/.config/crystal-shell/region.json`
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return { timeFormat: "24h", showSeconds: false }
    const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
    return {
      timeFormat: cfg.timeFormat === "12h" ? "12h" : "24h",
      showSeconds: cfg.showSeconds === true,
    }
  } catch {
    return { timeFormat: "24h", showSeconds: false }
  }
}

const region = readRegionConfig()
const timeFmt = region.timeFormat === "12h"
  ? (region.showSeconds ? "%I:%M:%S %p" : "%I:%M %p")
  : (region.showSeconds ? "%H:%M:%S" : "%H:%M")
const dateFmt = t("dateFormat")

function formatTime(): string {
  return GLib.DateTime.new_now_local().format(timeFmt) ?? ""
}

function formatDate(): string {
  return GLib.DateTime.new_now_local().format(dateFmt) ?? ""
}

export default function Clock(): Gtk.Widget {
  const timeLabel = new Gtk.Label({
    label: formatTime(),
    css_classes: ["greeter-clock"],
  })

  const dateLabel = new Gtk.Label({
    label: formatDate(),
    css_classes: ["greeter-date"],
  })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    timeLabel.label = formatTime()
    return GLib.SOURCE_CONTINUE
  })

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
    dateLabel.label = formatDate()
    return GLib.SOURCE_CONTINUE
  })

  const box = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER,
    spacing: 4,
    css_classes: ["greeter-clock-container"],
  })
  box.append(timeLabel)
  box.append(dateLabel)
  return box
}
