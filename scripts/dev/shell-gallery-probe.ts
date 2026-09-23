// shell-gallery-probe — the shell's half of the substrate A/B, which did not exist.
//
//   cd ui/shell && npx --yes sass@1.97.3 --no-charset style.scss style.css && cd ../..
//   ./scripts/bundle.sh scripts/dev/shell-gallery-probe.ts /tmp/shellgal
//   gtk4-broadwayd :5 &
//   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 /tmp/shellgal                 # list the scopes
//   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 SCOPE=nidara-bar SHOT=/tmp/a /tmp/shellgal
//   PLATFORM_THEME=1 …                                                    # the other arm
//   FORCE_THEME=<name> …
//
// ── Why it had to exist (tech-debt #107 step 5) ─────────────────────────────
// `kit-gallery-probe` prices the substrate for the KIT, and `installer-pages-probe`
// for the installer. Both are bundles that already ran themeless. The SHELL was the
// one still wearing the user's GTK theme (until 2026-09-23), the bundle Settings
// lives in, and it had no probe at all — so the first three rules of `ui/lib/nidara-kit/styles/_base-layer.scss`
// went in measured against everything EXCEPT the bundle they could hurt. Our sheets
// load at PRIORITY_USER (800) and a theme at 200, so a bare `button` rule outranks
// the theme for any shell button that does not declare that property itself. This is
// the instrument that says whether one did.
//
// ── What it mounts, and why it is DERIVED rather than curated ───────────────
// It reads the shell's COMPILED sheet and enumerates it: every `<element>.<class>`
// compound the shell styles, grouped by the window scope its selector sits under.
// A curated list is a list of what somebody remembered, and the failure this probe
// exists to catch is precisely the widget nobody thought of — so the list comes from
// the sheet, and a node type it cannot build is PRINTED rather than skipped in
// silence (see `feedback_enumerate_dont_count_expected`).
//
// ⚠️ It measures the SHEET, not the shell's widget construction. A class is mounted
// on a bare GTK node of the right type, not on the component that normally wears it,
// so composites (a CC tile's inner layout, the dock's Cairo capsules) are out of
// scope by design — those are painted in Cairo anyway, where no CSS reaches.
//
// ⚠️ One shot per SCOPE, because a window has one name and the shell's rules are
// scoped to it (commandment 2). Mounting `.cc-tile` outside `#nidara-bar` would
// report it unstyled and the A/B would be a false alarm.
import Gtk from "gi://Gtk?version=4.0"
import Gsk from "gi://Gsk"
import GLib from "gi://GLib"
import app from "../../ui/lib/nidara-kit/platform/host"
import { applyCrispFontRendering } from "../../ui/lib/nidara-kit/platform/font-rendering"
import { initAppearance } from "../../ui/lib/nidara-kit/platform/appearance-css"
import { useNoGtkTheme } from "../../ui/lib/nidara-kit/platform/gtk-theme"

// Same rule as the other two probes: the substrate is the POINT, so it is explicit.
// The default here is NO theme — what step 5 is taking the shell TO — and
// `PLATFORM_THEME=1` is where the shell is today.
const forced = GLib.getenv("FORCE_THEME")
if (forced) GLib.setenv("GTK_THEME", forced, true)
else if (GLib.getenv("PLATFORM_THEME") !== "1") useNoGtkTheme()

const here = GLib.get_current_dir()
const cssPath = [`${here}/ui/shell/style.css`, "./ui/shell/style.css"]
  .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))

