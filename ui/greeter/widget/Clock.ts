import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import { NidaraClock, type RegionSettings } from "../../lib/clock"
import { onLocaleChange } from "../lib/i18n"

// The greeter's half of the shared clock: WHERE to read the clock format, which is a
// privilege question this bundle is the only one that has. Everything the widget
// does with the answer lives in ui/lib/clock.ts.
function readRegionConfig(): RegionSettings {
  const fallback: RegionSettings = { timeFormat: "24h", showSeconds: false }
  // The mirror the shell writes to /var/tmp/nidara (0644) — the only copy a system
  // user outside the session can read. The user's own region.json used to be tried
  // first; the clock format lives in their dconf now (#573), which is not ours to read.
  const candidates = ["/var/tmp/nidara/region.json"]
  for (const path of candidates) {
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
      return {
        timeFormat: cfg.timeFormat === "12h" ? "12h" : "24h",
        showSeconds: cfg.showSeconds === true,
      }
    } catch { /* try next */ }
  }
  return fallback
}

// Returns date + time labels for embedding inside a card (no container box)
export default function Clock(): Gtk.Widget {
  return NidaraClock({ readRegion: readRegionConfig, onLocaleChange })
}
