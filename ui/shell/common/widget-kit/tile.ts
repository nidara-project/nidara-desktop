// ─────────────────────────────────────────────────────────────────────────────
// The tile vocabulary — the shapes a widget's Control-Centre content can take.
//
// This lived in surfaces/control-center/Toggles.tsx, which is where twelve of the
// sixteen widgets went to find out how to draw themselves: the file that owned the
// look of every tile was filed under the surface that happens to host them, and the
// bar imports the same widgets. It is the kit's now, and there is one list.
//
// Six words, and picking one is the whole of laying a tile out:
//
//   1×1   makeIconTile        a status icon, no interaction
//         makeRoundTile       a round toggle button
//   2×1   makeCapsuleTile     icon circle + title/subtitle; the tile opens the detail
//         makeSplitCapsuleTile  …but the icon badge toggles, the rest opens the detail
//   4×1   makeHSliderTile     a slider between two end icons, with a live %
//   any   makeCapsuleInner    the building block, for content that must reach the refs
//         wrapCapsuleTile     …and its outer box, for a tile that builds its own
//
// The 1×2 slider has no word here on purpose: it is `makeVerticalFillTile`, already
// in ui/lib/nidara-kit because the fill IS the tile. `Sliders.tsx` wrapped it in five
// lines that added nothing, which is why volume and brightness looked like they had
// two different vertical sliders.
//
// plus `roundToggleSpec`, a whole CCWidgetSpec for a widget that is nothing BUT a
// round toggle (dark mode).
//
// Leaf module — no shell imports. See panel.ts for the cycle that crashes the boot.
// ─────────────────────────────────────────────────────────────────────────────
import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import { makeHSlider } from "../../../lib/nidara-kit"
import { CCWidgetSpec, WidgetSize } from "./contract"

/** Arm a live-state subscription and hand back its disposer. Every tile takes one
 *  optional: pass the service's own watcher (`Net.watchWifiNetwork`, …) and the tile
 *  re-reads its getters whenever it fires, disposing on `unrealize`. */
export type SubscribeFn = (sync: () => void) => () => void

function setIcon(img: Gtk.Image, icon: Gio.FileIcon) {
    // gicon assignment is NOT equality-guarded by GTK: reassigning the same icon
    // clears + redraws the image (tech-debt #11C). Every tile sync funnels through
    // here, so this one guard keeps generic-notify churn (wifi scans, NM property
    // noise) from queueing draws for icons that never changed — Icons.* are
    // module-load cached refs, so identity compare holds.
    if (img.gicon !== icon) img.gicon = icon
}

// ── 1×1 ───────────────────────────────────────────────────────────────────────

/** A status icon centred in a single cell — no click target. For a widget whose
 *  1×1 says something and does nothing (wifi, ethernet, vpn, screenrecord: their
 *  action lives in the detail panel, and a toggle here would be a second, invisible
 *  hit-region on top of the tile-level tap that opens it). */
export function makeIconTile(getIcon: () => Gio.FileIcon, subscribe?: SubscribeFn): Gtk.Widget {
    const box = new Gtk.Box({ hexpand: true, vexpand: true })
    const icon = new Gtk.Image({
        pixel_size: 28,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        css_classes: ["nd-icon"],
    })
    setIcon(icon, getIcon())
    box.append(icon)
    if (subscribe) {
        const dispose = subscribe(() => setIcon(icon, getIcon()))
        box.connect("unrealize", dispose)
    }
    return box
}

