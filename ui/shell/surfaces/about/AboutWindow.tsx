import app from "../../../lib/host"
import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import Gio from "gi://Gio"
import { NidaraButton, NidaraClamp, NidaraWindow, type NidaraWindowResult } from "../../../lib/nidara-kit"
import IconButton from "../../common/IconButton"
import status from "../../core/Status"
import shellActions from "../../core/ShellActions"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import { SHELL_ROOT, readShellVersion } from "../../core/Paths"
import { safeDisconnect } from "../../core/signals"
import * as sys from "../../core/SystemInfo"

// ── Row builders ───────────────────────────────────────────────────────────────

/**
 * The key column is not a fixed width: every key label joins a horizontal
 * `Gtk.SizeGroup`, so the column IS the widest key, in whatever language the
 * shell happens to be running.
 *
 * It used to be a constant, and a constant is a locale bug with a delay on it.
 * Measured (`text-budget.js`'s rig, re-pointed at this window's scope, shipped
 * font): the widest key is 53px in Chinese, 102px in English — "Operating
 * system" — and 150px in French ("Temps de fonctionnement"). Against a fixed 80
 * the block was aligned in English and ragged in nine of the twelve locales,
 * because an over-wide key is not clipped here: it pushes its own value right and
 * that row alone falls out of line. Nobody saw it because English fit.
 *
 * `.about-spec-key`'s `min-width` stays as the FLOOR (a Chinese column of 53px
 * would crowd the values); the size group only ever grows past it.
 */
const KEY_GUTTER = 8

/**
 * The card's width, and it is a CEILING as well as a floor — but nothing here is
 * ever CUT to respect it. Owner's rule, 2026-08-25: *"no vamos a cortar la
 * información que el usuario quiere consultar"* — this window exists to be read,
 * so a value that does not fit takes a second line, it does not lose its tail.
 *
 * `width_request` alone is only the floor: GTK sizes an undecorated window to its
 * content's NATURAL width, and a `Gtk.Label` reports its whole string as natural.
 * So without a ceiling one long value decides how wide this window is — the raw
 * GPU row stretched the card to ~750px on this host.
 *
 * ⚠️ Neither `ellipsize` nor `max_width_chars` may be the ceiling. `max-width-chars`
 * caps what GTK4 ELLIPSIZES to, not just what the label requests, so it both cut the
 * value AND left the column half empty ("AMD Ryzen 5 5…" with 236px going spare).
 * The ceiling is the PARENT — `NidaraClamp`, min = max — and the values WRAP into
 * whatever the row leaves them (`WORD_CHAR`, so a device name with no spaces breaks
 * too rather than overflowing).
 *
 * 460 is measured, not chosen: at `.about-spec-val` in the shipped font this host's
 * GPU string needs 302px and its CPU 222px, against a key column that runs 89px
 * (zh-CN) to 143px (ja "オペレーティングシステム"). 460 − 32 margins − 8 gutter
 * leaves 316px in English and 277px in Japanese, so every CPU and the common GPU
 * names sit on one line everywhere, and the multi-SKU AMD string takes two lines in
 * the three widest-key locales. Widening until THAT never happened would mean a
 * ~500px card and still no guarantee — some device names are longer than any width
 * one picks, which is exactly why wrapping is the mechanism and the width is only
 * the comfort.
 */
const CARD_WIDTH = 460

/**
 * A value: wraps, never ellipsises, and FILLS its column — `halign: START` would
 * allocate it Pango's line-balancing natural width instead of the card's, which is
 * the rule `scripts/ci/wrapping-prose-check.mjs` enforces repo-wide.
 */
const valueLabel = (text: string): Gtk.Label => new Gtk.Label({
    label: text,
    css_classes: ["about-spec-val"],
    halign: Gtk.Align.FILL, hexpand: true, xalign: 0,
    wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
})

/** A key: one line, and pinned to the TOP so it stays level with the first line of
 *  a value that wrapped. */
const keyLabel = (keyCol: Gtk.SizeGroup, label: string): Gtk.Label => {
    const key = new Gtk.Label({
        label, css_classes: ["about-spec-key"],
        halign: Gtk.Align.START, valign: Gtk.Align.START, xalign: 0,
    })
    keyCol.add_widget(key)
    return key
}

function specRow(keyCol: Gtk.SizeGroup, label: string, value: string): Gtk.Box {
    const box = new Gtk.Box({ spacing: KEY_GUTTER, margin_top: 4, margin_bottom: 4 })
    box.append(keyLabel(keyCol, label))
    box.append(valueLabel(value))
    return box
}

