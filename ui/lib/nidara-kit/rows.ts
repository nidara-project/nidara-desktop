import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { NidaraRow } from "./row"
import { NidaraDropDown } from "./scrolled"
import { makeHSlider } from "./slider"
import { bindWhileRealized } from "./lifetime"

/**
 * NIDARA KIT — the composed rows
 * ==============================
 *
 * A "label + subtitle + the control that edits it" row, which is what a preferences
 * pane is almost entirely made of. `NidaraRow` has always built the row itself; what
 * lived in `ui/shell/surfaces/settings/SettingsHelpers.ts` was the COMPOSITION —
 * building the switch/dropdown/slider, wiring its callback, and guarding the
 * external-sync feedback loop.
 *
 * ── WHY THIS TOOK SO LONG TO EXTRACT: build vs register ─────────────────────
 * Settings' `createRow` did two things in one call. It built the row (by delegating
 * to `NidaraRow`) AND it pushed the row's label into Settings' **search index**,
 * using an ambient page context that `Settings.tsx` opens and closes around each
 * page's construction. Every composed row ended in that call, so all of them were
 * welded to a side effect that only Settings has and only Settings wants.
 *
 * 🔑 **The split is the `mkRow` parameter.** A composed row no longer knows how its
 * row comes into being: it builds a control and hands it to whatever row builder it
 * was given. The default is plain `NidaraRow`, which is what any window that is not
 * Settings wants. Settings passes its own `createRow`, which registers and then
 * delegates — so its 130-odd call sites did not change at all, and the search index
 * keeps working exactly as before.
 *
 * That is also why the injection is a PARAMETER and not a module-level seam like
 * `appearance.ts`. The appearance seam is per-BUNDLE (Cairo needs one accent, and
 * there is one per process). Row registration is per-CALLER: the same shell has
 * Settings rows that must be indexed and Control Center rows that must not
 * (`widgets/screenrecord.ts`). A global would have to be pushed and popped around
 * every build, which is the ambient context we are getting away from.
 */

/**
 * How a composed row turns its control into an actual row. Deliberately narrower
 * than `NidaraRow`'s full signature — a composed row only ever needs these three.
 */
export type NidaraRowBuilder = (label: string, subtitle: string, control: Gtk.Widget) => Gtk.ListBoxRow

/** The default: a plain kit row, no side effects. */
export const plainRow: NidaraRowBuilder = (label, subtitle, control) => NidaraRow(label, subtitle, control)

/**
 * A row whose control is a switch.
 *
 * `onExt` is the live external-sync hook: register a callback the caller invokes
 * when the underlying value changes OUTSIDE the UI (an external `hyprctl reload`, a
 * service event). It applies the new state WITHOUT firing `cb` — guarded, so there
 * is no feedback loop — and returns a disconnect.
 *
 * ⚠️ That subscription goes through `bindWhileRealized`, not a one-shot cleanup: a
 * cached row is recycled with its page, so a once-only cleanup leaves the switch
 * deaf to external changes forever after the first time the user navigates away.
 */
export function NidaraToggleRow(
    label: string,
    subtitle: string,
    init: boolean,
    cb: (v: boolean) => void,
    onExt?: (apply: (v: boolean) => void) => (() => void),
    mkRow: NidaraRowBuilder = plainRow,
): Gtk.ListBoxRow {
    const sw = new Gtk.Switch({ active: init, valign: Gtk.Align.CENTER })
    let syncing = false
    sw.connect("state-set", (_: any, state: boolean) => {
        if (!syncing) cb(state)
        return false
    })
    if (onExt) {
        bindWhileRealized(sw, () => onExt((v: boolean) => {
            if (sw.active === v) return
            syncing = true; sw.active = v; syncing = false
        }))
    }
    return mkRow(label, subtitle, sw)
}

/**
 * A row whose control is a dropdown.
 *
 * `NidaraDropDown` = the native `Gtk.DropDown` (its popover is a separate Wayland
 * surface, so a compositor's popup blur frosts it — a window-overlay list would only
 * show the content behind it) with our scroll bar swapped into its popup list.
 * `onExt` is the same guarded external-sync contract as `NidaraToggleRow`'s.
 */
