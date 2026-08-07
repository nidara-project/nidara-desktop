#!/usr/bin/env gjs -m
/*
 * gtk-probe — measure a Nidara control's REAL GTK geometry without a screen.
 *
 *   gtk4-broadwayd :5 &                       # offscreen display, once
 *   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 \
 *     gjs -m scripts/dev/gtk-probe.js /tmp/probe
 *
 * Why this exists. Chasing a stray inset in a native GTK control by reading CSS
 * failed five rounds in a row (the Settings dropdown, 2026-08-03): the theme, our
 * sheet and GTK's own internal boxes all have a say, and every one of them is easy
 * to be wrong about from the source alone. Measuring it live works but needs a
 * human to hold a popover open, and `queryUI` bounds are ambiguous enough that a
 * single absolute reading proves nothing.
 *
 * So: build the same widget, with the same stylesheet at the same provider
 * priority, on the BROADWAY backend — a real GTK layout and a real render, offscreen
 * and reproducible. It prints the CSS node tree with each node's bounds, padding,
 * border, margin and state flags, the same deltas `queryUI` would report, and saves
 * a PNG of the surface (via Gtk.WidgetPaintable + Gsk.CairoRenderer) that you can
 * measure pixel by pixel.
 *
 * Three env hooks make it an experiment rather than a dump:
 *   SCOPE=…       which shell WINDOW the specimen stands in: settings (default),
 *                 bar, island or dock. ⚠️ NOT cosmetic — our sheets are scoped per
 *                 window (`#nidara-bar …`, `window.nidara-settings-window`), so a
 *                 specimen built in the wrong one matches NOTHING and every
 *                 measurement comes back as if the widget were unstyled. There is no
 *                 error for this: padding just reads 0. Pick the window your widget
 *                 really lives in, and if a value looks suspiciously bare, suspect
 *                 this first.
 *   EXTRA_CSS=…   loaded ABOVE style.css — "what if we also said this?"
 *   LOW_CSS=…     loaded at the THEME priority — stands in for Adwaita, so you can
 *                 test whether one of our declarations really beats the theme's.
 *                 (That is how `outline: none` was proven to kill the theme's
 *                 `outline-width` longhand: it does.)
 *
 * ⚠️ KNOWN LIMIT: `:focus-visible` cannot be reproduced here. GTK grants it on
 * keyboard traversal only; `grab_focus()` + `gtk_window_set_focus_visible()` set the
 * widget's FOCUS_VISIBLE state flag — you can see it in the dump — and the selector
 * still does not match. `:focus` and `:selected` do match, so use one of those as
 * the stand-in state when the question is about the CASCADE rather than about focus
 * itself. Anything that must be verified in the focused state is a live check.
 */
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gsk from "gi://Gsk"
// `imports.system` does not exist under `gjs -m`; the module build is a real import.
import system from "system"

const OUT = ARGV[0] || "/tmp/nidara-probe"
const REPO = GLib.getenv("NIDARA_REPO") || GLib.get_current_dir()
const STYLE = `${REPO}/ui/shell/style.css`
const ITEMS = parseInt(GLib.getenv("ITEMS") || "5", 10)

Gtk.init()
const display = Gdk.Display.get_default()

// Same ladder as core/ThemeManager.ts: style.css at PRIORITY_USER + 10.
const load = (css, priority, fromPath = false) => {
    const p = new Gtk.CssProvider()
    fromPath ? p.load_from_path(css) : p.load_from_string(css)
    Gtk.StyleContext.add_provider_for_display(display, p, priority)
}
const lowCss = GLib.getenv("LOW_CSS")
if (lowCss) { load(lowCss, Gtk.STYLE_PROVIDER_PRIORITY_THEME); print(`[theme-priority] ${lowCss}`) }
load(STYLE, Gtk.STYLE_PROVIDER_PRIORITY_USER + 10, true)
const extraCss = GLib.getenv("EXTRA_CSS")
if (extraCss) { load(extraCss, Gtk.STYLE_PROVIDER_PRIORITY_USER + 40); print(`[above style.css] ${extraCss}`) }

