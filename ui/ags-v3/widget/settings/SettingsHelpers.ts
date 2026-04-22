import { Gtk } from "ags/gtk4"
import { makeHSlider } from "../common/Slider"

/**
 * Shared UI helpers for Settings pages.
 * All pages use the same listGroup / createRow / toggleRow / sliderRow / etc.
 */

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
export const listGroup = (title: string) => {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: ["settings-group"],
    })

    if (title) {
        box.append(new Gtk.Label({
            label: title.toUpperCase(),
            css_classes: ["settings-group-title"],
            halign: Gtk.Align.START,
            margin_start: 10,
        }))
    }

    const listBox = new Gtk.ListBox({
        css_classes: ["settings-list-box", "boxed-list"],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    box.append(listBox)
    return { box, listBox }
}

// ── Generic Row ───────────────────────────────────────────────────────────────
export const createRow = (label: string, subtitle: string, widget: Gtk.Widget) => {
    const box = new Gtk.Box({
        spacing: 16,
        margin_start: 16,
        margin_end: 16,
        margin_top: 14,
        margin_bottom: 14,
    })

    const text = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })

    text.append(new Gtk.Label({
        label,
        css_classes: ["settings-row-label"],
        halign: Gtk.Align.START,
    }))

    if (subtitle) {
        text.append(new Gtk.Label({
            label: subtitle,
            css_classes: ["settings-row-subtitle"],
            halign: Gtk.Align.START,
        }))
    }

    box.append(text)
    box.append(widget)

    // Auto-register in search index when inside a page build
    if (_pageCtx.id) {
        _searchIndex.push({ pageId: _pageCtx.id, pageLabel: _pageCtx.label, label, subtitle })
    }

    const lbr = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
    lbr.set_child(box)
    return lbr
}

// ── Toggle Row ────────────────────────────────────────────────────────────────
export const toggleRow = (
    label: string,
    subtitle: string,
    init: boolean,
    cb: (v: boolean) => void,
) => {
    const sw = new Gtk.Switch({ active: init, valign: Gtk.Align.CENTER })
    sw.connect("state-set", (_: any, state: boolean) => {
        cb(state)
        return false
    })
    return createRow(label, subtitle, sw)
}

// ── Dropdown Row ──────────────────────────────────────────────────────────────
export const dropdownRow = (
    label: string,
    subtitle: string,
    init: string,
    opts: string[],
    cb: (v: string) => void,
) => {
    const drp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
    opts.forEach(o => drp.append_text(o))
    drp.active = opts.indexOf(init)
    drp.connect("changed", () => {
        const val = drp.get_active_text()
        if (val) cb(val)
    })
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
    opts: { unit?: string; icons?: [string, string]; pct?: boolean } = {},
) => {
    const { unit = "", icons, pct = false } = opts

    const formatVal = (v: number) =>
        pct ? `${Math.round(v * 100)}%` : `${Math.round(v)}${unit}`

    const container = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })

    if (icons) {
        container.append(new Gtk.Image({ icon_name: icons[0], pixel_size: 16, opacity: 0.5 }))
    }

    const valueLabel = new Gtk.Label({
        label: formatVal(init),
        css_classes: ["slider-value-label"],
        width_chars: 5,
        xalign: 1.0,
    })

    const sliderWidget = makeHSlider({
        min, max, value: init,
        onChange: cb,
        onValueChanged: (v) => { valueLabel.label = formatVal(v) },
        debounce: 32,
        cssClasses: ["cc-atomic-scale-native"],
        width_request: 140,
    })

    if (icons) {
        container.append(sliderWidget)
        container.append(new Gtk.Image({ icon_name: icons[1], pixel_size: 16, opacity: 0.5 }))
    } else {
        container.append(sliderWidget)
    }

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
                ? ["settings-preset-btn", "suggested-action"]
                : ["settings-preset-btn"],
        })
        btn.connect("clicked", () => {
            buttons.forEach(b => b.remove_css_class("suggested-action"))
            btn.add_css_class("suggested-action")
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

// ── Page Header ───────────────────────────────────────────────────────────────
export const pageHeader = (title: string, subtitle: string) => {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_bottom: 16,
    })
    box.append(new Gtk.Label({
        label: title,
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))
    box.append(new Gtk.Label({
        label: subtitle,
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))
    return box
}

// ── Page Root Box ─────────────────────────────────────────────────────────────
export const pageBox = (...extraClasses: string[]) =>
    new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page", ...extraClasses],
    })
