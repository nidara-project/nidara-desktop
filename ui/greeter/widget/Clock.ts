import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { getDefaultUser } from "../lib/users"

type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

const DAYS_LONG    = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG  = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function readRegionConfig(): { timeFormat: "24h" | "12h"; showSeconds: boolean; dateFormat: DateFormat } {
  try {
    const user = getDefaultUser()
    const path = `${user.homeDir}/.config/crystal-shell/region.json`
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return { timeFormat: "24h", showSeconds: false, dateFormat: "long" }
    const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
    return {
      timeFormat: cfg.timeFormat === "12h" ? "12h" : "24h",
      showSeconds: cfg.showSeconds === true,
      dateFormat: (cfg.dateFormat as DateFormat) ?? "long",
    }
  } catch {
    return { timeFormat: "24h", showSeconds: false, dateFormat: "long" }
  }
}

const region = readRegionConfig()
const timeFmt = region.timeFormat === "12h"
  ? (region.showSeconds ? "%I:%M:%S %p" : "%I:%M %p")
  : (region.showSeconds ? "%H:%M:%S" : "%H:%M")

function formatTime(): string {
  return GLib.DateTime.new_now_local().format(timeFmt) ?? ""
}

function formatDate(): string {
  const now = GLib.DateTime.new_now_local()
  const dow  = now.get_day_of_week()
  const d    = now.get_day_of_month()
  const m    = now.get_month()
  const y    = now.get_year()
  const dd   = String(d).padStart(2, "0")
  const mm   = String(m).padStart(2, "0")
  switch (region.dateFormat) {
    case "none":       return ""
    case "short":      return `${MONTHS_SHORT[m]} ${d}`
    case "short-year": return `${MONTHS_SHORT[m]} ${d}, ${y}`
    case "long":       return `${DAYS_LONG[dow]}, ${MONTHS_LONG[m]} ${d}`
    case "numeric":    return `${mm}/${dd}/${y}`
    case "iso":        return `${y}-${mm}-${dd}`
    default:           return `${DAYS_LONG[dow]}, ${MONTHS_LONG[m]} ${d}`
  }
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
