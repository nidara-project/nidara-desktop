import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { getPreferredUser } from "../lib/greeter-prefs"
import { formatDatePart } from "../lib/dateNames"

type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

function readRegionConfig(): { timeFormat: "24h" | "12h"; showSeconds: boolean; dateFormat: DateFormat } {
  const fallback = { timeFormat: "24h" as const, showSeconds: false, dateFormat: "long" as DateFormat }
  // Try the last-logged-in user's home first (works if /home/<user> is not
  // 700), then the world-readable mirror RegionConfig writes to
  // /var/tmp/nidara — same pattern as the greeter's appearance.json read in app.ts.
  const candidates = [
    `${getPreferredUser().homeDir}/.config/nidara/region.json`,
    "/var/tmp/nidara/region.json",
  ]
  for (const path of candidates) {
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
      const fmt = (cfg.dateFormat as DateFormat) ?? "long"
      return {
        timeFormat: cfg.timeFormat === "12h" ? "12h" : "24h",
        showSeconds: cfg.showSeconds === true,
        dateFormat: fmt === "none" ? "long" : fmt,
      }
    } catch { /* try next */ }
  }
  return fallback
}

const region = readRegionConfig()
const timeFmt = region.timeFormat === "12h"
  ? (region.showSeconds ? "%I:%M:%S %p" : "%I:%M %p")
  : (region.showSeconds ? "%H:%M:%S" : "%H:%M")

function formatTime(): string {
  return GLib.DateTime.new_now_local().format(timeFmt) ?? ""
}

function formatDate(): string {
  return formatDatePart(region.dateFormat, GLib.DateTime.new_now_local())
}

// Returns date + time labels for embedding inside a card (no container box)
export default function Clock(): Gtk.Widget {
  const dateLabel = new Gtk.Label({
    label: formatDate(),
    css_classes: ["greeter-date"],
    halign: Gtk.Align.CENTER,
    xalign: 0.5,
  })

  const timeLabel = new Gtk.Label({
    label: formatTime(),
    css_classes: ["greeter-clock"],
    halign: Gtk.Align.CENTER,
    xalign: 0.5,
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
    spacing: 0,
  })
  box.append(dateLabel)
  box.append(timeLabel)
  return box
}