// ── the scope ────────────────────────────────────────────────────────────────
// A shell window is identified BOTH ways in our sheets — by id (`#nidara-bar`) and
// by class (`.nidara-bar-window`) — and the two names differ, so carry both. The
// dock's window hosts the app grid too (there is no app-launcher window).
const SCOPES = {
    settings: { name: "nidara-settings-window", cls: "nidara-settings-window" },
    bar:      { name: "nidara-bar",             cls: "nidara-bar-window" },
    island:   { name: "nidara-island",          cls: "nidara-island-window" },
    dock:     { name: "nidara-dock",            cls: "nidara-dock-window" },
}
const scopeKey = GLib.getenv("SCOPE") || "settings"
const scope = SCOPES[scopeKey]
if (!scope) {
    printerr(`[gtk-probe] unknown SCOPE "${scopeKey}" — pick one of: ${Object.keys(SCOPES).join(", ")}`)
    system.exit(1)
}
print(`[scope] ${scopeKey} → window#${scope.name}.${scope.cls}`)

// ── the specimen ─────────────────────────────────────────────────────────────
// Mirrors NidaraDropDown (ui/lib/nidara-kit/scrolled.ts): our own list factory, the
// fill on `.nidara-dropdown-item`, GTK's scroller adopted into an overlay.
const win = new Gtk.Window({ default_width: 460, default_height: 260, name: scope.name, css_classes: [scope.cls] })
const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 40, margin_start: 40 })
win.set_child(page)

const strings = []
for (let i = 0; i < ITEMS; i++) strings.push(`Option ${i + 1}`)
const drop = Gtk.DropDown.new_from_strings(strings)
const factory = new Gtk.SignalListItemFactory()
factory.connect("setup", (_f, item) => {
    const label = new Gtk.Label({ xalign: 0, hexpand: true, halign: Gtk.Align.FILL })
    const row = new Gtk.Box({ css_classes: ["nidara-dropdown-item"], hexpand: true, halign: Gtk.Align.FILL })
    row.append(label)
    item.set_child(row)
})
factory.connect("bind", (_f, item) => {
    const label = item.get_child()?.get_first_child()
    if (label) label.label = item.get_item()?.string ?? ""
})
// FACTORY=gtk keeps GTK's default list factory — the before/after that shows what
// our own rows actually changed (GTK's item carries a checkmark; ours does not).
if (GLib.getenv("FACTORY") !== "gtk") drop.list_factory = factory
page.append(drop)

const popoverOf = (w) => {
    let c = w.get_first_child()
    while (c) { if (c instanceof Gtk.Popover) return c; c = c.get_next_sibling() }
    return null
}
const findNode = (w, name) => {
    if (w.get_css_name() === name) return w
    let c = w.get_first_child()
    while (c) { const r = findNode(c, name); if (r) return r; c = c.get_next_sibling() }
    return null
}

// adoptGtkScrolled's geometry, without the painting: the ScrolledWindow moves into a
// Gtk.Overlay that also holds the (measure-excluded) bar.
const adoptScroller = () => {
    const pop = popoverOf(drop)
    const box = pop?.get_child()
    let sw = box?.get_first_child()
    while (sw && !(sw instanceof Gtk.ScrolledWindow)) sw = sw.get_next_sibling()
    if (!sw) return
    const prev = sw.get_prev_sibling()
    box.remove(sw)
    sw.vscrollbar_policy = Gtk.PolicyType.EXTERNAL
    const bar = new Gtk.DrawingArea({
        css_classes: ["nidara-scroll-bar"], halign: Gtk.Align.END, valign: Gtk.Align.FILL,
        width_request: 12, margin_top: 4, margin_bottom: 4, can_target: false,
    })
    const overlay = new Gtk.Overlay()
    overlay.set_child(sw); overlay.add_overlay(bar); overlay.set_measure_overlay(bar, false)
    prev ? box.insert_child_after(overlay, prev) : box.prepend(overlay)
}
adoptScroller()

// ── reporting ────────────────────────────────────────────────────────────────
const STATES = ["ACTIVE", "PRELIGHT", "SELECTED", "INSENSITIVE", "FOCUSED", "FOCUS_VISIBLE", "FOCUS_WITHIN"]
const stateOf = (w) => {
    const f = w.get_state_flags()
    return STATES.filter(k => f & Gtk.StateFlags[k]).join("|") || "-"
}
const boundsIn = (w, root) => {
    const [ok, r] = w.compute_bounds(root)
    return ok ? { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height } : null
}
const fmt = (b) => b ? `(${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.w.toFixed(0)}x${b.h.toFixed(0)})` : "(unallocated)"

