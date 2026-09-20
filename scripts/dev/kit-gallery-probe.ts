// kit-gallery-probe — one of each kit component, to price the substrate.
//
//   ./scripts/bundle.sh scripts/dev/kit-gallery-probe.ts /tmp/gallery
//   gtk4-broadwayd :5 &
//   PLATFORM_THEME=1 GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 SHOT=/tmp/gal-themed /tmp/gallery
//   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 SHOT=/tmp/gal-none /tmp/gallery
//   magick compare -metric AE /tmp/gal-themed.png /tmp/gal-none.png null:
//
//   FORCE_THEME=<name>  price one named theme instead of the developer's
//   FONT_DIALOG=1       shoot GTK's OWN font dialog instead of the gallery page
//
// `FONT_DIALOG=1` is the base layer's first ruler (tech-debt #107 step 5). The dialog
// `Gtk.FontDialog` opens is a `GtkFontChooserDialog` toplevel GTK builds ITSELF, in our
// process, carrying none of our classes — so it is reachable by ELEMENT selectors and by
// nothing else, and it is the widest collection of bare GTK nodes our process can be made
// to show: `button`, `entry`, the font `listview`, a `scale` trough and `spinbutton`s.
// `ui/lib/nidara-kit/fontbutton.ts` is what opens it for real, from Settings.
//
// What it is for, and it is a MEASUREMENT rather than a look. Nidara used to run two
// different substrates and nobody had chosen that: the greeter, the lock and the
// installer selected a blank theme, while the SHELL — Settings included — unset
// `GTK_THEME` and wore whatever GTK theme the user had, with `_reset.scss` on top. So
// the same kit component had two different things underneath it, which is how
// `NidaraToggleRow` came to look like Nidara in one process and like GNOME in another.
//
// Commandment 11 settled it: every Nidara process runs on `GTK_THEME=Empty`. This
// probe is what PRICED that, and it stays as the instrument that re-prices it — the
// difference between the two shots is every pixel the user's theme is drawing for us
// and that the kit would have to draw itself. Zero difference means the kit already
// owns that component completely.
//
// Measured 2026-09-20: 345 differing pixels of 495 000, and they are exactly two
// things — the `dropdown`'s arrow (which vanishes) and the entry `placeholder` (which
// stops being dimmed).
//
// ⚠️ Our CSS already WINS over a theme wherever it declares anything — the providers
// load at `STYLE_PROVIDER_PRIORITY_USER`, above the theme's. So a difference here is
// never "the theme overrode us": it is always "we said nothing, so the theme spoke".
// That is also exactly what a reset is for — a declaration whose only job is to give
// us something to win with (see `ui/shell/styles/_reset.scss`).
import Gtk from "gi://Gtk?version=4.0"
import Gsk from "gi://Gsk"
import Pango from "gi://Pango"
import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { initAppearance } from "../../ui/lib/appearance-css"
import { useNoGtkTheme } from "../../ui/lib/gtk-theme"
import {
  NidaraWindow, NidaraList, NidaraRow, NidaraFieldRow, NidaraStackedRow,
  NidaraToggleRow, NidaraDropDownRow, NidaraButton, NidaraCircleButton, NidaraBadge,
} from "../../ui/lib/nidara-kit"

// Same rule as installer-pages-probe: the substrate is the POINT here, so it is
// explicit, and the default is what every Nidara process now runs on — no theme.
// `PLATFORM_THEME=1` is the other arm of the A/B: the developer's own GTK theme,
// which is what a third-party application gets and what our processes used to.
const forced = GLib.getenv("FORCE_THEME")
if (forced) GLib.setenv("GTK_THEME", forced, true)
else if (GLib.getenv("PLATFORM_THEME") !== "1") useNoGtkTheme()

const shot = GLib.getenv("SHOT")
const here = GLib.get_current_dir()
// The kit's own sheet reaches this probe through the installer's compiled CSS, which
// is the smallest bundle that compiles `ui/lib/styles/` and nothing shell-only.
const css = [`${here}/ui/installer/style.css`, "./ui/installer/style.css"]
  .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))

