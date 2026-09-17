// icon-registry-probe — where every interface-icon concept actually resolves.
//
// Drives the REAL `ui/shell/core/Icons.ts`, so what it prints is what the shell
// would draw: for each concept, the file the chain ended at, and which link of
// the chain that was — the interface icon theme, or our own shipped drawing.
//
//   gjs -m icon-registry-probe.js
//
// It is the client half of `scripts/dev/icon-registry-probe.sh`, which gives it a
// private GSettings database and a display to look up icons on. Run that, not
// this: without a display `Gtk.IconTheme` has nothing to resolve against, and
// without the private database it would read the live desktop's setting.
//
// Output lines are machine-greppable:
//   THEME <name-or-empty>
//   ICON <name> <theme|shipped> <path>
//   TOTAL <from-theme> <from-shipped>
//   LISTED <theme> …   (what Settings offers: themes declaring the icon spec)

import Gtk from "gi://Gtk?version=4.0"
import { ICON_NAMES, uiIcon, specIconThemes } from "../../ui/shell/core/Icons"

Gtk.init()

const settings = new (imports.gi.Gio.Settings)({ schema_id: "org.nidara.appearance" })
print(`THEME ${settings.get_string("interface-icon-theme")}`)

// The shipped drawings are the ones under the shell's own assets tree; anything
// else came from the interface theme. Comparing paths rather than trusting the
// resolver is the point — this probe exists to catch the resolver being wrong.
const SHIPPED = "/ui/shell/assets/icons/"

let fromTheme = 0, fromShipped = 0
for (const name of ICON_NAMES) {
    const path = uiIcon(name).get_file()?.get_path() ?? ""
    const link = path.includes(SHIPPED) ? "shipped" : "theme"
    if (link === "theme") fromTheme++; else fromShipped++
    print(`ICON ${name} ${link} ${path}`)
}
print(`TOTAL ${fromTheme} ${fromShipped}`)
print(`LISTED ${specIconThemes().join(" ")}`)
