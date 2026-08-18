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
 * ⚠️ WHAT THIS DOES NOT SHOW. Neither surface's BLUR: the lockscreen's own
 * (ui/lib/glass-capsule.ts renders it from the wallpaper, because under
 * ext-session-lock-v1 the compositor draws nothing behind the lock surface) is
 * skipped here unless BG points at a real image, and the greeter's comes from a
 * layer_rule that does not exist offscreen. Nor `:focus-visible`, which GTK only
 * grants on keyboard traversal (see gtk-probe.js's known limit) — use `:focus`
 * as the stand-in when the question is about the cascade.
 *
 * What it does answer: TYPE, COLOUR, SPACING, HIERARCHY, and — with PAINTER set
 * — the capsule's SHAPE, which is what sent the last two rounds sideways.
 *
 * Env hooks:
 *   CSS=<path>   stylesheet to load (default ui/greeter/style.css). Point it at
 *                two different builds to get a before/after pair.
 *   BG=<colour|path>  backdrop standing in for the wallpaper: a CSS colour, or
 *                an image file. Legibility is a question about the WALLPAPER, so
 *                run it at least twice — a dark one and a light one.
 *   SCOPE=greeter|lock   WHICH SURFACE to build, not just which CSS classes.
 *                `lock` is the smaller one (LockCard: avatar, name, password,
 *                unlock, power bar) and is the only scope that sets a backdrop
 *                on the painter. `greeter` adds everything LoginCard has on top
 *                — caps warning, session dropdown, error line, the multi-user
 *                switcher — plus the locale bar in the bottom-left corner, and
 *                is the default. The two share one stylesheet, so a change made
 *                for one has to be looked at in both.
 *   EXTRA_CSS=<path>  a second sheet loaded ABOVE the first — "what if we also
 *                said this?". How candidate treatments are compared without
 *                editing the real stylesheet for each one.
 *   PAINTER=<path>  a BUNDLED ui/lib/glass-capsule.js. Without it the capsules
 *                render as the CSS leaves them, which since 2026-08-09 is
 *                nothing at all — both bundles paint them. So pass it whenever
 *                the question is about the capsule rather than about type:
 *                  npx --yes esbuild ui/lib/glass-capsule.ts --bundle \
 *                    --format=esm --external:'gi://*' --outfile=/tmp/glass.js
 *                (gjs cannot import TypeScript; the bundle is the whole reason
 *                for the indirection. `--external:'gi://*'` keeps the GI imports
 *                resolving at runtime.) It used to also need
 *                `--alias:ags/gtk4=…` pointing at a shim, because that import
 *                was a path only the AGS runtime could resolve; ui/lib imports
 *                `gi://Gtk?version=4.0` directly now, so the alias and the shim
 *                are both gone.
 *   KIT=<path>   a BUNDLED ui/lib/nidara-kit/scrolled.js, to build the three
 *                selectors with the real `NidaraDropDown`. Without it they are
 *                bare `Gtk.DropDown`s and the kit's construction-time work — the
 *                list factory, `adoptGtkScrolled` — never runs. See below.
 *   W, H         surface size, used only when FULLSCREEN=0. Both real surfaces
 *                cover the screen, so the probe fullscreens by default: on a
 *                TILING compositor W/H are a request that gets ignored anyway,
 *                and at the wrong height the card lands on top of the clock —
 *                a layout verdict that is entirely the probe's fault. Set
 *                FULLSCREEN=0 to inspect a component at an arbitrary size.
 *
 * ⚠️ TWO THINGS TO KNOW BEFORE READING A NUMBER OFF IT.
 *
 * 1. `gtk4-broadwayd` is documented above because that is the intended offscreen
 *    path, but Arch's gtk4 4.22 has no working broadway CLIENT backend — the
 *    daemon starts, `GDK_BACKEND=broadway` then fails with "Failed to open
 *    display". So in practice this runs on the LIVE session and flashes a real
 *    window for ~0.7s per render. That is the whole intrusion; nothing is
 *    locked, logged out or restarted.
 * 2. Consequently a TILING compositor sizes the window, which is why the default
 *    is fullscreen — the only reliable way to get the real aspect ratio, and the
 *    honest one, since both surfaces really are fullscreen. It does mean the
 *    flash covers the screen for that ~0.7s. With FULLSCREEN=0 the window is
 *    whatever the layout gives it, so **crop from the bounds this script prints,
 *    never from a remembered offset**.
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
// Shipped Lucide glyphs, resolved exactly as ui/lib/icons.ts does at runtime.
const ICON_DIR = `${GLib.getenv("NIDARA_SHELL_ROOT") ?? "/usr/share/nidara/ui/shell"}/assets/icons/hicolor/scalable/actions`
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
// The painter, when a bundle was passed. `wrap` is the identity function
// otherwise, so the specimen below reads the same either way.
let wrap = (w) => w
const PAINTER = GLib.getenv("PAINTER")
if (PAINTER) {
    const mod = await import(`file://${PAINTER}`)
    if (GLib.file_test(BG, GLib.FileTest.EXISTS) && SCOPE === "lock") mod.setCapsuleBackdrop(BG)
    wrap = (w, rim = "subtle", followFocus = false) => mod.withGlassCapsule(w, rim, followFocus)
    print(`[painter] ${PAINTER}${SCOPE === "lock" ? " (with backdrop)" : ""}`)
}

// KIT=<bundled ui/lib/nidara-kit/scrolled.js> — build the three selectors with the
// REAL `NidaraDropDown` instead of a bare `Gtk.DropDown`. Added 2026-08-10 with
// the greeter's adoption of the kit, and the gap it closes is worth stating: this
// probe REBUILDS the widget tree, it does not import LoginCard, so a stylesheet
// can be proven pixel-identical here while the code path that actually ships was
// never once executed. `NidaraDropDown` swaps the list factory and re-parents
// GTK's ScrolledWindow into an overlay (`adoptGtkScrolled`) — construction-time
// work on a surface where a thrown error is a login screen that does not appear.
// Same bundling indirection as PAINTER, same reason (gjs cannot import TS):
//   npx --yes esbuild ui/lib/nidara-kit/scrolled.ts --bundle --format=esm \
//     --external:'gi://*' --outfile=/tmp/kit.js
let makeDropDown = (strings) => Gtk.DropDown.new_from_strings(strings)
const KIT = GLib.getenv("KIT")
if (KIT) {
    const kit = await import(`file://${KIT}`)
    makeDropDown = (strings) => kit.NidaraDropDown({ model: Gtk.StringList.new(strings) })
    print(`[kit] ${KIT} → NidaraDropDown`)
}


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
card.append(wrap(entry, "subtle", true))
card.append(wrap(new Gtk.Button({
    label: "Desbloquear", css_classes: ["greeter-login-btn"],
    halign: Gtk.Align.CENTER, width_request: 280, margin_top: 8,
}), "strong"))
// ERROR=1 renders the failure line, hidden at rest in the real card, because
// "does the card still hold together when it is there" is a layout question
// nothing else answers.
//
// CAPS=1 no longer builds a warning of our own — neither surface has one. It
// force-shows `Gtk.PasswordEntry`'s `image.caps-lock-indicator`, which is the
// only one left, because GTK drives that node from the REAL keyboard and a probe
// should not need you to press Caps Lock to render a state.
if (SCOPE === "greeter") {
    // Session selector — a set-once control, kept visually subordinate to the
    // password field. Gtk.DropDown for real: it is the widget whose focus ring
    // and popover styling this sheet spends most of its lines on.
    const drop = makeDropDown(["Nidara", "Hyprland", "GNOME"])
    drop.add_css_class("greeter-session-dropdown")
    const dropWrap = wrap(drop)
    dropWrap.halign = Gtk.Align.CENTER
    dropWrap.margin_top = 14
    card.append(dropWrap)
}
if (GLib.getenv("ERROR")) {
    const errWrap = wrap(new Gtk.Label({
        label: "Contraseña incorrecta", css_classes: ["greeter-error"],
        wrap: true, halign: Gtk.Align.CENTER,
    }))
    errWrap.halign = Gtk.Align.CENTER
    errWrap.margin_top = 6
    card.append(errWrap)
}
if (SCOPE === "greeter") {
    // Multi-user switcher — only built when more than one human user exists, so
    // most dev boxes never see it. USERS=<n> forces it.
    const n = parseInt(GLib.getenv("USERS") || "0", 10)
    if (n > 1) {
        const switcher = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 10,
            halign: Gtk.Align.CENTER, margin_top: 18,
            css_classes: ["greeter-user-switcher"],
        })
        for (let i = 0; i < n; i++) {
            const chipAvatar = new Gtk.Box({
                width_request: 36, height_request: 36,
                css_classes: ["greeter-chip-avatar", "greeter-avatar-fallback"],
            })
            switcher.append(new Gtk.ToggleButton({
                child: chipAvatar, active: i === 0, css_classes: ["greeter-user-chip"],
            }))
        }
        card.append(switcher)
    }
}