function savePng(widget: Gtk.Widget, win: Gtk.Window, path: string) {
  const w = widget.get_width()
  const h = widget.get_height()
  if (w <= 0 || h <= 0) { printerr(`[shot] ${path}: ${w}x${h}`); return }
  const snapshot = Gtk.Snapshot.new()
  Gtk.WidgetPaintable.new(widget).snapshot(snapshot, w, h)
  const node = snapshot.to_node()
  if (!node) { printerr(`[shot] ${path}: empty render node`); return }
  const renderer: Gsk.Renderer | null = win.get_renderer?.() ?? null
  if (!renderer) { printerr(`[shot] ${path}: no renderer`); return }
  renderer.render_texture(node, null).save_to_png(path)
  print(`[shot] ${path}  ${w}x${h}`)
}

/** A caption beside the widget, so a shot says which node each row is. */
function labelled(name: string, w: Gtk.Widget): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12 })
  box.append(new Gtk.Label({ label: name, xalign: 0, width_request: 200 }))
  w.hexpand = true
  box.append(w)
  return box
}

app.start({
  applicationId: "org.nidara.kitgallery",
  applicationName: "Kit gallery probe",
  logDomain: "kit-gallery",
  css,

  main() {
    applyCrispFontRendering()
    initAppearance()

    const page = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 14,
      margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16,
    })

    // Rows — the shapes that carry GTK widgets with a theme drawing of their own.
    const rows = NidaraList("Rows")
    rows.listBox.append(NidaraRow("Plain row", "title and subtitle"))
    rows.listBox.append(NidaraToggleRow("Toggle row", "a Gtk.Switch", true, () => {}))
    rows.listBox.append(NidaraToggleRow("Toggle row, off", "the other state", false, () => {}))
    rows.listBox.append(NidaraDropDownRow("Dropdown row", "a Gtk.DropDown", "Second",
      ["First", "Second", "Third"], () => {}))
    // Both take a CONTROL widget, which is the point: the entry is the GTK node
    // whose placeholder Adwaita draws and we do not.
    const entry = new Gtk.Entry({ text: "typed text", hexpand: true })
    rows.listBox.append(NidaraFieldRow("Field row", "a Gtk.Entry", entry).row)
    const placeholder = new Gtk.Entry({ placeholder_text: "placeholder text", hexpand: true })
    rows.listBox.append(NidaraStackedRow("Stacked row", "its entry is empty", placeholder))
    page.append(rows.box)

    // Buttons and badges — `button` is the node with the most theme drawing in GTK.
    const buttons = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 })
    buttons.append(NidaraButton({ label: "Button" }))
    buttons.append(NidaraButton({ label: "Primary", variant: "primary" }))
    buttons.append(NidaraButton({ label: "Danger", variant: "danger" }))
    buttons.append(NidaraCircleButton({ iconName: "window-close-symbolic" }))
    buttons.append(NidaraBadge("Badge"))
    page.append(buttons)

    // ── the RAW GTK nodes our bundles build ────────────────────────────────────
    // `scripts/ci/style-ownership-check.mjs` keeps an OWED map of nodes some bundle
    // builds and no sheet of ours draws. That list is a list of QUESTIONS, and the
    // only thing that answers one is looking at the widget with no theme under it:
    // "GTK's theme has a rule for it" and "we need a rule for it" are different
    // claims, and several of these turned out to be the first without the second.
    // Whatever is still in OWED should be visible here, so the answer can be seen.
    const raw = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })

    const spinner = new Gtk.Spinner({ spinning: true, halign: Gtk.Align.START })
    raw.append(labelled("spinner (spinning)", spinner))

    const sep = new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL })
    raw.append(labelled("separator", sep))

    const expander = new Gtk.Expander({ label: "expander", expanded: false })
    expander.set_child(new Gtk.Label({ label: "child" }))
    raw.append(labelled("expander", expander))

    const tv = new Gtk.TextView({ monospace: true, editable: false, height_request: 44 })
    tv.buffer.set_text("textview line one\ntextview line two", -1)
    raw.append(labelled("textview", tv))

    const flow = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.SINGLE, min_children_per_line: 3 })
    for (const t of ["one", "two", "three"]) flow.append(new Gtk.Label({ label: t }))
    flow.select_child(flow.get_child_at_index(1)!)
    raw.append(labelled("flowbox (middle child selected)", flow))

    page.append(raw)

    const shell = NidaraWindow({
      app,
      title: "Kit gallery probe",
      name: "nidara-installer",
      appId: "nidara-kit-gallery",
      cssClasses: ["nidara-installer-window"],
      glassClasses: ["installer-root"],
      content: page,
      header: { start: new Gtk.Label({ label: "kit", css_classes: ["installer-title"], xalign: 0 }) },
      closeOnEscape: true,
    })
    shell.window.set_default_size(720, 900)
    shell.window.connect("destroy", () => app.quit())
    shell.window.present()

    // ── the font dialog: a toplevel of GTK's, in our process ───────────────────
    // Deliberately NOT a section of the page above: it is its own window, which is the
    // whole reason our scoped rules cannot reach it. Shot the same way — real paints,
    // never a timer — but of the dialog's own child and through the dialog's renderer.
    if (GLib.getenv("FONT_DIALOG") === "1") {
      const fd = new Gtk.FontDialog({ title: "Choose a font" })
      fd.choose_font(shell.window, Pango.FontDescription.from_string("Inter 14"), null,
        () => { /* the pick is irrelevant; we are measuring the dialog */ })

      // The dialog is GTK's, so we have no handle on it: find the toplevel that is not
      // ours. Polling rather than a signal because there is no signal to connect to.
      let tries = 0
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        const dialog = Gtk.Window.list_toplevels()
          .find(w => w !== shell.window && w.get_mapped() && w.get_width() > 0)
        if (!dialog) {
          if (++tries < 100) return GLib.SOURCE_CONTINUE
          printerr("[shot] the font dialog never mapped in 10 s")
          app.quit()
          return GLib.SOURCE_REMOVE
        }
        print(`[font-dialog] ${dialog.constructor.$gtype.name} ${dialog.get_width()}x${dialog.get_height()}`)
        if (!shot) { app.quit(); return GLib.SOURCE_REMOVE }
        let dpainted = 0
        const dclock = dialog.get_frame_clock()
        if (!dclock) { printerr("[shot] the dialog has no frame clock"); app.quit(); return GLib.SOURCE_REMOVE }
        dclock.connect("after-paint", () => {
          if (++dpainted < 2) return
          // ⚠️ The WINDOW, never `get_child()`. The background of a GTK window is
          // painted by the `window` node itself, so a snapshot of its child cannot
          // contain it — and would report a fully transparent dialog whatever any
          // rule says. Measured the hard way on 2026-09-20: the first run of this
          // arm shot the child, called the dialog "background-less", and then
          // showed 0 change after a `window { background-color: … }` rule that was
          // in fact working. The instrument shared the blind spot it was built to
          // find.
          savePng(dialog, dialog, `${shot}.png`)
          app.quit()
        })
        dclock.begin_updating()
        return GLib.SOURCE_REMOVE
      })
      return
    }

    if (shot) {
      // Real paints, not a timer — see installer-pages-probe for what a timer cost.
      let painted = 0
      const clock = shell.window.get_frame_clock()
      if (!clock) { printerr("[shot] no frame clock"); app.quit(); return }
      clock.connect("after-paint", () => {
        if (++painted < 2) return
        savePng(shell.window.get_child()!, shell.window, `${shot}.png`)
        app.quit()
      })
      clock.begin_updating()
      GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
        printerr("[shot] no second paint in 20 s")
        app.quit()
        return GLib.SOURCE_REMOVE
      })
    }
  },
})
