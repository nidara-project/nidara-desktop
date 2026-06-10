import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { makeHSlider } from "../common/Slider"
import { CrystalRow, CrystalList } from "../../../lib/crystal-ui"

/**
 * Shared UI helpers for Settings pages.
 * All pages use the same listGroup / createRow / toggleRow / sliderRow / etc.
 */

// ── Subpage navigation ──────────────────────────────────────────────────────────
// Settings is a single-child page swapper (see Settings.tsx). A page component
// receives a SettingsNav so it can push a detail subpage (e.g. a Wi-Fi network's
// info) into the same shell. The subpage's title rides in the window header as a
// breadcrumb (`parentTitle › title`); return is via the breadcrumb parent or the
// header back/forward capsule. One nav per Settings window (there is a Settings per
// monitor), so it's passed in, never a module singleton.
export interface SettingsNav {
    /**
     * Build + push a subpage, then navigate to it.
     * @param id        unique & stable page key
     * @param title     shown in the header breadcrumb
     * @param parentId  page to return to (breadcrumb parent); usually the caller
     * @param build     constructs the page widget (called fresh on each push)
     */
    pushSubpage: (opts: { id: string; title: string; parentId?: string; build: () => Gtk.Widget }) => void
    /** Go back one step in history (same as the nav-capsule back button). */
    goBack: () => void
}

// ── Search index ──────────────────────────────────────────────────────────────
export interface SearchItem {
    pageId: string
    pageLabel: string
    label: string
    subtitle: string
}

let _searchIndex: SearchItem[] = []
let _pageCtx = { id: "", label: "" }

export const beginPage = (id: string, label: string) => { _pageCtx = { id, label } }
export const endPage = () => { _pageCtx = { id: "", label: "" } }
export const clearSearchIndex = () => { _searchIndex = []; _pageCtx = { id: "", label: "" } }
export const getSearchIndex = (): SearchItem[] => [..._searchIndex]

// ── Boxed List Group ──────────────────────────────────────────────────────────
// Thin wrapper over the universal CrystalList component. Settings-specific code
// keeps its own entry point, but the actual list is the shared component.
export const listGroup = (title: string) => CrystalList(title)

// ── Generic Row ───────────────────────────────────────────────────────────────
// Universal CrystalRow + the settings-only side effect (search-index registration).
export const createRow = (label: string, subtitle: string, widget: Gtk.Widget, titleIcon?: Gtk.Widget) => {
    if (_pageCtx.id) {
        _searchIndex.push({ pageId: _pageCtx.id, pageLabel: _pageCtx.label, label, subtitle })
    }
    return CrystalRow(label, subtitle, widget, [], titleIcon)
}

// ── Toggle Row ────────────────────────────────────────────────────────────────
export const toggleRow = (
    label: string,
    subtitle: string,
    init: boolean,
    cb: (v: boolean) => void,
    // Optional live external-sync: register a callback that the page invokes when the
    // underlying value changes outside the UI (e.g. an external `hyprctl reload`). It
    // applies the new state WITHOUT firing `cb` (guarded), so there's no feedback loop.
    // Returns a disconnect, wired to the switch's unrealize.
    onExt?: (apply: (v: boolean) => void) => (() => void),
) => {
    const sw = new Gtk.Switch({ active: init, valign: Gtk.Align.CENTER })
    let syncing = false
    sw.connect("state-set", (_: any, state: boolean) => {
        if (!syncing) cb(state)
        return false
    })
    if (onExt) {
        const cleanup = onExt((v: boolean) => {
            if (sw.active === v) return
            syncing = true; sw.active = v; syncing = false
        })
        sw.connect("unrealize", cleanup)
    }
    return createRow(label, subtitle, sw)
}

// ── Dropdown Row ──────────────────────────────────────────────────────────────
export const dropdownRow = (
    label: string,
    subtitle: string,
    init: string,
    opts: string[],
    cb: (v: string) => void,
    // See toggleRow's `onExt` — same live external-sync contract (guarded, no loop).
    onExt?: (apply: (v: string) => void) => (() => void),
) => {
    // Native Gtk.DropDown: its popover is a separate Wayland surface, so Hyprland's
    // popup blur frosts it (a window-overlay list would only show the content behind
    // it, no compositor blur). Styled via `dropdown popover` in _components.scss.
    const model = new Gtk.StringList({ strings: opts })
    const drp = new Gtk.DropDown({ model, valign: Gtk.Align.CENTER })
    const initIdx = opts.indexOf(init)
    drp.selected = initIdx >= 0 ? initIdx : 0
    let syncing = false
    drp.connect("notify::selected", () => {
        if (syncing) return
        const idx = drp.selected
        if (idx < opts.length) cb(opts[idx])
    })
    if (onExt) {
        const cleanup = onExt((v: string) => {
            const idx = opts.indexOf(v)
            if (idx < 0 || idx === drp.selected) return
            syncing = true; drp.selected = idx; syncing = false
        })
        drp.connect("unrealize", cleanup)
    }
    return createRow(label, subtitle, drp)
}

