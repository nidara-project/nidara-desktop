// Nidara Installer — the entry point of the fourth bundle.
//
// This surface exists only on the live medium: it is packaged as
// `nidara-installer`, which nothing but nidara-iso's package list ever names, so
// an installed desktop never carries code that partitions disks. See
// `nidara-iso/INSTALLER.md` for the decision and the shape.
//
// What it is NOT allowed to do is worth stating at the top of the file it would
// be added to: it never partitions, never formats, never pacstraps and never
// writes a bootloader. It collects answers, produces an archinstall config, and
// runs one process as root. Everything that can destroy data lives on the other
// side of that seam, in Arch's own code.

import app from "../lib/host"
import GLib from "gi://GLib"
import { installAppearance } from "../lib/appearance-css"
import { applyCrispFontRendering } from "../lib/font-rendering"
import { InstallerWindow } from "./widget/InstallerWindow"

// Our blank theme instead of Adwaita: with an empty gtk.css at
// /usr/share/themes/nidara/gtk-4.0/gtk.css, this sheet is the only CSS there is.
GLib.setenv("GTK_THEME", "nidara", true)

const cssPath = GLib.file_test("./style.css", GLib.FileTest.EXISTS)
  ? "./style.css"
  : "/usr/share/nidara/ui/installer/style.css"

app.start({
  applicationId: "org.nidara.installer",
  applicationName: "Nidara Installer",
  logDomain: "nidara-installer",
  css: cssPath,

  main() {
    // Before any window exists: glyph baselines on the pixel grid. There is no
    // ThemeManager in this process to do it later.
    applyCrispFontRendering()

    // The installer runs INSIDE a running Nidara and has no opinions of its own:
    // whatever accent, mode and window opacity the user picked while trying the
    // desktop is what this window wears, and it follows them changing it with the
    // installer open. One call — the full token ramp, the kit's Cairo seam and the
    // glass rim, from the portal when it answers and from ThemeManager's mirror
    // file when it does not. See ui/lib/appearance.ts for why both exist.
    installAppearance()

    InstallerWindow().present()
  },
})
