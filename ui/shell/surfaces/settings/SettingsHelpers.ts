import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import { NidaraRow, NidaraStackedRow, NidaraList, NidaraButton,
         NidaraToggleRow, NidaraDropDownRow, NidaraSliderRow, type NidaraSliderRowOpts } from "../../../lib/nidara-kit"
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
 * `bindWhileRealized` moved to `nidara-kit/lifetime.ts` (2026-08-16) because the
 * kit's composed rows re-arm their external-sync through it. Re-exported here so
 * Settings pages keep their import path; the explanation — why a cached page needs
 * re-subscription rather than a one-shot cleanup — went with the implementation.
 */
export { bindWhileRealized } from "../../../lib/nidara-kit"

// ── Search index ──────────────────────────────────────────────────────────────
export interface SearchItem {
    pageId: string
    pageLabel: string
    label: string
    subtitle: string
}

let _searchIndex: SearchItem[] = []
let _pageCtx = { id: "", label: "" }
/** pageId → live re-reads; see `onPageShown` below. */
const _refreshers = new Map<string, Array<() => void>>()

export const beginPage = (id: string, label: string) => { _pageCtx = { id, label } }
export const endPage = () => { _pageCtx = { id: "", label: "" } }
export const clearSearchIndex = () => {
    _searchIndex = []
    _pageCtx = { id: "", label: "" }
    _refreshers.clear()
}
export const getSearchIndex = (): SearchItem[] => [..._searchIndex]

// ── Live re-reads ─────────────────────────────────────────────────────────────
// Top-level pages are built ONCE (Settings.tsx caches them) and the window HIDES
// on close, so a page body runs exactly one time per shell lifetime. Anything the
// page SUBSCRIBED to keeps working; anything it merely ASKED — an `execAsync`, a
// file read, a one-shot `powerprofilesctl get` — was answered once and then went
// stale in silence, because a frozen value looks exactly like a correct one.
//
// This registers such a read against the page being built (the same `_pageCtx`
// seam `createRow` indexes through), runs it immediately, and re-runs it whenever
// the page becomes visible. Subpages need none of it: they are rebuilt on every
// push, so `_pageCtx` being empty is the correct no-op.
//
// ⚠️ NOT the same job as `bindWhileRealized`, and it is not covered by it. That
// one re-arms on REALIZE, which fires when you navigate between pages — but
// hiding the Settings window does NOT unrealize its pages (measured 2026-08-16:
// close the window on Power, change the profile from a terminal, reopen → a
// realize-bound read does not run and the page still shows the old profile).
// Closing and reopening is the most common way a user returns to a page, so a
// re-read hung off realize misses precisely the case it exists for. Use
// `bindWhileRealized` for a SUBSCRIPTION whose lifetime must match the widget's
// (it has something to dispose); use this for a QUESTION that has to be re-asked
// (it has nothing to dispose).
export const onPageShown = (read: () => void) => {
    if (_pageCtx.id) {
        const list = _refreshers.get(_pageCtx.id) ?? []
        list.push(read)
        _refreshers.set(_pageCtx.id, list)
    }
    read()
}

export const runPageRefreshers = (pageId: string) => {
    for (const read of _refreshers.get(pageId) ?? []) {
        try { read() } catch (e) { console.error(`[Settings] refresh failed on ${pageId}:`, e) }
    }
}

// ── Boxed List Group ──────────────────────────────────────────────────────────
// Thin wrapper over the universal NidaraList component. Settings-specific code
// keeps its own entry point, but the actual list is the shared component.
/** A settings group. `footer` prints dimmed prose under the card for the scope a
 *  title cannot carry — e.g. WHICH agents a permission group governs (Settings →
 *  AI). Per-row explanation belongs in the row subtitle, not here. */
export const listGroup = (title: string, footer: string = "") => NidaraList(title, [], footer)

