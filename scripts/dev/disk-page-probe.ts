// disk-page-probe — what the partition TABLE actually needs, in pixels.
//
//   cd ui/installer && npx --yes sass@1.97.3 --no-charset style.scss style.css && cd ../..
//   ./scripts/bundle.sh scripts/dev/disk-page-probe.ts /tmp/disk-probe && /tmp/disk-probe
//
// ⚠️ It mounts ONE STEP, never the installer — same rule and same reason as
// `region-page-probe.ts`: `InstallerWindow` constructs `RunStep`, and the rule
// that the installer only runs in a VM is a rule about the PROCESS existing on a
// machine somebody is using, not about the disk code being reached.
//
// What it is for, and it is a measurement rather than a look: manual
// partitioning is the first wizard page that is not a single column of cards, so
// it is the page that decides `WINDOW_LAYOUT.wizardContent` (#399). The order of
// work stated in that issue is build the table, measure what it needs, THEN set
// the pane from the measurement — the same way Settings' 800 was arrived at. This
// prints the measurement.
//
// It prints, then opens: the numbers are the deliverable, the window is the
// sanity check that they describe the thing on screen.
//
// ⚠️ A NATURAL width, taken before the window exists. Once the table is inside a
// pane it is allocated whatever the pane has and the columns quietly compress —
// so a measurement taken from a live window (or from `nidara-a11y` bounds) is a
// measurement of the pane, not of the table.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { installAppearance } from "../../ui/lib/appearance-css"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { NidaraWindow, NidaraClamp, NidaraScrolled, NIDARA_WINDOW_RADIUS } from "../../ui/lib/nidara-kit"
import { WINDOW_LAYOUT } from "../../ui/lib/tokens"
import { DiskStep } from "../../ui/installer/steps/disk"
import { setDiskAnswer, getAnswers } from "../../ui/installer/lib/answers"
import { exec } from "../../ui/lib/process"

GLib.setenv("GTK_THEME", "nidara", true)

const here = GLib.get_current_dir()
const css = [`${here}/ui/installer/style.css`, "./ui/installer/style.css", "./style.css"]
  .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))

/**
 * The partitions the seed picks from. A copy of `listPartitions` from the step,
 * deliberately: the step does not export it, and a probe that reached into the
 * module under test would be measuring its own fixture.
 */
function listProbePartitions() {
  const raw = exec(["lsblk", "-J", "-b", "-o", "NAME,PATH,SIZE,FSTYPE,LABEL,TYPE,START,LOG-SEC"])
  const out: Array<{
    name: string; path: string; device: string; start: number; size: number
    logicalSectorSize: number; fstype: string | null; label: string | null
  }> = []
  const walk = (items: any[], parent: any) => {
    for (const item of items ?? []) {
      if (item.type === "part") out.push({
        name: item.name, path: item.path,
        device: parent?.path ?? "",
        // 512-byte units, always — see the note on LSBLK_SECTOR in steps/disk.ts.
        start: (Number(item.start) || 0) * 512,
        size: Number(item.size) || 0,
        logicalSectorSize: Number(item["log-sec"] ?? parent?.["log-sec"]) || 512,
        fstype: item.fstype || null, label: item.label || null,
      })
      if (item.children) walk(item.children, item)
    }
  }
  walk(JSON.parse(raw).blockdevices ?? [], null)
  return out
}

/** Depth-first search for the first widget carrying a CSS class. */
function findByClass(root: Gtk.Widget, cls: string): Gtk.Widget | null {
  if (root.has_css_class(cls)) return root
  let child = root.get_first_child()
  while (child) {
    const hit = findByClass(child, cls)
    if (hit) return hit
    child = child.get_next_sibling()
  }
  return null
}