/** The GTK node names we can actually build one of. Anything else is reported. */
const NODES: Record<string, () => Gtk.Widget> = {
  button: () => new Gtk.Button({ label: "Button" }),
  entry: () => new Gtk.Entry({ text: "entry" }),
  label: () => new Gtk.Label({ label: "label" }),
  image: () => new Gtk.Image({ icon_name: "nd-settings-symbolic", pixel_size: 16 }),
  switch: () => new Gtk.Switch({ active: true, halign: Gtk.Align.START }),
  separator: () => new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }),
  expander: () => { const e = new Gtk.Expander({ label: "expander" }); e.set_child(new Gtk.Label({ label: "c" })); return e },
  textview: () => { const t = new Gtk.TextView({ height_request: 32 }); t.buffer.set_text("textview", -1); return t },
  spinner: () => new Gtk.Spinner({ spinning: true, halign: Gtk.Align.START }),
  checkbutton: () => new Gtk.CheckButton({ active: true, halign: Gtk.Align.START }),
  scrolledwindow: () => { const s = new Gtk.ScrolledWindow({ height_request: 40 }); s.set_child(new Gtk.Label({ label: "scrolled" })); return s },
  box: () => { const b = new Gtk.Box({ spacing: 4 }); b.append(new Gtk.Label({ label: "box" })); return b },
  revealer: () => { const r = new Gtk.Revealer({ reveal_child: true }); r.set_child(new Gtk.Label({ label: "revealer" })); return r },
  stack: () => { const s = new Gtk.Stack(); s.add_named(new Gtk.Label({ label: "stack" }), "a"); return s },
  flowbox: () => { const f = new Gtk.FlowBox(); f.append(new Gtk.Label({ label: "flow" })); return f },
  list: () => { const l = new Gtk.ListBox(); l.append(new Gtk.Label({ label: "row" })); return l },
  row: () => new Gtk.ListBoxRow({ child: new Gtk.Label({ label: "row" }) }),
  calendar: () => new Gtk.Calendar({ halign: Gtk.Align.START }),
  spinbutton: () => new Gtk.SpinButton({ adjustment: new Gtk.Adjustment({ lower: 0, upper: 10, value: 3, step_increment: 1 }), halign: Gtk.Align.START }),
  // `popover` is deliberately absent: it only exists attached to a parent and
  // mapped, so mounting one in a column would measure a popover nobody opened.
}

/** A scope key as it appears at the head of a selector, e.g. `#nidara-bar`. */
type Mount = { node: string, cls: string }

/**
 * Enumerate the sheet. For every selector: the SCOPE is its leading `#id` or
 * `window.class` (none = the sheet's global layer, which every scope shows), and the
 * MOUNT is the last `<element>.<class>` compound in it — the node the rule lands on.
 */