/** A round toggle button filling a single cell. */
export function makeRoundTile(
    getIcon: () => Gio.FileIcon,
    getActive: () => boolean,
    onClick: () => void,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const syncClasses = () => {
        btn.set_css_classes(getActive() ? ["nidara-atomic-round-btn", "active"] : ["nidara-atomic-round-btn"])
        setIcon(icon, getIcon())
    }
    const btn = new Gtk.Button({
        css_classes: getActive() ? ["nidara-atomic-round-btn", "active"] : ["nidara-atomic-round-btn"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({ pixel_size: 28, css_classes: ["nd-icon"] })
    setIcon(icon, getIcon())
    btn.set_child(icon)
    btn.connect("clicked", () => { onClick(); syncClasses() })
    if (subscribe) {
        const cleanup = subscribe(syncClasses)
        btn.connect("unrealize", cleanup)
    }
    return btn
}

// ── The capsule ───────────────────────────────────────────────────────────────

// Single source of truth for the 2×1 (WIDE) capsule inner layout: a 48px icon
// circle + title/subtitle stack. Every capsule form below is built on it, so every
// 2×1 widget is spaced and aligned identically. Keep this the *only* place these
// dimensions live.
export interface CapsuleInner {
    box: Gtk.Box
    iconBox: Gtk.Box
    icon: Gtk.Image
    label: Gtk.Label
    subLabel: Gtk.Label
    update: () => void
}

/** The capsule's innards, with its refs exposed and an `update()` that re-reads the
 *  getters. Reach for this only when a tile needs the refs themselves — screenrecord
 *  ticks the subtitle's digits without re-reading the icon, and restyles that one
 *  label. Everything else wants `makeCapsuleTile`. */
export function makeCapsuleInner(
    getIcon: () => Gio.FileIcon,
    getTitle: () => string,
    getSubTitle: () => string,
): CapsuleInner {
    // box fills the island (hexpand) so a non-expanding child isn't centred by the
    // SquircleContainer — that's what pushes a plain (non-button) tile to the right.
    // The expanding textStack then absorbs the trailing slack, pinning the icon hard
    // left. Works identically whether this box is the island's direct child (wifi,
    // ethernet, …) or nested inside a cc-capsule-btn.
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: true,
        margin_start: 4,
    })

    const iconBox = new Gtk.Box({
        css_classes: ["nidara-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
    })
    const icon = new Gtk.Image({ pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["nd-icon"] })
    setIcon(icon, getIcon())
    iconBox.append(icon)

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    const label = new Gtk.Label({ label: getTitle(), css_classes: ["nidara-atomic-label-bold"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 14 })
    const subLabel = new Gtk.Label({ css_classes: ["nidara-atomic-label-dim"], halign: Gtk.Align.START, xalign: 0, ellipsize: 3, max_width_chars: 14 })

    // Stateful vs stateless tile. A widget with an on/off-style status (wifi,
    // bluetooth, focus…) shows a single-line title + its state subtitle. An action
    // widget with no such state (screenshot, screen recording, clipboard) returns an
    // empty subtitle: we hide the sub line and let the title use both lines, kept
    // vertically centred — so the name reads in full ("Screen Recording") instead of
    // padding it out with a fake status line. Derived from the subtitle so dynamic
    // widgets (focus off → no sub) get the right shape too.
    const applySub = (sub: string) => {
        const hasSub = sub.length > 0
        subLabel.label = sub
        subLabel.visible = hasSub
        label.wrap = !hasSub        // lines only takes effect while wrapping
        label.lines = hasSub ? 1 : 2
    }

    textStack.append(label)
    textStack.append(subLabel)
    box.append(iconBox)
    box.append(textStack)
    applySub(getSubTitle())          // also primes tiles that never call update()

    const update = () => {
        setIcon(icon, getIcon())
        label.label = getTitle()
        applySub(getSubTitle())
    }
    return { box, iconBox, icon, label, subLabel, update }
}

/** The outer box a non-button capsule must be returned in. BaseIsland's
 *  SquircleContainer overwrites its direct child's margins with its 12px padding;
 *  the button-wrapped capsules survive that because the padding lands on the button
 *  and the inner box keeps its margin_start. Plain tiles need the same extra nesting
 *  level or their icon sits 4px further left. Only for a tile that builds its own
 *  box (battery's glyph row) — the capsule makers below already do this. */
export function wrapCapsuleTile(box: Gtk.Box): Gtk.Box {
    const outer = new Gtk.Box({
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })
    outer.append(box)
    return outer
}

/** The default 2×1: icon circle + title/subtitle, and NOTHING in it is a click
 *  target — the tile-level tap IslandGrid wires up opens the detail panel, and a
 *  button here would swallow it. The overwhelmingly common case. */
export function makeCapsuleTile(
    getIcon: () => Gio.FileIcon,
    getTitle: () => string,
    getSubTitle: () => string,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const inner = makeCapsuleInner(getIcon, getTitle, getSubTitle)
    if (subscribe) {
        const dispose = subscribe(inner.update)
        inner.box.connect("unrealize", dispose)
    }
    return wrapCapsuleTile(inner.box)
}

/** Split-target capsule: the icon badge is the ONLY click target (a quick toggle),
 *  the title/subtitle stay plain so the rest of the tile still opens the detail
 *  panel. For a widget that has both a one-tap action AND a `buildCCDetail`. */
export function makeSplitCapsuleTile(
    getIcon: () => Gio.FileIcon,
    getTitle: () => string,
    getSubTitle: () => string,
    onToggle: () => void,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const inner = makeCapsuleInner(getIcon, getTitle, getSubTitle)

    inner.iconBox.remove(inner.icon)
    const iconBtn = new Gtk.Button({ css_classes: ["cc-split-icon-btn"], hexpand: true, vexpand: true })
    iconBtn.set_child(inner.icon)
    inner.iconBox.append(iconBtn)

    iconBtn.connect("clicked", () => { onToggle(); inner.update() })
    if (subscribe) {
        const cleanup = subscribe(inner.update)
        inner.box.connect("unrealize", cleanup)
    }
    return wrapCapsuleTile(inner.box)
}

// Whole-capsule button. Private on purpose: it swallows the tile-level tap that
// opens a detail panel, so it is only correct for a widget that HAS no detail — and
// such a widget is a `roundToggleSpec`, which is how you reach this.
function makeButtonCapsuleTile(
    getIcon: () => Gio.FileIcon,
    getTitle: () => string,
    getSubTitle: () => string,
    onClick: () => void,
    getActive?: () => boolean,
    subscribe?: SubscribeFn,
): Gtk.Widget {
    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        hexpand: true, vexpand: true,
    })

    const inner = makeCapsuleInner(getIcon, getTitle, getSubTitle)
    btn.set_child(inner.box)

    const update = () => {
        inner.update()
        if (getActive) {
            if (getActive()) btn.add_css_class("active")
            else btn.remove_css_class("active")
        }
    }

    btn.connect("clicked", () => { onClick(); update() })
    if (subscribe) {
        const cleanup = subscribe(update)
        btn.connect("unrealize", cleanup)
    }
    update()
    return btn
}

// ── A whole widget, for the widgets that are only a toggle ────────────────────

/** The content half of a widget that is nothing but an on/off toggle: round button
 *  at 1×1, clickable capsule at 2×1 and 2×2. Returns a `CCWidgetSpec`, so the widget
 *  file adds only its registry metadata (id, category, placement) on top. */
export function roundToggleSpec(
    id: string,
    name: string,
    iconName: Gio.FileIcon | (() => Gio.FileIcon),
    active: boolean | (() => boolean),
    onClick: () => void,
    wideSubtitle?: () => string,
    subscribe?: SubscribeFn,
): CCWidgetSpec {
    const getActive = typeof active === "function" ? active : () => active
    const getIcon   = typeof iconName === "function" ? iconName : () => iconName
    const getSub    = wideSubtitle ?? (() => "")

    const buildContent = (size: WidgetSize): Gtk.Widget => {
        if (size === WidgetSize.SINGLE)
            return makeRoundTile(getIcon, getActive, onClick, subscribe)
        return makeButtonCapsuleTile(getIcon, () => name, getSub, onClick, getActive, subscribe)
    }

    return {
        id, name,
        defaultSize: WidgetSize.SINGLE,
        supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
        buildContent,
    }
}

// ── 4×1 ───────────────────────────────────────────────────────────────────────

/** One end of a horizontal slider tile. `size`/`opacity` default to the 16px at 0.6
 *  every end icon uses; override them only for a glyph whose ink fills its box
 *  differently — and say why, because that is how brightness came to carry a 14px at
 *  0.5 that nobody decided (see makeHSliderTile). */
export interface SliderEndIcon {
    icon: Gio.FileIcon
    size?: number
    opacity?: number
}

/** The FULL_WIDTH (4×1) slider tile: low icon, slider, high icon, right-aligned
 *  percentage. Everything here speaks 0..100 — a service that stores 0..1 (volume)
 *  converts at ITS edge, so the tile never has to know which.
 *
 *  It was `buildHorizontalSlider` inside surfaces/control-center/Sliders.tsx, which
 *  brightness could not reach from a widget file, so it grew a second copy: same box,
 *  same spacing, same margins, same value label, and a different pair of end-icon
 *  metrics. */
export function makeHSliderTile(opts: {
    low: SliderEndIcon
    high: SliderEndIcon
    /** 0..100 */
    getValue: () => number
    /** 0..100 */
    onChange: (pct: number) => void
    /** Arm the outside-the-widget sync and hand back its disposer. It must PRIME —
     *  push the current value on the way in, not only future changes: the kit's
     *  slider re-subscribes on every realize, so a hook that only forwards future
     *  changes leaves the slider showing whatever it was built with. That is how the
     *  Control Centre displayed 0% from login with the sink at 40% (0.7.1 VM sweep). */
    onExtChange: (cb: (pct: number) => void) => (() => void)
}): Gtk.Widget {
    const endIcon = (e: SliderEndIcon) => new Gtk.Image({
        gicon: e.icon,
        pixel_size: e.size ?? 16,
        opacity: e.opacity ?? 0.6,
        valign: Gtk.Align.CENTER,
        css_classes: ["nd-icon"],
    })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        css_classes: ["nidara-atomic-slider-box-horizontal"],
        halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER,
        hexpand: true, vexpand: false,
        margin_start: 4, margin_end: 4,
    })

    const valueLabel = new Gtk.Label({
        label: `${Math.round(opts.getValue())}%`,
        css_classes: ["slider-value-label"],
        width_chars: 5, xalign: 1.0, valign: Gtk.Align.CENTER,
    })

    const slider = makeHSlider({
        value: opts.getValue(),
        onChange: opts.onChange,
        onValueChanged: (v) => { valueLabel.label = `${Math.round(v)}%` },
        onExtChange: opts.onExtChange,
    })

    box.append(endIcon(opts.low))
    box.append(slider)
    box.append(endIcon(opts.high))
    box.append(valueLabel)
    return box
}
