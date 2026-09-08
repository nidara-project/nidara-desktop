// dropdown-a11y-probe — can a `Gtk.DropDown` in a table cell be given a name?
//
//   cd ui/installer && npx --yes sass@1.97.3 --no-charset style.scss style.css && cd ../..
//   ./scripts/bundle.sh scripts/dev/dropdown-a11y-probe.ts /tmp/dropdown-probe && /tmp/dropdown-probe
//   # then, from another shell, with the window open:
//   nidara-a11y dropdown-a11y-probe
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
// A control in a table cell has no visible label of its own: the column heading
// is the label, and a heading is not in the row's accessibility tree. The
// installer names its cell controls with `update_property([LABEL], …)`, and on a
// `Gtk.DropDown` that call does nothing — GTK reports the SELECTED ITEM as the
// accessible name instead, so a column of mount-point dropdowns reads as
// `Ninguno`, `Ninguno`, `Ninguno`, never saying which partition each belongs to
// (measured 2026-09-03, written into `steps/disk.ts`; #465).
//
// This is the instrument for the fix. It builds one dropdown per naming strategy
// and one CHECK BOX carrying the same LABEL — the control the same call DOES
// stick on, which is what makes the comparison a measurement rather than an
// observation about dropdowns in general.
//
// ─── WHAT IT MEASURED (2026-09-06, AT-SPI, this machine) ─────────────────────
//
//     what was set                 name                  description
//     nothing                      "None"                ""
//     LABEL                        "None"                ""     ← swallowed whole
//     DESCRIPTION                  "None"                "Mount point — /dev/sda2"
//     LABEL + DESCRIPTION          "None"                "Mount point — /dev/sda3"
//     LABELLED_BY (not expressible) "None"               ""
//     LABEL, on a CheckButton      "Format — /dev/sda1"  ""     ← the control
//
// The name stays the selected value in every case, which is the right thing for
// it to be. What was missing was WHICH control it belongs to — a description.
// `NidaraDropDown({ accessibleDescription })` is that, and `nidara-a11y` reports
// the field now, so re-running the two commands above shows the fix rather than
// requiring a second reader.
//
// ⚠️ It has to be read from OUTSIDE. GTK4 exposes no getter for a widget's
// computed accessible name: `update_property` is write-only, and what an assistive
// technology ends up hearing is decided in the AT-SPI bridge, not in the widget.
// So the answer comes from `nidara-a11y` (or Accerciser) reading the running
// process — a probe that asked GTK what it had just told GTK would prove nothing.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { installAppearance } from "../../ui/lib/appearance-css"
import { NidaraWindow, NidaraDropDown } from "../../ui/lib/nidara-kit"

GLib.setenv("GTK_THEME", "nidara", true)

const MOUNTS = ["None", "/", "/boot", "/home", "swap"]

app.start({
  applicationId: "org.nidara.dropdowna11yprobe",
  applicationName: "dropdown-a11y-probe",
  logDomain: "dropdown-a11y",

  main() {
    installAppearance()

    const body = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 12,
      margin_top: 20, margin_bottom: 20, margin_start: 20, margin_end: 20,
    })

    /** One row: what we did to it, and the control we did it to. */
    const case_ = (what: string, widget: Gtk.Widget) => {
      const line = new Gtk.Box({ spacing: 12 })
      line.append(new Gtk.Label({ label: what, xalign: 0, width_request: 320 }))
      line.append(widget)
      body.append(line)
    }

    const model = () => Gtk.StringList.new(MOUNTS)

    // 1 — the state the installer's table is in today.
    const bare = NidaraDropDown({ model: model() })
    case_("1 · nothing set (what a cell holds today)", bare)

    // 2 — the call `disk.ts` makes, and the one this probe exists to disprove.
    const labelled = NidaraDropDown({ model: model() })
    labelled.update_property([Gtk.AccessibleProperty.LABEL], ["Mount point — /dev/sda1"])
    case_("2 · LABEL set", labelled)

    // 3 — the fix, through the kit option it became.
    const described = NidaraDropDown({
      model: model(), accessibleDescription: "Mount point — /dev/sda2",
    })
    case_("3 · DESCRIPTION set (accessibleDescription)", described)

    // 4 — both, because a fix that has to remove the LABEL call is a bigger change
    // than one that adds to it, and whether they fight is a fact rather than a guess.
    const both = NidaraDropDown({ model: model() })
    both.update_property(
      [Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
      ["Mount point — /dev/sda3", "Mount point — /dev/sda3"])
    case_("4 · LABEL + DESCRIPTION", both)

    // 5 — the relation, rather than the string. It is what a column heading IS,
    // so if it works the kit should be wiring headings to cells instead of
    // copying their text into every row.
    const heading = new Gtk.Label({ label: "Mount point (heading widget)", xalign: 0 })
    body.append(heading)
    const labelledBy = NidaraDropDown({ model: model() })
    // ⚠️ MEASURED, and it is a dead end from here: `update_relation` takes a GList
    // of `GtkAccessible`, which GJS cannot build. The nested form throws
    // ("Could not guess unspecified GValue type") and the flat form is accepted
    // and then prints `g_value_get_pointer: assertion 'G_VALUE_HOLDS_POINTER'
    // failed` — i.e. it sets nothing. So the relation a column heading IS cannot
    // be expressed in this binding, and a string on the control is not a
    // fallback we chose, it is the only thing reachable.
    //   labelledBy.update_relation([Gtk.AccessibleRelation.LABELLED_BY], [heading])
    case_("5 · LABELLED_BY the heading above", labelledBy)

    // 6 — the CONTROL. The same call, on the control it is known to stick on.
    // Without this row, "the dropdowns have no name" cannot be told apart from
    // "this probe cannot read names".
    const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER })
    check.update_property([Gtk.AccessibleProperty.LABEL], ["Format — /dev/sda1"])
    case_("6 · CONTROL: a CheckButton with LABEL set", check)

    const shell = NidaraWindow({
      app,
      title: "dropdown-a11y-probe",
      name: "dropdown-a11y-probe",
      appId: "dropdown-a11y-probe",
      content: body,
      closeOnEscape: true,
      resizable: true,
    })

    shell.window.default_width = 720
    shell.window.default_height = 420
    shell.window.connect("destroy", () => app.quit())
    shell.window.present()

    console.log("[dropdown-a11y] window up — now run:  nidara-a11y dropdown-a11y-probe")
  },
})