// Power bar — PowerBar.ts. ICONS=1 loads the shipped Lucide glyphs the way
// ui/lib/icons.ts does at runtime, which is the only way to see whether the
// `nd-icon` invert actually lands (they render BLACK unloaded, so a missing
// invert is invisible in the source and obvious here). Off by default: a
// missing-glyph placeholder measures differently from the real thing, and the
// type questions this probe exists for are about the labels.
const POWER_ICONS = { Suspender: "moon", Reiniciar: "rotate-ccw", Apagar: "power" }
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

// Locale bar — greeter only, bottom-left. Two dropdowns and a separator inside
// a painted pill; it is the last thing on either screen that was CSS-drawn.
const localeBar = (() => {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
        halign: Gtk.Align.START, valign: Gtk.Align.END,
        margin_start: 40, margin_bottom: 40,
        css_classes: ["locale-bar"],
    })
    const icon = new Gtk.Image({ pixel_size: 12, css_classes: ["locale-bar-icon"] })
    const glyph = `${ICON_DIR}/keyboard.svg`
    if (GLib.file_test(glyph, GLib.FileTest.EXISTS)) {
        icon.gicon = Gio.FileIcon.new(Gio.File.new_for_path(glyph))
        icon.add_css_class("nd-icon")
    }
    row.append(icon)
    const kb = makeDropDown(["es", "us"])
    kb.add_css_class("locale-bar-dropdown")
    row.append(kb)
    row.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["locale-bar-sep"] }))
    const lang = makeDropDown(["Español", "English"])
    lang.add_css_class("locale-bar-dropdown")
    row.append(lang)
    return row
})()

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
overlay.add_overlay(wrap(powerBar))
// Kept in a variable, not inlined into add_overlay: the LOCALE BAR block below
// measures the CAPSULE, and the capsule is what `wrap` returns — the row inside
// it knows nothing about where its own edges ended up.
const localeCapsule = SCOPE === "greeter" ? wrap(localeBar) : null
if (localeCapsule) overlay.add_overlay(localeCapsule)
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

