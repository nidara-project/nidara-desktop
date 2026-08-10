import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { NidaraClock, type RegionSettings } from "../../lib/clock"
import { type DateFormat } from "../../lib/date-names"
import { getPreferredUser } from "../lib/greeter-prefs"
import { onLocaleChange } from "../lib/i18n"

// The greeter's half of the shared clock: WHERE to read region.json, which is a
// privilege question this bundle is the only one that has. Everything the widget
// does with the answer lives in ui/lib/clock.ts.
function readRegionConfig(): RegionSettings {
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

// Returns date + time labels for embedding inside a card (no container box)
export default function Clock(): Gtk.Widget {
  return NidaraClock({ readRegion: readRegionConfig, onLocaleChange })
}
