// esbuild shim for `ags/gtk4`, so shared widget code can be bundled and run
// under plain gjs — see scripts/dev/lock-probe.js's PAINTER hook.
//
// `ags/gtk4` is not a package: it is a path the AGS runtime resolves for its own
// bundles (tsconfig maps it to /usr/local/share/ags/js/lib/gtk4). Anything in
// ui/lib/ that a dev tool wants to import therefore has to have it aliased, and
// the module itself is thin — the namespaces with their versions pinned, which
// is the part that matters: importing `gi://Gtk` without `?version=4.0` picks
// whatever GTK the introspection data offers first.
//
//   esbuild <entry>.ts --bundle --format=esm --external:'gi://*' \
//     --alias:ags/gtk4=scripts/dev/ags-gtk4-shim.js --outfile=/tmp/out.js
//
// Only add re-exports here as tools need them: this stands in for the runtime,
// it does not reimplement it.
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"

export { Gtk, Gdk }
