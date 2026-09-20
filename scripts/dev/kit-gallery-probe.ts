// kit-gallery-probe — one of each kit component, to price the substrate.
//
//   ./scripts/bundle.sh scripts/dev/kit-gallery-probe.ts /tmp/gallery
//   gtk4-broadwayd :5 &
//   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 SHOT=/tmp/gal-adwaita /tmp/gallery
//   BLANK_THEME=1 GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 SHOT=/tmp/gal-blank /tmp/gallery
//   magick compare -metric AE /tmp/gal-adwaita.png /tmp/gal-blank.png null:
//
// What it is for, and it is a MEASUREMENT rather than a look. Nidara runs two
// different substrates and nobody chose that: the greeter and the lock force
// `GTK_THEME=nidara` (a blank theme — zero rules), while the shell, Settings and the
// installer run on GTK4's built-in Adwaita with `_reset.scss` on top. So the same kit
// component has two different things underneath it, which is how `NidaraToggleRow`
// came to look like Nidara in one process and like GNOME in another.
//
// The difference between the two shots is the PRICE of making the blank theme
// universal: every pixel that changes is a pixel Adwaita is drawing for us today and
// that the kit would have to draw itself. Zero difference means the kit already owns
// that component completely.
//
// ⚠️ Our CSS already WINS over Adwaita wherever it declares anything — the providers
// load at `STYLE_PROVIDER_PRIORITY_USER`, above the theme's. So a difference here is
// never "Adwaita overrode us": it is always "we said nothing, so Adwaita spoke".
// That is also exactly what a reset is for — a declaration whose only job is to give
// us something to win with (see `ui/shell/styles/_reset.scss`).
import Gtk from "gi://Gtk?version=4.0"
import Gsk from "gi://Gsk"
import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { initAppearance } from "../../ui/lib/appearance-css"
import {
  NidaraWindow, NidaraList, NidaraRow, NidaraFieldRow, NidaraStackedRow,
  NidaraToggleRow, NidaraDropDownRow, NidaraButton, NidaraCircleButton, NidaraBadge,
} from "../../ui/lib/nidara-kit"

// Same rule as installer-pages-probe: the substrate is the POINT here, so it is
// explicit and the default is what the shell and the installer actually run under.
if (GLib.getenv("BLANK_THEME")) GLib.setenv("GTK_THEME", "nidara", true)

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
    shell.window.set_default_size(720, 620)
    shell.window.connect("destroy", () => app.quit())
    shell.window.present()

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
