import { Gtk } from "ags/gtk4"
import { NidaraPowerBar } from "../../lib/power-bar"
import { t } from "../lib/i18n"

// No `onLocaleChange`: the lockscreen has no language picker, so its catalog is
// resolved once and never changes under it. That single fact is what every
// difference between this and the greeter's copy came down to.
export default function PowerBar(): Gtk.Widget {
  return NidaraPowerBar({ t })
}
