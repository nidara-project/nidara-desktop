import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { makeHSlider } from "../../common/Slider"
import { NidaraRow, NidaraStackedRow, NidaraList, NidaraButton, NidaraDropDown } from "../../../lib/nidara-kit"
import { attachTooltip } from "../../common/Tooltip"
import { t } from "../../core/i18n"

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

// ── Page lifetime ─────────────────────────────────────────────────────────────
/**
 * Bind a live subscription to a widget's REALIZED lifetime.
 *
 * Use this instead of `widget.connect("unrealize", dispose)` for anything a page
 * needs in order to stay CURRENT: service watches, signal handlers, GLib timers.
 *
 * Why it must exist: category pages are built once and cached (`pageCache` in
 * Settings.tsx), and navigating away only `remove()`s the page from the content
 * area. That unrealizes it WITHOUT destroying it, and coming back re-realizes the
 * very same widget. A plain unrealize-cleanup therefore fires the first time the
 * user leaves and is never undone — the page returns looking alive but frozen: a
 * device list that no longer notices a headset, a clock preview stuck at the
 * minute you left. `safeDisconnect` and once-guards (tech-debt #12) only made
 * that silent; they never re-armed anything.
 *
 * `subscribe` runs on every realize and its returned disposer on every unrealize,
 * so put the initial refresh inside it too: a page you come back to should show
 * the world as it is now, not as it was when the window opened.
 */
export function bindWhileRealized(
    widget: Gtk.Widget,
    subscribe: () => (() => void) | void,
): void {
    let dispose: (() => void) | null = null
    const start = () => {
        if (dispose) return
        const d = subscribe()
        dispose = typeof d === "function" ? d : () => {}
    }
    const stop = () => { if (dispose) { dispose(); dispose = null } }
    widget.connect("realize", start)
    widget.connect("unrealize", stop)
    if (widget.get_realized()) start()
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
// Thin wrapper over the universal NidaraList component. Settings-specific code
// keeps its own entry point, but the actual list is the shared component.
/** A settings group. `footer` prints dimmed prose under the card for the scope a
 *  title cannot carry — e.g. WHICH agents a permission group governs (Settings →
 *  AI). Per-row explanation belongs in the row subtitle, not here. */
export const listGroup = (title: string, footer: string = "") => NidaraList(title, [], footer)

// ── Generic Row ───────────────────────────────────────────────────────────────
// Universal NidaraRow + the settings-only side effect (search-index registration).
export const createRow = (label: string, subtitle: string, widget: Gtk.Widget, titleIcon?: Gtk.Widget, leadingIcon?: Gtk.Widget, footer?: Gtk.Widget) => {
    if (_pageCtx.id) {
        _searchIndex.push({ pageId: _pageCtx.id, pageLabel: _pageCtx.label, label, subtitle })
    }
    return NidaraRow(label, subtitle, widget, [], titleIcon, leadingIcon, footer)
}

/** Same as createRow but with the control on its own full-width line underneath —
 *  for entries + buttons that the trailing slot would squeeze. */
export const createStackedRow = (label: string, subtitle: string, widget: Gtk.Widget) => {
    if (_pageCtx.id) {
        _searchIndex.push({ pageId: _pageCtx.id, pageLabel: _pageCtx.label, label, subtitle })
    }
    return NidaraStackedRow(label, subtitle, widget)
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
        // Re-subscribed on every realize: the switch is recycled with its cached page,
        // so a once-only cleanup would leave it deaf to external changes forever after
        // the first time the user navigates away. See bindWhileRealized.
        bindWhileRealized(sw, () => onExt((v: boolean) => {
            if (sw.active === v) return
            syncing = true; sw.active = v; syncing = false
        }))
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
    // NidaraDropDown = the native Gtk.DropDown (its popover is a separate Wayland
    // surface, so Hyprland's popup blur frosts it — a window-overlay list would only
    // show the content behind it, no compositor blur) with our scroll bar swapped into
    // its popup list. Styled via `dropdown popover` in _components.scss.
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
        // See toggleRow — re-subscribed on every realize, not cleaned up once.
        bindWhileRealized(drp, () => onExt((v: string) => {
            const idx = opts.indexOf(v)
            if (idx < 0 || idx === drp.selected) return
            syncing = true; drp.selected = idx; syncing = false
        }))
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
        cssClasses: ["nidara-atomic-scale-native"],
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
                ? ["settings-preset-btn", "nidara-btn--primary"]
                : ["settings-preset-btn"],
        })
        btn.connect("clicked", () => {
            buttons.forEach(b => b.remove_css_class("nidara-btn--primary"))
            btn.add_css_class("nidara-btn--primary")
            cb(val)
        })
        buttons.push(btn)
        btnBox.append(btn)
    })

    return createRow(label, subtitle, btnBox)
}

