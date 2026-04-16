import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

function formatTime(): string {
  return GLib.DateTime.new_now_local().format("%H:%M") ?? ""
}

function formatDate(): string {
  return GLib.DateTime.new_now_local().format("%A, %d de %B") ?? ""
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

  // Update clock every second
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    timeLabel.label = formatTime()
    return GLib.SOURCE_CONTINUE
  })

  // Update date every minute
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
