import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import { NidaraClock, type RegionSettings } from "../../lib/clock"
import { type DateFormat } from "../../lib/date-names"

// The lockscreen's half of the shared clock: it runs AS the user, in the session,
// so it reads the clock format from its home — GSettings `org.nidara.region` (#573).
// No mirror, no other user's home. The greeter's is different for a reason that
// does not apply here (see ui/lib/clock.ts). A missing schema (a broken install)
// paints the fallback instead of throwing: `new Gio.Settings` on one would.
function readRegionConfig(): RegionSettings {
  const fallback = { timeFormat: "24h" as const, showSeconds: false, dateFormat: "long" as DateFormat }
  try {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup("org.nidara.region", true)
    if (!schema) return fallback
    const settings = new Gio.Settings({ settings_schema: schema })
    const fmt = settings.get_string("date-format") as DateFormat
    return {
      timeFormat: settings.get_string("time-format") === "12h" ? "12h" : "24h",
      showSeconds: settings.get_boolean("show-seconds"),
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