export function NidaraDropDownRow(
    label: string,
    subtitle: string,
    init: string,
    opts: string[],
    cb: (v: string) => void,
    onExt?: (apply: (v: string) => void) => (() => void),
    mkRow: NidaraRowBuilder = plainRow,
): Gtk.ListBoxRow {
    const model = new Gtk.StringList({ strings: opts })
    const drp = NidaraDropDown({ model, valign: Gtk.Align.CENTER })
    const initIdx = opts.indexOf(init)
    drp.selected = initIdx >= 0 ? initIdx : 0
    let syncing = false
    drp.connect("notify::selected", () => {
        if (syncing) return
        const idx = drp.selected
        if (idx < opts.length) cb(opts[idx])
    })
    if (onExt) {
        bindWhileRealized(drp, () => onExt((v: string) => {
            const idx = opts.indexOf(v)
            if (idx < 0 || idx === drp.selected) return
            syncing = true; drp.selected = idx; syncing = false
        }))
    }
    return mkRow(label, subtitle, drp)
}

export interface NidaraSliderRowOpts {
    /** Suffix for the value label ("px", "%"…). Default "". */
    unit?: string
    /** A pair of `nd-icon` images flanking the slider. Omit for none. */
    icons?: [Gio.FileIcon, Gio.FileIcon]
    iconSizes?: [number, number]
    /** Arbitrary widgets flanking the slider — takes precedence over `icons`. */
    endpoints?: [Gtk.Widget, Gtk.Widget]
    /** Value is a 0-1 float, displayed as a percentage. */
    pct?: boolean
    decimals?: number
    commitOnRelease?: boolean
    step?: number
    onExtChange?: (cb: (v: number) => void) => (() => void)
}

/**
 * A row whose control is a slider with its value printed beside it.
 *
 * ⚠️ **Integer sliders must STORE integers, not merely display them.** Without
 * `decimals`/`pct` the value is rounded at the source, because a fractional setting
 * (screenGap = 8.19) propagates into geometry and gets truncated downstream — that
 * is what once cost the dock its last interactive pixel column at the screen wall.
 */
export function NidaraSliderRow(
    label: string,
    subtitle: string,
    init: number,
    min: number,
    max: number,
    cb: (v: number) => void,
    opts: NidaraSliderRowOpts = {},
    mkRow: NidaraRowBuilder = plainRow,
): Gtk.ListBoxRow {
    const { unit = "", icons, iconSizes = [16, 16], endpoints, pct = false, decimals, commitOnRelease = false, step, onExtChange } = opts

    const quantize = (decimals === undefined && !pct) ? (v: number) => Math.round(v) : (v: number) => v
    const onCommit = (v: number) => cb(quantize(v))

    const formatVal = (v: number) => {
        if (pct) return `${Math.round(v * 100)}%`
        if (decimals !== undefined) return `${v.toFixed(decimals)}${unit}`
        return `${Math.round(v)}${unit}`
    }

    // hexpand:false is REQUIRED: makeHSlider's overlay sets hexpand:true, which
    // otherwise propagates up to this container, making the row treat it as an
    // expanding widget that shares row space with the text — so the slider's width
    // and position drift with the subtitle length. Pin it to shrink-wrap (the slider
    // keeps its fixed width_request) so every slider row aligns.
    const container = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER, hexpand: false })

    const valueLabel = new Gtk.Label({
        label: formatVal(init),
        css_classes: ["slider-value-label"],
        width_chars: 5,
        xalign: 1.0,
    })

    const sliderWidget = makeHSlider({
        min, max, value: init,
        onChange: onCommit,
        onValueChanged: (v) => { valueLabel.label = formatVal(v) },
        onExtChange,
        debounce: 32,
        commitOnRelease,
        // `step` opts the row into DETENTS (see SliderOpts.snapToStep): pass it when
        // the setting is coarser than the thumb's travel, so no position of the thumb
        // is indistinguishable from its neighbour. Without it the slider glides and
        // scroll/keyboard fall back to range/20 as before.
        ...(step !== undefined ? { step, snapToStep: true } : {}),
        width_request: 140,
    })

    // Endpoints flanking the slider: arbitrary widgets via `endpoints` (e.g. small/
    // large "A" labels, which stay crisp where a tiny SVG icon would not), else a
    // pair of nd-icon images via `icons`.
    const mkIcon = (i: number) =>
        new Gtk.Image({ gicon: icons![i], pixel_size: iconSizes[i], opacity: 0.5, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER })
    const leftEnd  = endpoints?.[0] ?? (icons ? mkIcon(0) : null)
    const rightEnd = endpoints?.[1] ?? (icons ? mkIcon(1) : null)

    if (leftEnd)  container.append(leftEnd)
    container.append(sliderWidget)
    if (rightEnd) container.append(rightEnd)
    container.append(valueLabel)
    return mkRow(label, subtitle, container)
}