function asyncSpecRow(keyCol: Gtk.SizeGroup, label: string, src: Promise<string>): Gtk.Box {
    const val = valueLabel("…")
    // `core/SystemInfo` never rejects and answers "" for unknown, so the only
    // fallback left is the one both surfaces share.
    src.then(v => { val.label = v || t("settings.about.unavailable") })
    const box = new Gtk.Box({ spacing: KEY_GUTTER, margin_top: 4, margin_bottom: 4 })
    box.append(keyLabel(keyCol, label))
    box.append(val)
    return box
}

/** A sync value, with the same "" → placeholder contract as the async rows. */
const shown = (v: string): string => v || t("settings.about.unavailable")

// ── Singleton guard ─────────────────────────────────────────────────────────────
let _instance: Gtk.Window | null = null

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Creates and presents the About window. If already open, brings it to front.
 * The window is DESTROYED (not hidden) on close so it doesn't block `ags quit`.
 * Call this from a status.connect("notify::about-open") listener in app.ts.
 */
export default function AboutWindow(): Gtk.Window | null {
    if (_instance) {
        _instance.present()
        return _instance
    }

    // Every key label joins this, so the value column starts at the same x on
    // every row whatever the locale does to the words. See the note above it.
    const keyCol = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL })

    // ── Header ────────────────────────────────────────────────────────────────
    // The Nidara mark, not a `distributor-logo-<id>` theme icon: that depends on
    // whatever icon pack is installed and renders broken on a clean machine (e.g.
    // the VM has no Arch distributor logo). Our own mark always resolves and is
    // mode-aware (recoloured to --nidara-text via .about-logo). 72px is a big
    // surface so the flattened-but-faithful symbolic mark looks identical to the goo.
    const markPath = `${SHELL_ROOT}/assets/nidara/assets/nidara-symbolic.svg`
    const headerBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, halign: Gtk.Align.CENTER, margin_bottom: 16 })
    headerBox.append(new Gtk.Image({ gicon: Gio.FileIcon.new(Gio.File.new_for_path(markPath)), pixel_size: 72, css_classes: ["about-logo"], halign: Gtk.Align.CENTER }))
    // The name under the mark is the DESKTOP's, and nothing else goes here. The
    // operating system used to be printed underneath it, and that stacking made a
    // claim the layout had no business making: on somebody's Arch it read
    // "Nidara / Arch Linux", as if the two were one thing, and on the product it
    // said the word twice. It is a labelled row now, in the block where the other
    // versions live — a fact among facts, not part of the brand.
    headerBox.append(new Gtk.Label({ label: "Nidara", css_classes: ["about-shell-name"], halign: Gtk.Align.CENTER }))

    // ── What this computer is ─────────────────────────────────────────────────
    // This window is the SHORT one, deliberately: the machine, the system it
    // runs, and the desktop's own version — the four or five facts somebody
    // opens "About This Computer" to read. Kernel, uptime, Hyprland, GTK and GJS
    // used to be here too; they are diagnostics, they belong to the page that can
    // afford them, and Settings → About now holds a strict SUPERSET of this
    // window. That is the rule (owner's call, 2026-08-25, closing debt #94):
    // window = glanceable summary + a way through, page = the whole detail.
    // macOS draws the same line — "About This Mac" is a card with More Info…
    // under it, and the full list lives in System Settings.
    //
    // Device (hostname) first, like GNOME/Windows About: it disambiguates the
    // machine's name from "Nidara" in the header, which is the desktop, not the box.
    const specsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, margin_top: 8, margin_bottom: 8, margin_start: 16, margin_end: 16 })
    specsBox.append(specRow(keyCol, t("settings.about.device"), shown(sys.deviceName())))
    specsBox.append(specRow(keyCol, t("settings.about.cpu"), shown(sys.cpuModel())))
    specsBox.append(specRow(keyCol, t("settings.about.ram"), shown(sys.totalRam())))
    specsBox.append(asyncSpecRow(keyCol, t("settings.about.graphics"), sys.graphics()))

    // ── The two versions ──────────────────────────────────────────────────────
    // Adjacent and each saying which thing it counts — that adjacency is the
    // whole reason this window exists in PRODUCT.md.
    //
    // OS: whatever /etc/os-release calls this machine. "Nidara 0.1.0" on the
    // product (the `nidara-release` package owns that file), "Arch Linux" on
    // somebody's own Arch running install.sh — both true, and the second is a
    // supported outcome, not a fallback.
    //
    // Nidara Desktop: this tree's VERSION in a dev checkout, /usr/share/nidara's
    // copy when installed. It is a proper noun, so no translation key, and it is
    // the one place in this window where that name is the right one.
    //
    // Neither number derives from the other, which is why both rows are labelled:
    // "0.1.0" and "0.8.1" under one brand read as a contradiction unless each says
    // what it is counting.
    const verBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, margin_top: 8, margin_bottom: 8, margin_start: 16, margin_end: 16 })
    verBox.append(specRow(keyCol, t("settings.about.os"), shown(sys.osName())))
    verBox.append(specRow(keyCol, "Nidara Desktop", readShellVersion()))

    // ── The way through to the detail ─────────────────────────────────────────
    // Without this the summary is a dead end and the rows it dropped are simply
    // gone as far as the person reading is concerned. `openSettingsPage` raises
    // Settings (creating it if needed) and navigates it; the About window stays
    // open behind it, the same way macOS leaves the card up.
    const moreBtn = NidaraButton({ label: t("settings.about.more-info"), halign: Gtk.Align.CENTER })
    moreBtn.margin_top = 16
    moreBtn.connect("clicked", () => { shellActions.openSettingsPage?.("about") })

    // ── Close button ──────────────────────────────────────────────────────────
    // Same kit IconButton as the Settings header close. margin_top 12 + the
    // card's margin_top 12 = 24px top gap, equal to the card's 24px end margin
    // (the corner-diagonal rule the Settings close follows too).
    const closeBtn = IconButton({
        icon: Icons.close,
        iconSize: 14,
        variant: "danger",
        tooltip: t("settings.about.close"),
        tooltipChrome: false,   // app-mode window: tooltip follows the system mode
        halign: Gtk.Align.END,
        // The window's own close path, not a status write: the button, Escape and
        // the compositor's close request all end in the same place — see the
        // NidaraAppWindow call below. A thunk because the window is built after.
        onClick: () => shell.close(),
    })
    closeBtn.margin_top = 12

    // ── Card ──────────────────────────────────────────────────────────────────
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 12, margin_bottom: 24, margin_start: 24, margin_end: 24, width_request: CARD_WIDTH })
    card.append(closeBtn)
    card.append(headerBox)
    card.append(specsBox)
    card.append(new Gtk.Separator({ css_classes: ["about-sep"], margin_top: 8, margin_bottom: 8 }))
    card.append(verBox)
    card.append(moreBtn)

    // Window chrome = the SAME CSS glass as Settings (.nidara-window-glass →
    // glass(floating)), NOT a Cairo SquircleContainer. A real window already gets
    // Hyprland's 1px border + rounding at its rect; the Cairo card was drawn 2px
    // inside that rect (drawSquircle techInset) and gloss paints its own 1px
    // specular rims regardless of borderColor — together they read as a double
    // border no borderColor tweak can turn off. The CSS route also makes the
    // About follow the user's window-opacity token instead of a hardcoded alpha.
    // ── Window ────────────────────────────────────────────────────────────────
    // The kit's window: the undecorated toplevel, the glass card, the per-window
    // app-id, Escape, and ONE close path that the card's button, the compositor's
    // request and the status flag all go through. About passes no `header` — its
    // close button lives INSIDE the card, on the corner diagonal — and no
    // `sidebar`, which is the only thing that would make it the two-pane layout.
    //
    // Float + center come from a static window rule in hyprland.lua (matched by the
    // "About Nidara" title). The old `hyprctl keyword windowrulev2` calls here
    // were rejected by the Lua parser ("Use eval.") and have been removed.
    let sigId = 0
    let shell: NidaraWindowResult
    shell = NidaraWindow({
        app,
        title: "About Nidara",
        name: "nidara-about",
        // Deliberately the SAME app-id as the Settings window: About is opened from
        // Settings, has no desktop entry of its own, and under AGS both windows
        // already resolved to `nidara-settings` through AppService's remap. Giving
        // it a name of its own here would only cost it its icon everywhere.
        appId: "nidara-settings",
        cssClasses: ["about-floating-window"],
        glassClasses: ["about-window-card"],
        // min = max = CARD_WIDTH: the clamp is the ceiling the card's own
        // `width_request` cannot be (see the note on the constant).
        content: NidaraClamp(card, CARD_WIDTH + 48, false, CARD_WIDTH + 48),
        resizable: false,
        closeOnEscape: true,
        // DESTROY, not hide: a hidden window keeps the application alive.
        closeMode: "destroy",
        onClose: () => {
            if (sigId) safeDisconnect(status, sigId)
            _instance = null
            // Runs BEFORE the destroy, so the listener below sees `_instance`
            // already null and does not ask to close a window that is closing.
            status.about_open = false
        },
    })
    const win = shell.window
    _instance = win

    // Closed from elsewhere (the Settings row, an IPC action) — same path.
    sigId = status.connect("notify::about-open", () => {
        if (!status.about_open && _instance === win) shell.close()
    })

    win.present()
    return win
}
