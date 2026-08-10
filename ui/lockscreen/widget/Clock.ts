import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { NidaraClock, type RegionSettings } from "../../lib/clock"
import { type DateFormat } from "../../lib/date-names"

// The lockscreen's half of the shared clock: it runs AS the user, so its own
// config dir is the answer — no mirror, no other user's home. The greeter's is
// three lines longer for a reason that does not apply here (see ui/lib/clock.ts).
function readRegionConfig(): RegionSettings {
  const fallback = { timeFormat: "24h" as const, showSeconds: false, dateFormat: "long" as DateFormat }
  try {
    const path = `${GLib.get_user_config_dir()}/nidara/region.json`
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return fallback
    const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
    const fmt = (cfg.dateFormat as DateFormat) ?? "long"
    return {
      timeFormat: cfg.timeFormat === "12h" ? "12h" : "24h",
      showSeconds: cfg.showSeconds === true,
      dateFormat: fmt === "none" ? "long" : fmt,
    }
  } catch {
    return fallback
  }
}

// Returns date + time labels for embedding inside a card (no container box)
export default function Clock(): Gtk.Widget {
  return NidaraClock({ readRegion: readRegionConfig })
}