// ── Slider Row ────────────────────────────────────────────────────────────────
// opts.icons: [lowIconName, highIconName] — omit for no icons
// opts.unit:  suffix for the value label (e.g. "px", "%") — default ""
// opts.pct:   if true, value is treated as 0-1 float and displayed as percentage
export const sliderRow = (
    label: string,
    subtitle: string,
    init: number,
    min: number,
    max: number,
    cb: (v: number) => void,
    opts: { unit?: string; icons?: [Gio.FileIcon, Gio.FileIcon]; iconSizes?: [number, number]; endpoints?: [Gtk.Widget, Gtk.Widget]; pct?: boolean; decimals?: number; commitOnRelease?: boolean; onExtChange?: (cb: (v: number) => void) => (() => void) } = {},
) => {
    const { unit = "", icons, iconSizes = [16, 16], endpoints, pct = false, decimals, commitOnRelease = false, onExtChange } = opts

    // Integer sliders (no `decimals`/`pct`) must STORE integers, not just display them:
    // the raw Gtk.Scale value is fractional, and a fractional setting (e.g. screenGap=8.19)
    // propagates into geometry (EXCLUSIVE_ZONE) and gets truncated downstream — that lost
    // the dock's last interactive pixel column at the screen wall. Round at the source.
    const quantize = (decimals === undefined && !pct) ? (v: number) => Math.round(v) : (v: number) => v
    const onCommit = (v: number) => cb(quantize(v))

    const formatVal = (v: number) => {
        if (pct) return `${Math.round(v * 100)}%`
        if (decimals !== undefined) return `${v.toFixed(decimals)}${unit}`
        return `${Math.round(v)}${unit}`
    }

    // hexpand:false is REQUIRED: makeHSlider's overlay sets hexpand:true, which
    // otherwise propagates up to this container, making createRow treat it as an
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
        cssClasses: ["cc-atomic-scale-native"],
        width_request: 140,
    })

    // Endpoints flanking the slider: arbitrary widgets via `endpoints` (e.g. small/
    // large "A" labels, which stay crisp where a tiny SVG icon would not), else a
    // pair of cs-icon images via `icons`.
    const mkIcon = (i: number) =>
        new Gtk.Image({ gicon: icons![i], pixel_size: iconSizes[i], opacity: 0.5, css_classes: ["cs-icon"], valign: Gtk.Align.CENTER })
    const leftEnd  = endpoints?.[0] ?? (icons ? mkIcon(0) : null)
    const rightEnd = endpoints?.[1] ?? (icons ? mkIcon(1) : null)

    if (leftEnd)  container.append(leftEnd)
    container.append(sliderWidget)
    if (rightEnd) container.append(rightEnd)
    container.append(valueLabel)
    return createRow(label, subtitle, container)
}

// ── Preset Button Row ─────────────────────────────────────────────────────────
export const presetRow = (
    label: string,
    subtitle: string,
    presets: number[],
    init: number,
    unit: string,
    cb: (v: number) => void,
) => {
    const btnBox = new Gtk.Box({
        spacing: 0,
        homogeneous: true,
        css_classes: ["settings-preset-group", "linked"],
        valign: Gtk.Align.CENTER,
    })

    const buttons: Gtk.Button[] = []
    presets.forEach(val => {
        const btn = new Gtk.Button({
            label: `${val}${unit}`,
            css_classes: val === init
                ? ["settings-preset-btn", "crystal-btn--primary"]
                : ["settings-preset-btn"],
        })
        btn.connect("clicked", () => {
            buttons.forEach(b => b.remove_css_class("crystal-btn--primary"))
            btn.add_css_class("crystal-btn--primary")
            cb(val)
        })
        buttons.push(btn)
        btnBox.append(btn)
    })

    return createRow(label, subtitle, btnBox)
}

// ── Static Info Label ─────────────────────────────────────────────────────────
export const staticLabel = (text: any) => new Gtk.Label({
    label: String(text ?? "---"),
    css_classes: ["settings-row-status", "dimmed"],
    halign: Gtk.Align.END,
})

// ── Page Root Box ─────────────────────────────────────────────────────────────
export const pageBox = (...extraClasses: string[]) =>
    new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page", ...extraClasses],
    })