// ── Generic Row ───────────────────────────────────────────────────────────────
// Universal NidaraRow + the settings-only side effect (search-index registration).
//
// 🔑 This is the whole of what Settings adds to a row, and since 2026-08-16 it is
// the ONLY thing it adds: the composed rows below build their control in the kit
// and take this function as their `mkRow`. Registering is Settings'; building is
// the kit's. Anything that builds rows OUTSIDE Settings (widgets/screenrecord.ts)
// calls the kit directly and is simply never indexed — before, it went through
// here and relied on `_pageCtx` happening to be empty.
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

// ── Composed rows: the kit builds, Settings registers ────────────────────────
// Each of these is the kit's composed row with `createRow` handed in as its row
// builder. The control, its callback wiring and the guarded external-sync all live
// in `nidara-kit/rows.ts`; what stays here is the one thing the kit must not know
// about, the search index. Call-site signatures are unchanged.
export const toggleRow = (
    label: string,
    subtitle: string,
    init: boolean,
    cb: (v: boolean) => void,
    onExt?: (apply: (v: boolean) => void) => (() => void),
) => NidaraToggleRow(label, subtitle, init, cb, onExt, createRow)

export const dropdownRow = (
    label: string,
    subtitle: string,
    init: string,
    opts: string[],
    cb: (v: string) => void,
    onExt?: (apply: (v: string) => void) => (() => void),
) => NidaraDropDownRow(label, subtitle, init, opts, cb, onExt, createRow)

export const sliderRow = (
    label: string,
    subtitle: string,
    init: number,
    min: number,
    max: number,
    cb: (v: number) => void,
    opts: NidaraSliderRowOpts = {},
) => NidaraSliderRow(label, subtitle, init, min, max, cb, opts, createRow)

// ── Segmented control ─────────────────────────────────────────────────────────
/**
 * The linked row of buttons where exactly ONE is selected — Dock size presets,
 * the Gaming wallpaper mode. One implementation, because there were two and only
 * one of them was right.
 *
 * ⚠️ **A segment is a `Gtk.Button`, never a `Gtk.ToggleButton`.** The Gaming page
 * built its own group out of ToggleButtons, and a ToggleButton that is already
 * active turns OFF when clicked: the handler (`if (!btn.active) return`) then bailed
 * out, leaving the group showing NO selection while a mode was still in force. A
 * segmented control does not have an empty state — plain buttons plus the
 * `.nidara-btn--primary` class cannot express one.
 *
 * Re-clicking the current segment is a no-op rather than a second `cb`: picking
 * what is already picked should not re-apply a wallpaper.
 */
export const segmentedGroup = <T,>(
    options: Array<{ label: string; value: T }>,
    init: T,
    cb: (v: T) => void,
): Gtk.Box => {
    const box = new Gtk.Box({
        spacing: 0,
        homogeneous: true,
        css_classes: ["settings-preset-group", "linked"],
        valign: Gtk.Align.CENTER,
    })

    const segments: Array<{ btn: Gtk.Button; value: T }> = []
    let current = init
    const paint = () => segments.forEach(({ btn, value }) => {
        if (value === current) btn.add_css_class("nidara-btn--primary")
        else btn.remove_css_class("nidara-btn--primary")
    })

    options.forEach(({ label, value }) => {
        const btn = new Gtk.Button({ label, css_classes: ["settings-preset-btn"] })
        btn.connect("clicked", () => {
            if (value === current) return
            current = value
            paint()
            cb(value)
        })
        segments.push({ btn, value })
        box.append(btn)
    })
    paint()

    return box
}

// ── Preset Button Row ─────────────────────────────────────────────────────────
/** Numeric presets ("48px", "64px"…) as a segmented row. */
export const presetRow = (
    label: string,
    subtitle: string,
    presets: number[],
    init: number,
    unit: string,
    cb: (v: number) => void,
) => createRow(
    label, subtitle,
    segmentedGroup(presets.map(v => ({ label: `${v}${unit}`, value: v })), init, cb),
)

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
