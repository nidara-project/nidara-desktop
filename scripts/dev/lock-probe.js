#!/usr/bin/env gjs -m
/*
 * lock-probe — render the lockscreen / greeter surface offscreen, to a PNG.
 *
 *   gtk4-broadwayd :5 &                        # offscreen display, once
 *   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 \
 *     gjs -m scripts/dev/lock-probe.js /tmp/lock
 *
 * Why this exists. These two surfaces are the only ones in the DE that cannot be
 * looked at while working on them: the shell reloads with Super+Shift+R, but
 * seeing the lockscreen means locking the session you are editing from, and
 * seeing the greeter means logging out. So they got changed blind, and the
 * result was a session (2026-08-09) in which the user had to act as the render
 * loop and found four defects by eye that nobody else could have found.
 *
 * This is the cheap half of the answer — the same trick as `gtk-probe.js`, one
 * surface up: build the REAL widget tree with the REAL stylesheet on the
 * broadway backend, and write a PNG. The expensive half (the VM) is still the
 * gate for anything about the compositor, the session-lock protocol, or the
 * painted glass; see the maintainer skill's vm-test harness.
 *
 * ⚠️ WHAT THIS DOES NOT SHOW. The lockscreen PAINTS its capsules
 * (widget/GlassBackdrop.ts blurs its own copy of the wallpaper, because under
 * ext-session-lock-v1 the compositor draws nothing behind the lock surface), and
 * the greeter gets compositor blur from a layer_rule. Neither exists here: this
 * renders the surface as the CSS describes it, with a flat backdrop. So it
 * answers TYPE, COLOUR, SPACING and HIERARCHY — which is what falls out of sync
 * — and says nothing about blur, about the painted rim, or about focus rings
 * (`:focus-visible` does not match offscreen; see gtk-probe.js's known limit).
 *
 * Env hooks:
 *   CSS=<path>   stylesheet to load (default ui/greeter/style.css). Point it at
 *                two different builds to get a before/after pair.
 *   BG=<colour|path>  backdrop standing in for the wallpaper: a CSS colour, or
 *                an image file. Legibility is a question about the WALLPAPER, so
 *                run it at least twice — a dark one and a light one.
 *   SCOPE=greeter|lock   which window classes the specimen carries. `lock` adds
 *                `nidara-lock-window`, which is where the "capsules are painted,
 *                not CSS-drawn" overrides live — so in that scope the capsules
 *                correctly render as nothing. Default `greeter`.
 *   EXTRA_CSS=<path>  a second sheet loaded ABOVE the first — "what if we also
 *                said this?". How candidate treatments are compared without
 *                editing the real stylesheet for each one.
 *   W, H         surface size (default 1280x800).
 *
 * ⚠️ TWO THINGS TO KNOW BEFORE READING A NUMBER OFF IT.
 *
 * 1. `gtk4-broadwayd` is documented above because that is the intended offscreen
 *    path, but Arch's gtk4 4.22 has no working broadway CLIENT backend — the
 *    daemon starts, `GDK_BACKEND=broadway` then fails with "Failed to open
 *    display". So in practice this runs on the LIVE session and flashes a real
 *    window for ~0.7s per render. That is the whole intrusion; nothing is
 *    locked, logged out or restarted.
 * 2. Consequently a TILING compositor sizes the window, and W/H are a request it
 *    ignores — a run can come back 626px wide instead of 1280. Every centred
 *    element then sits somewhere else. **Crop from the bounds this script
 *    prints, never from a remembered offset**, and float the window (Hyprland:
 *    `hyprctl dispatch togglefloating`) when the absolute layout matters.
 */
import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gsk from "gi://Gsk"
import Gio from "gi://Gio"
import system from "system"

const OUT = ARGV[0] || "/tmp/nidara-lock-probe"
const REPO = GLib.getenv("NIDARA_REPO") || GLib.get_current_dir()
const CSS = GLib.getenv("CSS") || `${REPO}/ui/greeter/style.css`
const BG = GLib.getenv("BG") || "#1b2430"
const SCOPE = GLib.getenv("SCOPE") || "greeter"
const W = parseInt(GLib.getenv("W") || "1280", 10)
const H = parseInt(GLib.getenv("H") || "800", 10)

