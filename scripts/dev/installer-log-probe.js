#!/usr/bin/env gjs -m
/*
 * installer-log-probe — what the installer's log view does to a line of real
 * TTY output, rendered offscreen, with and without the fix.
 *
 *   gtk4-broadwayd :5 &                        # offscreen display, once
 *   GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 \
 *     gjs -m scripts/dev/installer-log-probe.js /tmp/installer-log
 *
 * Why this exists. The installer ships only on the live medium and must never be
 * launched on a development machine (dev-workflow.md, "The installer runs in a
 * VM"), so its log — the one surface that shows another program's output — had
 * the longest feedback loop in the project: build an ISO, boot it, look. Two of
 * the defects found by doing exactly that on 2026-08-30 were in this view, and
 * neither needed a disk, an installer or an archinstall to see.
 *
 * So this builds JUST that view — the real `installer-log-card` / `-log-view`
 * classes, the real compiled `style.css` — and feeds it REAL bytes: the sample
 * below was captured with `script -qec 'pacman -Qi bash' /dev/null`, which is
 * how every child of the installer writes, because every one of them thinks it
 * is talking to a terminal.
 *
 * It writes two PNGs, and the pair IS the measurement: `-raw` is the view as it
 * shipped, `-fixed` is the same bytes through `stripAnsi`. A change that claims
 * to clean the log has to make those two differ.
 *
 * ⚠️ WHAT IT CANNOT ANSWER: which FONT a user gets. The family is resolved by
 * fontconfig on the machine doing the rendering, so a dev box without
 * `ttf-jetbrains-mono` renders a substitute and the PNG is honest only about
 * layout. The probe prints the family Pango actually loaded and stamps the image
 * when it is not the one the sheet asked for — that mismatch is the whole bug
 * (design-system.md, "A generic font alias is a value fontconfig chooses"), so
 * it must never be silent in an image that outlives this terminal.
 */

import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gsk from "gi://Gsk"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Pango from "gi://Pango"
import Graphene from "gi://Graphene"

const OUT = ARGV[0] ?? "/tmp/installer-log"
const SCRIPTS = GLib.path_get_dirname(GLib.path_get_dirname(import.meta.url.replace("file://", "")))
// The COMPILED sheet, which is git-ignored — the probe is worthless against a
// stale one and silent about it, because a CssProvider that cannot read its file
// only warns.
const SHEET = `${SCRIPTS}/../ui/installer/style.css`

// Real bytes, captured through a pty. `\x1b[?25l` is the cursor pacman hides on
// the way in, `\x1b[0;1m` its bold, and the trailing `\r` is what a CRLF stream
// leaves on every single line once `read_line` has taken the LF.
const PACMAN = [
    "\x1b[?25l\x1b[0;1mName                      :\x1b[0m bash\r",
    "\x1b[0;1mVersion                   :\x1b[0m 5.3.15-1\r",
    "\x1b[0;1mDescription               :\x1b[0m The GNU Bourne Again shell\r",
    "\x1b[0;1mInstalled Size            :\x1b[0m 8,79 MiB\r",
    // A progress bar: one line, redrawn from column zero on every update. Only
    // the last take is still on a terminal's screen when the LF finally lands.
    "\r 767465472 bytes (767 MB) copied, 1 s\r1536321024 bytes (1,5 GB) copied, 2 s",
    "\x1b[?25h",
    "[EXEC] archinstall --config /tmp/nidara-plan-0.json --silent",
]

// A COPY of ui/installer/lib/ansi.ts, on purpose: this probe has to be runnable
// against a checkout where the fix is not applied yet (that is what makes the
// `-raw` half a control rather than a story). If the two ever disagree, the
// module is right and this is stale — the module is the one that ships.
function stripAnsi(line) {
    const plain = line
        .replace(/\x1b\[[0-?]*[ -/]*(?:[@-~]|$)/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
        .replace(/\x1b[()#][0-9A-Za-z]|\x1b[@-Z\\-_0-9<=>]|\x1b/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    const drawn = plain.replace(/\r+$/, "")
    return drawn.slice(drawn.lastIndexOf("\r") + 1).replace(/\s+$/, "")
}

Gtk.init()

if (!GLib.file_test(SHEET, GLib.FileTest.EXISTS)) {
    printerr(`no compiled sheet at ${SHEET}\n` +
             "  cd ui/installer && npx --yes sass@1.97.3 --no-charset style.scss style.css")
    imports.system.exit(1)
}
const provider = Gtk.CssProvider.new()
provider.load_from_path(SHEET)
Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)

// The installer's own tokens are emitted at runtime by installAppearance(); the
// two this view paints with are all it needs, and giving them literal values
// here keeps the probe from depending on a user's appearance.json.
const tokens = Gtk.CssProvider.new()
tokens.load_from_string(`* {
    --nidara-surface: rgba(30, 30, 34, 0.92);
    --nidara-border: rgba(127, 127, 127, 0.15);
    --nidara-text-secondary: rgba(255, 255, 255, 0.72);
    --nidara-radius-md: 12px;
}`)
Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(), tokens, Gtk.STYLE_PROVIDER_PRIORITY_USER + 20)

function logView(lines) {
    const buffer = Gtk.TextBuffer.new(null)
    buffer.set_text(lines.join("\n"), -1)
    const view = new Gtk.TextView({
        buffer,
        editable: false,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.CHAR,
        monospace: true,
        hexpand: true,
        css_classes: ["installer-log-view"],
    })
    const card = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["installer-log-card"],
        hexpand: true,
    })
    card.append(view)
    return { view, card }
}