function readSheet(css: string): Map<string, Mount[]> {
  const out = new Map<string, Mount[]>()
  const seen = new Set<string>()
  // Selectors only: everything before each `{`, minus comments and at-rules.
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const chunk of body.split("}")) {
    const i = chunk.indexOf("{")
    if (i < 0) continue
    for (const sel of chunk.slice(0, i).split(",")) {
      const s = sel.trim()
      if (!s || s.startsWith("@") || s.includes(":")) continue
      const scopeM = s.match(/^(#[a-zA-Z0-9_-]+|window\.[a-zA-Z0-9_-]+)/)
      const scope = scopeM ? scopeM[1] : "(global)"
      // ⚠️ NOT `\b([a-z]+)\.` — that also matches the tail of a class in a compound
      // selector (`.nidara-bar.nidara-btn` yields the node "bar"), and the probe
      // then reports a pile of node types it "cannot build" that were never nodes.
      // An element name starts a compound: line start, or after a combinator.
      const pairs = [...s.matchAll(/(?:^|[\s>+~])([a-z]+)\.([a-zA-Z0-9_-]+)/g)]
      const last = pairs[pairs.length - 1]
      if (!last) continue
      const [, node, cls] = last
      if (node === "window") continue          // the scope itself, not a mount
      const key = `${scope}|${node}|${cls}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!out.has(scope)) out.set(scope, [])
      out.get(scope)!.push({ node, cls })
    }
  }
  return out
}

function savePng(widget: Gtk.Widget, win: Gtk.Window, path: string) {
  const w = widget.get_width(), h = widget.get_height()
  if (w <= 0 || h <= 0) { printerr(`[shot] ${path}: ${w}x${h}`); return }
  const snapshot = Gtk.Snapshot.new()
  // ⚠️ The WINDOW, not its child: a window's background is painted by the `window`
  // node itself, so a snapshot of the child cannot contain it and would report every
  // background rule as a no-op. `kit-gallery-probe` learned this the expensive way.
  Gtk.WidgetPaintable.new(widget).snapshot(snapshot, w, h)
  const node = snapshot.to_node()
  if (!node) { printerr(`[shot] ${path}: empty render node`); return }
  const renderer: Gsk.Renderer | null = win.get_renderer?.() ?? null
  if (!renderer) { printerr(`[shot] ${path}: no renderer`); return }
  renderer.render_texture(node, null).save_to_png(path)
  print(`[shot] ${path}  ${w}x${h}`)
}

function labelled(name: string, w: Gtk.Widget): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 })
  box.append(new Gtk.Label({ label: name, xalign: 0, width_request: 260 }))
  box.append(w)
  return box
}

app.start({
  applicationId: "org.nidara.shellgallery",
  applicationName: "Shell gallery probe",
  logDomain: "shell-gallery",
  css: cssPath,

  main() {
    applyCrispFontRendering()
    initAppearance()

    if (!cssPath) { printerr("[shell-gallery] ui/shell/style.css not built — run sass first"); app.quit(); return }
    const [ok, bytes] = GLib.file_get_contents(cssPath)
    if (!ok) { printerr(`[shell-gallery] could not read ${cssPath}`); app.quit(); return }
    const sheet = new TextDecoder().decode(bytes)
    const scopes = readSheet(sheet)
    print(`[shell-gallery] ${cssPath}: ${sheet.length} bytes, ${scopes.size} scope(s)`)

    const want = GLib.getenv("SCOPE")
    if (!want) {
      print("[shell-gallery] scopes in ui/shell/style.css (pass one as SCOPE=, without the # or window.):")
      for (const [scope, mounts] of [...scopes].sort())
        print(`  ${scope.padEnd(32)} ${mounts.length} mount(s)`)
      app.quit()
      return
    }

    const key = [...scopes.keys()].find(k => k === `#${want}` || k === `window.${want}` || k === want)
    if (!key) { printerr(`[shell-gallery] no scope matches "${want}"`); app.quit(); return }

    const page = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 6,
      margin_top: 14, margin_bottom: 14, margin_start: 14, margin_end: 14,
    })

    // The scope's own mounts, plus the global layer's — a widget in this window wears
    // both, exactly as it does in the shell.
    const mounts = [...(scopes.get(key) ?? []), ...(scopes.get("(global)") ?? [])]
    const missing = new Set<string>()
    let built = 0
    for (const { node, cls } of mounts.sort((a, b) => (a.node + a.cls).localeCompare(b.node + b.cls))) {
      const make = NODES[node]
      if (!make) { missing.add(node); continue }
      const w = make()
      w.add_css_class(cls)
      w.halign = Gtk.Align.START
      page.append(labelled(`${node}.${cls}`, w))
      built++
    }

    // The base layer's actual target: nodes wearing NO class of ours. Whatever
    // `_base-layer.scss` grows a rule for belongs here, so the shell's answer to it
    // is visible beside the kit's.
    page.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL, margin_top: 10, margin_bottom: 10 }))
    for (const node of ["button", "entry", "switch", "checkbutton", "spinner", "separator", "expander", "textview"]) {
      page.append(labelled(`${node} (bare)`, NODES[node]()))
    }
    const scale = new Gtk.Scale({ orientation: Gtk.Orientation.HORIZONTAL, adjustment: new Gtk.Adjustment({ lower: 0, upper: 100, value: 40 }), width_request: 160, halign: Gtk.Align.START })
    page.append(labelled("scale (bare)", scale))

    print(`[shell-gallery] scope ${key}: ${built} mount(s) built`)
    if (missing.size) print(`[shell-gallery] ⚠️ node types this probe cannot build: ${[...missing].sort().join(", ")}`)
    // ⚠️ The blind spot, stated rather than hidden. A rule written as a BARE class
    // (`.cc-tile`, `.bar-pill`) names no node, so there is nothing for this probe to
    // mount it on — and those widgets are still exposed to a base-layer element rule
    // for any property their class does not declare. Printed so the number is visible
    // beside the result instead of being discovered later.
    const bare = new Set((sheet.match(/(?:^|[\s,>+~])\.[a-zA-Z0-9_-]+(?=[\s,{:.])/gm) ?? []).map(x => x.trim()))
    print(`[shell-gallery] ⚠️ not covered: ${bare.size} bare-class selector(s) in this sheet name no node, so none of them is mounted here`)

    const scrolled = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true })
    scrolled.set_child(page)

    const win = new Gtk.Window({ application: app, title: `shell gallery — ${key}` })
    // The scope is reproduced on the WINDOW, or none of its rules apply.
    if (key.startsWith("#")) win.set_name(key.slice(1))
    else if (key.startsWith("window.")) win.add_css_class(key.slice(7))
    win.set_child(scrolled)
    win.set_default_size(900, 1000)
    win.connect("destroy", () => app.quit())
    win.present()

    const shot = GLib.getenv("SHOT")
    if (shot) {
      let painted = 0
      const clock = win.get_frame_clock()
      if (!clock) { printerr("[shot] no frame clock"); app.quit(); return }
      clock.connect("after-paint", () => {
        if (++painted < 2) return
        savePng(win, win, `${shot}.png`)
        app.quit()
      })
      clock.begin_updating()
      GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
        printerr("[shot] no second paint in 20 s"); app.quit(); return GLib.SOURCE_REMOVE
      })
    }
  },
})