Gtk.init()
const display = Gdk.Display.get_default()

if (!GLib.file_test(CSS, GLib.FileTest.EXISTS)) {
    printerr(`[lock-probe] no stylesheet at ${CSS} — run the bundle's \`npm run build\` first`)
    system.exit(1)
}

// The greeter/lockscreen load exactly one sheet, as the app's CSS. GTK_THEME=nidara
// gives them a blank theme, so there is nothing below it to fight; USER+10 matches
// what app.start({ css }) ends up at.
const provider = new Gtk.CssProvider()
provider.load_from_path(CSS)
Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 10)
print(`[css]   ${CSS}`)

const EXTRA = GLib.getenv("EXTRA_CSS")
if (EXTRA) {
    const extra = new Gtk.CssProvider()
    extra.load_from_path(EXTRA)
    Gtk.StyleContext.add_provider_for_display(display, extra, Gtk.STYLE_PROVIDER_PRIORITY_USER + 40)
    print(`[extra] ${EXTRA}`)
}
print(`[scope] ${SCOPE}   [bg] ${BG}`)

// ── the specimen: Lock.ts's buildWindow(), minus the parts that need a session ──
const classes = SCOPE === "lock" ? ["greeter-window", "nidara-lock-window"] : ["greeter-window"]
const win = new Gtk.Window({ default_width: W, default_height: H, css_classes: classes })

const backdrop = GLib.file_test(BG, GLib.FileTest.EXISTS)
    ? (() => {
        const pic = new Gtk.Picture({ hexpand: true, vexpand: true, content_fit: Gtk.ContentFit.COVER })
        pic.set_filename(BG)
        return pic
    })()
    : (() => {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        const p = new Gtk.CssProvider()
        p.load_from_string(`.probe-bg { background: ${BG}; }`)
        box.add_css_class("probe-bg")
        box.get_style_context().add_provider(p, Gtk.STYLE_PROVIDER_PRIORITY_USER + 20)
        return box
    })()

// Clock block — Clock.ts: date ABOVE time, both centred, in a spacing-0 column.
const clockBox = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL, spacing: 0,
    halign: Gtk.Align.CENTER, valign: Gtk.Align.START, margin_top: 72,
})
clockBox.append(new Gtk.Label({
    label: GLib.getenv("DATE_TEXT") || "martes, 9 de agosto",
    css_classes: ["greeter-date"], halign: Gtk.Align.CENTER, xalign: 0.5,
}))
clockBox.append(new Gtk.Label({
    label: GLib.getenv("TIME_TEXT") || "09:41",
    css_classes: ["greeter-clock"], halign: Gtk.Align.CENTER, xalign: 0.5,
}))

// Card — LockCard.ts. The avatar is a plain box at the same size: this probe is
// about type and spacing, and the real one is a Gtk.Picture of the user's photo.
const card = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
    css_classes: ["greeter-card", "greeter-card-shown"],
})
const avatar = new Gtk.Box({
    width_request: 80, height_request: 80, halign: Gtk.Align.CENTER,
    css_classes: ["greeter-avatar", "greeter-avatar-fallback"],
})
card.append(avatar)
card.append(new Gtk.Label({
    label: GLib.getenv("USER_TEXT") || "Ángel",
    css_classes: ["greeter-username"], halign: Gtk.Align.CENTER, margin_top: 10,
}))
const entry = new Gtk.PasswordEntry({
    placeholder_text: "Contraseña", show_peek_icon: true,
    css_classes: ["greeter-password"], halign: Gtk.Align.CENTER,
    width_request: 280, margin_top: 20,
})
card.append(entry)
card.append(new Gtk.Button({
    label: "Desbloquear", css_classes: ["greeter-login-btn"],
    halign: Gtk.Align.CENTER, width_request: 280, margin_top: 8,
}))
if (GLib.getenv("ERROR")) {
    card.append(new Gtk.Label({
        label: "Contraseña incorrecta", css_classes: ["greeter-error"],
        wrap: true, halign: Gtk.Align.CENTER, margin_top: 6,
    }))
}

