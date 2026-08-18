import Gtk from "gi://Gtk?version=4.0"
import { NidaraPowerBar } from "../../lib/power-bar"
import { t, onLocaleChange } from "../lib/i18n"

// The bar itself is shared (ui/lib/power-bar.ts). What the greeter brings is its
// own catalog — and the fact that it can change language while on screen, which
// is the only reason `onLocaleChange` exists in that signature.
export default function PowerBar(): Gtk.Widget {
  return NidaraPowerBar({ t, onLocaleChange })
}
