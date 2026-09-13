// consent-dialog-probe — the REAL consent prompt, in a nested Hyprland.
//
// Driven by scripts/dev/consent-dialog-probe.sh, which owns the isolation. This
// process stands in for the shell: it runs ui/shell/surfaces/consent/ConsentService.ts
// unchanged, takes `org.nidara.Shell` on the private bus, and opens one plain window —
// "the app that is asking" — whose exported xdg-foreign handle it writes to ARGV[0], so
// the driver can pass it to the portal backend as `parent_window`.

import app from "../../ui/lib/host"
import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import "gi://GdkWayland?version=4.0"
import { initAppearance } from "../../ui/lib/appearance-css"
import { exportConsentService } from "../../ui/shell/surfaces/consent/ConsentService"

const argv: string[] = (globalThis as any).ARGV ?? []
const handleFile = argv[0]
const cssPath = argv[1]

app.start({
  applicationId: "org.nidara.ConsentProbe",
  logDomain: "consent-probe",
  css: cssPath,
  main() {
    initAppearance()
    Gio.bus_own_name(Gio.BusType.SESSION, "org.nidara.Shell", Gio.BusNameOwnerFlags.NONE, null, null, null)
    exportConsentService()

    const win = new Gtk.Window({ title: "Requesting app", default_width: 1100, default_height: 700 })
    win.set_child(new Gtk.Label({ label: "The app that is asking" }))
    win.connect("map", () => {
      const surface = win.get_surface() as any
      surface.export_handle((_top: any, handle: string) => {
        GLib.file_set_contents(handleFile, handle)
        print(`EXPORTED ${handle}`)
      })
    })
    win.present()
  },
})