const raw = logView(PACMAN)
const fixed = logView(PACMAN.map(stripAnsi).filter((l, i) => l !== "" || PACMAN[i] === ""))

const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24, margin_top: 24,
                          margin_bottom: 24, margin_start: 24, margin_end: 24 })
box.append(raw.card)
box.append(fixed.card)

const win = new Gtk.Window({ title: "installer-log-probe", child: box,
                             default_width: 900, default_height: 520 })
win.add_css_class("nidara-installer-window")

function stamp(snapshot, w, text) {
    const rect = new Graphene.Rect()
    rect.init(0, 0, Math.min(w, 1200), 26)
    const cr = snapshot.append_cairo(rect)
    cr.selectFontFace("monospace", 0, 1)
    cr.setFontSize(14)
    cr.setSourceRGBA(0, 0, 0, 0.6)
    cr.rectangle(0, 0, Math.min(w, 1200), 26)
    cr.fill()
    cr.setSourceRGBA(1, 0.75, 0.2, 1)
    cr.moveTo(8, 18)
    cr.showText(`[installer-log-probe] ${text}`)
    cr.$dispose()
}

function savePng(widget, path, note) {
    const w = widget.get_width(), h = widget.get_height()
    if (w <= 0 || h <= 0) return print(`  ! ${path}: unallocated`)
    const snapshot = Gtk.Snapshot.new()
    // The band gets its OWN strip above the widget rather than being laid over
    // it: lock-probe.js can put its stamp in a corner both its surfaces leave
    // empty, and a log view has no such corner — the first line is where the
    // evidence is.
    const band = note ? 30 : 0
    if (band) {
        const shift = new Graphene.Point()
        shift.init(0, band)
        snapshot.save()
        snapshot.translate(shift)
    }
    Gtk.WidgetPaintable.new(widget).snapshot(snapshot, w, h)
    if (band) {
        snapshot.restore()
        stamp(snapshot, w, note)
    }
    const node = snapshot.to_node()
    if (!node) return print(`  ! ${path}: nothing drawn`)
    const renderer = Gsk.CairoRenderer.new()
    renderer.realize(null)
    renderer.render_texture(node, null).save_to_png(path)
    // Same trap as gtk-probe.js / lock-probe.js: a realized renderer reaching
    // the GC aborts the process before a second frame is ever written.
    renderer.unrealize()
    print(`  → ${path} (${w}x${h})`)
}

win.present()

// ⚠️ 1500 ms, and it is not padding. At 600 ms the window reports `mapped=true`
// while every child still measures 0×0, and `savePng` writes nothing but a line
// saying "unallocated" — a probe that looks like it ran and produced no evidence.
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
    // What the sheet asked for vs. what Pango loaded. On a machine carrying
    // ttf-jetbrains-mono these are the same string; the interesting run is the
    // one where they are not.
    const ctx = fixed.view.get_pango_context()
    const asked = ctx.get_font_description().get_family()
    const got = ctx.load_font(ctx.get_font_description()).describe().get_family()
    print("\n═══ FONT ═══")
    print(`asked for : ${asked}`)
    print(`resolved  : ${got}`)
    const mismatch = got.replace(/\s+/g, "").toLowerCase() !==
                     String(asked).split(",")[0].replace(/["\s]/g, "").toLowerCase()
    if (mismatch) print("  ! fontconfig substituted — the PNGs are honest about LAYOUT only")

    const note = mismatch ? `font is ${got}, NOT ${asked} — layout only` : null
    print("\n═══ RENDER ═══")
    // Printed because it is the answer when a render comes back "unallocated":
    // a mapped window whose children are 0-sized is a timing problem, an
    // unmapped one is a display problem.
    print(`  win ${win.get_width()}x${win.get_height()} mapped=${win.get_mapped()}`)
    savePng(raw.card, `${OUT}-raw.png`, note)
    savePng(fixed.card, `${OUT}-fixed.png`, note)

    print("\n═══ TEXT ═══")
    print("raw   |" + PACMAN[0])
    print("fixed |" + stripAnsi(PACMAN[0]))
    win.close()
    loop.quit()
    return GLib.SOURCE_REMOVE
})

const loop = GLib.MainLoop.new(null, false)
loop.run()