// ── Stacked-row field layout ──────────────────────────────────────────────────
/**
 * The line of action buttons that sits BENEATH a field in a stacked row,
 * right-aligned, primary last.
 *
 * A field and its buttons side by side is the trailing-slot squeeze one level
 * down: the entry gets whatever width the buttons leave, so it has to be pinned
 * to a `width_chars` stub and the three read as one clump. Given a whole card's
 * width, the field should take it and the actions should sit under it — which
 * also puts the buttons in the same place on every row, instead of wherever the
 * field's length happens to leave them.
 */
export const actionRow = (...actions: Gtk.Widget[]): Gtk.Box => {
    const box = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END })
    for (const a of actions) box.append(a)
    return box
}

/** Full-width field with its actions on their own line beneath — the control for
 *  a `createStackedRow` whose value is an entry the user then acts on. */
export const fieldWithActions = (field: Gtk.Widget, ...actions: Gtk.Widget[]): Gtk.Box => {
    field.hexpand = true
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })
    box.append(field)
    box.append(actionRow(...actions))
    return box
}

// ── Image Picker Row ──────────────────────────────────────────────────────────
/**
 * "Pick an image for this" as ONE row: current image leading, text in the middle,
 * [Choose image…] [reset] trailing.
 *
 * The three-zone shape is the point. Both call sites used to hand-roll a
 * `Gtk.Box` holding preview + both buttons and pass the whole thing as the
 * TRAILING control, so a 24px thumbnail, a primary button and a secondary button
 * shared one slot and the row read as one dense clump pushed against the right
 * edge. `NidaraRow` already separates leading icon / text / control — the rows
 * just weren't using it. Nothing here is new layout machinery; it is the row
 * vocabulary applied.
 *
 * It is also the de-duplication: Settings → Top bar (launcher icon) and
 * Settings → Apps → app detail (per-app icon override) had byte-identical copies
 * of the preview box, the two buttons and the `Gtk.FileDialog` with its SVG/PNG
 * filters. Only "what the image IS" and "what picking one does" ever differed,
 * which is exactly what the callbacks carry.
 */
export const imagePickerRow = (
    label: string,
    subtitle: string,
    opts: {
        /** Paint the current image into the preview. Called now and after every change. */
        renderPreview: (img: Gtk.Image) => void
        /** True while a custom image is set — drives the reset button's sensitivity. */
        isCustom: () => boolean
        /** Apply a chosen file. Return false to reject it (nothing is refreshed). */
        onPick: (path: string) => boolean | void
        /** Restore the built-in/default image. */
        onReset: () => void
        /** Label for the reset button ("Default", "Restore original"…). */
        resetLabel: string
        resetTooltip?: string
        /** Leading preview size in px. 32 matches the app-identity leading icons
         *  in Autostart/Widgets; the detail pages pass more when the image IS the
         *  subject of the page. */
        previewSize?: number
    },
): Gtk.ListBoxRow => {
    const { renderPreview, isCustom, onPick, onReset, resetLabel, resetTooltip, previewSize = 32 } = opts

    const preview = new Gtk.Image({ pixel_size: previewSize, valign: Gtk.Align.CENTER })
    const resetBtn = NidaraButton({
        label: resetLabel, variant: "secondary", pill: true,
        valign: Gtk.Align.CENTER, sensitive: isCustom(),
    })
    if (resetTooltip) attachTooltip(resetBtn, resetTooltip, { chrome: false })

    const refresh = () => { renderPreview(preview); resetBtn.sensitive = isCustom() }
    refresh()

    resetBtn.connect("clicked", () => { onReset(); refresh() })

    const chooseBtn = NidaraButton({
        label: t("settings.apps.choose-image"), variant: "primary", pill: true,
        valign: Gtk.Align.CENTER,
    })
    chooseBtn.connect("clicked", () => {
        const fd = new Gtk.FileDialog({ title: t("settings.apps.dialog.select-icon"), modal: true })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/svg+xml")
        filter.add_mime_type("image/png")
        filter.set_name(t("settings.apps.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        fd.set_filters(filters)
        fd.open(chooseBtn.get_root() as Gtk.Window | null, null, (_: any, res: any) => {
            try {
                const path = fd.open_finish(res)?.get_path()
                if (!path) return               // cancelled
                if (onPick(path) === false) return
                refresh()
            } catch { /* cancelled */ }
        })
    })

    // Trailing slot holds ONLY the buttons now — the preview leads the row.
    const buttons = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
    buttons.append(chooseBtn)
    buttons.append(resetBtn)

    return createRow(label, subtitle, buttons, undefined, preview)
}

// ── Static Info Label ─────────────────────────────────────────────────────────
export const staticLabel = (text: any) => new Gtk.Label({
    label: String(text ?? "---"),
    css_classes: ["dimmed"],
    halign: Gtk.Align.END,
})

// ── Page Root Box ─────────────────────────────────────────────────────────────
export const pageBox = (...extraClasses: string[]) =>
    new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page", ...extraClasses],
    })