if (GLib.getenv("FULLSCREEN") !== "0") win.fullscreen()
win.present()
const loop = GLib.MainLoop.new(null, false)

// CAPS=1 — force GTK's own indicator on, in its own frame.
//
// Two constraints fix the timing, and both cost a run to find. It cannot be set
// at construction: GTK re-syncs the node from the REAL keyboard when the entry
// is mapped, undoing it. And it cannot be set immediately before the snapshot:
// showing a child queues a resize, and the snapshot then comes back EMPTY —
// `savePng` prints "nothing drawn" and every crop is missing. So it goes in a
// timeout of its own, after the map and well before the render.
if (GLib.getenv("CAPS")) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
    let c = entry.get_first_child()
    while (c) {
        if (c.get_css_classes().includes("caps-lock-indicator")) { c.set_visible(true); break }
        c = c.get_next_sibling()
    }
    if (!c) print("  ! no caps-lock-indicator node found")
    return GLib.SOURCE_REMOVE
})

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

    if (localeCapsule) {
        // ── LOCALE BAR ───────────────────────────────────────────────────────
        // The question this answers is INK-TO-EDGE, not box-to-edge. A capsule's
        // padding is the right inset for a child that paints its own fill (the
        // dropdown's hover pill, which must sit concentrically inside the outer
        // pill) and the WRONG one for bare ink, which has nothing between itself
        // and the cap's curve. So print both: each child's box, and then where
        // the visible ink actually starts and ends.
        print("\n═══ LOCALE BAR ═══")
        const cap = boundsIn(localeCapsule, win)
        print(`capsule       ${fmt(cap)}`)
        const names = ["kb icon", "kb dropdown", "separator", "language"]
        const kids = []
        for (let c = localeBar.get_first_child(); c; c = c.get_next_sibling()) kids.push(c)
        kids.forEach((k, n) => print(`  ${(names[n] ?? `child ${n}`).padEnd(12)} ${fmt(boundsIn(k, win))}`))

        // Drill to the first LABEL inside a dropdown — that is its real ink.
        const labelIn = (w) => {
            if (w instanceof Gtk.Label) return w
            for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
                const found = labelIn(c)
                if (found) return found
            }
            return null
        }
        const icon = kids[0], lang = kids[3], kb = kids[1]
        const ib = boundsIn(icon, win), lb = boundsIn(lang, win)
        const kbLabel = kb ? labelIn(kb) : null
        const klb = kbLabel ? boundsIn(kbLabel, win) : null
        if (cap && ib && lb) {
            print(`\nink insets — LEFT ${Math.round(ib.x - cap.x)}px (icon)`
                + `   RIGHT ${Math.round((cap.x + cap.w) - (lb.x + lb.w))}px (dropdown box)`)
            if (klb) print(`dropdown's own ink starts ${Math.round(klb.x - boundsIn(kb, win).x)}px inside its box`
                         + ` → ${Math.round(klb.x - cap.x)}px from the capsule edge`)
        }
        savePng(localeCapsule, `${OUT}-locale.png`)
    }

    savePng(overlay, `${OUT}.png`)
    savePng(card, `${OUT}-card.png`)
    savePng(clockBox, `${OUT}-hero.png`)

    win.close()
    loop.quit()
    return GLib.SOURCE_REMOVE
})

loop.run()