app.start({
  applicationId: "org.nidara.installer.diskprobe",
  applicationName: "Disk page probe",
  logDomain: "disk-probe",
  css,

  main() {
    applyCrispFontRendering()
    installAppearance()

    // DISK_PROBE_SEED opens the page with manual mode already answered, the way
    // REGION_PROBE_COUNTRY opens the region page with a country. Driving six
    // dropdowns through synthetic clicks to see what a filled-in table looks like
    // is not a test, it is a way to spend an afternoon.
    //
    //   DISK_PROBE_SEED=ok    a layout that installs — / and an ESP
    //   DISK_PROBE_SEED=dupe  two partitions given the same mount point (D-17)
    //   DISK_PROBE_SEED=efi   an ESP about to be formatted as btrfs (#414) — the
    //                         layout that used to install cleanly and not boot
    //   DISK_PROBE_SEED=swap  a swap row: the filesystem cell has no question to
    //                         ask, so it says `swap` and is not a choice (#423)
    const seed = GLib.getenv("DISK_PROBE_SEED")
    if (seed) {
      const parts = listProbePartitions()
      const esp = parts.find(p => p.fstype === "vfat") ?? parts[0]
      const root = parts.filter(p => p !== esp).sort((a, b) => b.size - a.size)[0] ?? parts[0]
      const other = parts.filter(p => p !== esp && p !== root)[0] ?? root
      const mount = (p: typeof parts[0], mountpoint: string, filesystem: any, format: boolean) => ({
        name: p.name, path: p.path, device: p.device, start: p.start, size: p.size,
        logicalSectorSize: p.logicalSectorSize, fsType: p.fstype, label: p.label,
        mountpoint, filesystem, format,
      })
      setDiskAnswer({
        mode: "manual",
        mounts: seed === "dupe"
          ? [mount(root, "/", "btrfs", true), mount(other, "/", "ext4", true)]
          : seed === "efi"
          ? [mount(esp, "/boot/efi", "btrfs", true), mount(root, "/", "btrfs", true)]
          : seed === "swap"
          ? [mount(esp, "/boot/efi", "vfat", false), mount(root, "/", "btrfs", true),
             mount(other, "swap", "btrfs", true)]
          : [mount(esp, "/boot/efi", "vfat", false), mount(root, "/", "btrfs", true)],
      })
    }

    if (seed) {
      const a: any = getAnswers().disk
      console.log("[disk-probe] seeded: " + JSON.stringify(a.mounts.map((m: any) => `${m.path}→${m.mountpoint}`)))
    }

    const step = DiskStep()
    const page = step.build!(() => {})

    // The page has to be in a window before GTK will measure it: a widget with no
    // root has no style context, so every CSS-driven size (the row's min-height,
    // the heading's letter-spacing, the button's padding) is missing from the
    // answer. Measuring here and reporting after `present()` is the difference
    // between a number and a guess.
    const body = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      css_classes: ["installer-body"],
    })
    body.append(page)

    const { widget: scrolledContent } = NidaraScrolled({
      child: NidaraClamp(body, WINDOW_LAYOUT.content, true, WINDOW_LAYOUT.content),
      reserveLane: false,
      hscrollPolicy: Gtk.PolicyType.EXTERNAL,
      propagateNaturalHeight: true,
      cornerRadius: NIDARA_WINDOW_RADIUS,
      cssClasses: ["installer-page-scroll"],
    })

    const shell = NidaraWindow({
      app,
      title: "Disk page probe",
      name: "nidara-installer",
      appId: "nidara-installer",
      cssClasses: ["nidara-installer-window"],
      glassClasses: ["installer-root"],
      content: scrolledContent,
      closeOnEscape: true,
      resizable: true,
    })

    shell.window.connect("map", () => {
      // The stack shows entire-disk mode; the table is built either way, and a
      // widget that is not the visible stack page still measures.
      const header = findByClass(page, "nidara-table-header")
      if (!header) {
        console.log("[disk-probe] no table on the page — did the manual mode change?")
        return
      }
      const table = header.get_parent()!

      const cols: string[] = []
      let cell = header.get_first_child()
      while (cell) {
        const [, nat] = cell.measure(Gtk.Orientation.HORIZONTAL, -1)
        // The heading is in a size group with its column's cells, so what it
        // reports IS the column: the widest of the two.
        cols.push(`${(cell as Gtk.Label).label ?? "?"}=${nat}`)
        cell = cell.get_next_sibling()
      }

      const [tableMin, tableNat] = table.measure(Gtk.Orientation.HORIZONTAL, -1)

      // ⚠️ The NATURAL width is the number, not the minimum. Every cell in this
      // table ellipsises, and an ellipsising label's MINIMUM is the width of the
      // ellipsis — so a table of them reports a minimum of a few dozen pixels and
      // will happily be allocated one. What the columns actually need to be
      // readable is what they ask for when nothing is squeezing them.
      //
      // The page's own natural width is NOT usable for this: the heading and the
      // warning above the table are wrapping labels, whose natural width is the
      // whole paragraph on one line.
      //
      // So the pane is the table plus the page's own horizontal padding, and the
      // padding is measured rather than copied out of the stylesheet — a box with
      // a known child, wearing the same class.
      const ruler = new Gtk.Box({ css_classes: ["installer-body"] })
      ruler.append(new Gtk.Box({ width_request: 100 }))
      body.append(ruler)
      const [, rulerNat] = ruler.measure(Gtk.Orientation.HORIZONTAL, -1)
      const bodyPadding = rulerNat - 100
      body.remove(ruler)

      // ⚠️ The WORST CASE, not the state it opens in. A `Gtk.DropDown`'s button is
      // as wide as its SELECTED item, not as its widest one — so a mount column
      // measured with every row on "None" is a column that grows the moment
      // somebody answers, and a table that grows inside a fixed pane is a table
      // that gets clipped. Select the longest option in the first row and measure
      // again: the pane has to hold THAT.
      // ⚠️ ONLY in measuring mode. Selecting the longest option fires the row's
      // own handlers — the smart format default ticks a checkbox — and putting
      // the selection back does not put THAT back. A window somebody is looking
      // at must show the page, not the page after the probe poked it.
      const firstRow = GLib.getenv("DISK_PROBE_ONCE") === "1"
        ? findByClass(table, "nidara-table-row") : null
      const restore: Array<[Gtk.DropDown, number]> = []
      let widened = ""
      if (firstRow) {
        let c = (firstRow as Gtk.ListBoxRow).get_child()!.get_first_child()
        while (c) {
          if (c instanceof Gtk.DropDown) {
            const model = c.model as Gtk.StringList
            let longest = 0
            for (let i = 0; i < model.get_n_items(); i++)
              if ((model.get_string(i) ?? "").length > (model.get_string(longest) ?? "").length) longest = i
            // ⚠️ Put it back. A probe that leaves the page in the state it needed
            // for one measurement is a probe that lies about every other thing it
            // shows: this cost half an hour of hunting a "bug" where the first
            // row came up mounted at /boot/efi and the page correctly complained
            // about a duplicate the seed had never asked for.
            restore.push([c, c.get_selected()])
            c.set_selected(longest)
          }
          c = c.get_next_sibling()
        }
        const [, wideNat] = table.measure(Gtk.Orientation.HORIZONTAL, -1)
        widened = ` worst-case-nat=${wideNat}`
        for (const [drop, sel] of restore) drop.set_selected(sel)
      }

      console.log(`[disk-probe] columns: ${cols.join("  ")}`)
      console.log(`[disk-probe] table:   min=${tableMin} nat=${tableNat}${widened}`)
      console.log(`[disk-probe] .installer-body horizontal padding: ${bodyPadding}`)
      console.log(`[disk-probe] pane required = ${tableNat} + ${bodyPadding} = ${tableNat + bodyPadding}`)
      console.log(`[disk-probe] wizardContent is ${WINDOW_LAYOUT.wizardContent}`)

      // The pane is ONE constant for every locale (the law in WINDOW_LAYOUT), so
      // the number that matters is the widest locale's, not this machine's:
      //
      //   for l in en_US es_ES fr_FR de_DE it_IT pt_BR pt_PT pl_PL nl_NL ru_RU zh_CN ja_JP; do
      //     LANG=$l.UTF-8 DISK_PROBE_ONCE=1 /tmp/disk-probe 2>&1 | grep 'pane required'
      //   done
      if (GLib.getenv("DISK_PROBE_ONCE") === "1") app.quit()
    })

    // Big enough that the whole page is on screen at once — the probe exists to
    // be LOOKED at, and a window that needs scrolling to show its own table
    // cannot answer "does this read as a table".
    shell.window.default_width = WINDOW_LAYOUT.wizardContent + 60
    shell.window.default_height = 900

    shell.window.connect("destroy", () => app.quit())
    shell.window.present()
  },
})