// Power bar — PowerBar.ts. ICONS=1 loads the shipped Lucide glyphs the way
// ui/lib/icons.ts does at runtime, which is the only way to see whether the
// `nd-icon` invert actually lands (they render BLACK unloaded, so a missing
// invert is invisible in the source and obvious here). Off by default: a
// missing-glyph placeholder measures differently from the real thing, and the
// type questions this probe exists for are about the labels.
const POWER_ICONS = { Suspender: "moon", Reiniciar: "rotate-ccw", Apagar: "power" }
const ICON_DIR = `${GLib.getenv("NIDARA_SHELL_ROOT") ?? "/usr/share/nidara/ui/shell"}/assets/icons/hicolor/scalable/actions`
const powerBar = new Gtk.Box({
    spacing: 4, halign: Gtk.Align.CENTER, valign: Gtk.Align.END,
    css_classes: ["greeter-power-bar"], margin_bottom: 40,
})
for (const label of ["Suspender", "Reiniciar", "Apagar"]) {
    const inner = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
    if (GLib.getenv("ICONS")) {
        const path = `${ICON_DIR}/${POWER_ICONS[label]}.svg`
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            inner.append(new Gtk.Image({
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(path)),
                pixel_size: 14, css_classes: ["nd-icon"],
            }))
        } else print(`  ! no shipped icon at ${path}`)
    }
    inner.append(new Gtk.Label({ label }))
    powerBar.append(new Gtk.Button({ css_classes: ["greeter-power-btn"], child: inner }))
}

const overlay = new Gtk.Overlay()
overlay.set_child(backdrop)
// The wallpaper scrim, as both real surfaces build it — `can_target: false`
// included, because that is what stops a full-size overlay child from swallowing
// every click meant for the card. Shipped since 2026-08-09; it started life as an
// env-gated candidate here, which is what EXTRA_CSS is for now.
const scrim = new Gtk.Box({ hexpand: true, vexpand: true, css_classes: ["greeter-scrim"] })
scrim.set_can_target(false)
overlay.add_overlay(scrim)
overlay.add_overlay(clockBox)
overlay.add_overlay(card)
overlay.add_overlay(powerBar)
win.set_child(overlay)

// ── reporting ────────────────────────────────────────────────────────────────
const boundsIn = (w, root) => {
    const [ok, r] = w.compute_bounds(root)
    return ok ? { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height } : null
}
const fmt = (b) => b ? `${b.w.toFixed(0)}x${b.h.toFixed(0)} at (${b.x.toFixed(0)},${b.y.toFixed(0)})` : "(unallocated)"

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
    // Same trap as gtk-probe.js: a realized renderer reaching the GC aborts the
    // process, which kills the run before a second frame is written.
    renderer.unrealize()
    print(`  → ${path} (${w}x${h})`)
}

win.present()
const loop = GLib.MainLoop.new(null, false)

GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
    const dateL = clockBox.get_first_child()
    const timeL = dateL.get_next_sibling()
    const userL = avatar.get_next_sibling()

    // The numbers the type pass is actually about. Heights, not font-sizes: a
    // font-size is what we asked for, a height is what Pango gave us.
    print("\n═══ HERO BLOCK ═══")
    print(`date      ${fmt(boundsIn(dateL, win))}`)
    print(`clock     ${fmt(boundsIn(timeL, win))}`)
    print(`username  ${fmt(boundsIn(userL, win))}`)
    const db = boundsIn(dateL, win), tb = boundsIn(timeL, win)
    if (db && tb) print(`date:clock height ratio = 1 : ${(tb.h / db.h).toFixed(2)}`)

    print("\n═══ CARD ═══")
    print(`card      ${fmt(boundsIn(card, win))}`)
    print(`entry     ${fmt(boundsIn(entry, win))}`)
    print(`powerbar  ${fmt(boundsIn(powerBar, win))}`)

    savePng(overlay, `${OUT}.png`)
    savePng(card, `${OUT}-card.png`)
    savePng(clockBox, `${OUT}-hero.png`)

    win.close()
    loop.quit()
    return GLib.SOURCE_REMOVE
})

loop.run()