function dump(w, root, depth = 0) {
    const sc = w.get_style_context()
    const p = sc.get_padding(), b = sc.get_border(), m = sc.get_margin()
    const cls = w.get_css_classes()
    const trbl = (x) => `${x.top}/${x.right}/${x.bottom}/${x.left}`
    print(`${"  ".repeat(depth)}${w.get_css_name()}${cls.length ? "." + cls.join(".") : ""} `
        + `${fmt(boundsIn(w, root))} pad ${trbl(p)} bor ${trbl(b)} mar ${trbl(m)} ${stateOf(w)}`)
    let c = w.get_first_child()
    while (c) { dump(c, root, depth + 1); c = c.get_next_sibling() }
}

function savePng(widget, path) {
    const w = widget.get_width(), h = widget.get_height()
    if (w <= 0 || h <= 0) return print(`  ! ${path}: unallocated`)
    const snapshot = Gtk.Snapshot.new()
    Gtk.WidgetPaintable.new(widget).snapshot(snapshot, w, h)
    const node = snapshot.to_node()
    if (!node) return print(`  ! ${path}: nothing drawn`)
    const renderer = Gsk.CairoRenderer.new()
    renderer.realize(null)
    renderer.render_texture(node, null).save_to_png(path)
    // Not optional: a realized renderer that reaches the GC aborts the process
    // (`gsk_renderer_dispose: assertion failed: (!priv->is_realized)`), which kills
    // the run before a SECOND frame is ever written.
    renderer.unrealize()
    print(`  → ${path} (${w}x${h})`)
}

win.present()
const loop = GLib.MainLoop.new(null, false)

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
    popoverOf(drop).popup()
    // SCROLL=<px> moves the list BEFORE anything is measured or rendered. That is the
    // only way to see whether a vertical inset is AIR the content passes through or a
    // band the content is CUT at — the two are identical at rest. It happens here, and
    // the process still renders exactly ONE frame, because a second
    // WidgetPaintable snapshot of a popover child comes back empty often enough to
    // waste an afternoon.
    const scrollBy = parseFloat(GLib.getenv("SCROLL") || "0")
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
        // …but only once the list is allocated: before that the adjustment's upper is
        // still 0 and the value you set is clamped straight back to it.
        if (scrollBy > 0) {
            const adj = findNode(popoverOf(drop), "scrolledwindow")?.get_vadjustment()
            if (adj) adj.set_value(adj.get_lower() + scrollBy)
        }
        return GLib.SOURCE_REMOVE
    })
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
        const pop = popoverOf(drop)
        print("\n═══ CSS NODE TREE (bounds relative to the popover) ═══")
        dump(pop, pop)

        // The reading `queryUI` gives: every node's bounds against the TOPLEVEL.
        // Compare DELTAS between nodes from one run; a single absolute means nothing.
        const listview = findNode(pop, "listview")
        const row = listview?.get_first_child()
        const pb = boundsIn(pop, win), rb = row && boundsIn(row, win)
        print("\n═══ queryUI-STYLE DELTAS ═══")
        print(`popover ${fmt(pb)}   row[0] ${fmt(rb)}`)
        if (pb && rb) print(`row[0] − popover = ${(rb.x - pb.x).toFixed(1)} left, ${(rb.y - pb.y).toFixed(1)} top`)

        savePng(pop, `${OUT}-popover.png`)
        const contents = findNode(pop, "contents")
        if (contents) savePng(contents, `${OUT}-contents.png`)

        const adj = findNode(pop, "scrolledwindow")?.get_vadjustment()
        if (adj) print(`\nscroll: value ${adj.get_value()} of ${adj.get_upper()}, page ${adj.get_page_size()}`
            + `\n  → page size IS the viewport. On a natively-scrollable list a vertical`
            + ` margin — or padding, measured, they are identical — shrinks it, and the`
            + `\n    content is then clipped at that inset instead of at the card's edge.`)

        win.close()
        loop.quit()
        return GLib.SOURCE_REMOVE
    })
    return GLib.SOURCE_REMOVE
})

loop.run()
