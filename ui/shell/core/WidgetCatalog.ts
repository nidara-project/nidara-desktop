import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import type { WidgetCategory } from "../common/widget-kit/contract"

/**
 * The widget catalogue seam — Settings → Widgets as DATA, not as widget modules (#571).
 * ==================================================================================
 *
 * The Widgets page used to import `widgets/index` and `CCLayoutManager`, which is to say
 * every widget's live implementation and every service those implementations start: a
 * Settings process built on that would run the media, battery, network and notification
 * services of a second desktop. What the page actually needs is a list — who exists,
 * what they are called, whether the hardware is there, where they are placed, whether
 * the Control Centre has room — and two verbs.
 *
 * So the bundle that OWNS the widgets hands that list over, the way it hands the kit its
 * appearance (`nidara-kit/appearance.ts`): the shell calls `setWidgetCatalog()` once in
 * `app.ts` with `core/WidgetCatalogSource.ts`. When Settings runs in its own process the
 * same interface is served over `org.nidara.Shell` and the page does not change. Keep
 * every field plain data for that reason — the only exception is `buildSettings`, see
 * its note.
 *
 * ⚠️ This module must stay a leaf: it may import types and `gi://` only. Importing the
 * registry from here puts every widget straight back into Settings, and
 * `scripts/ci/settings-closure-check.mjs` will say so.
 */

export interface WidgetCatalogEntry {
    id: string
    name: string
    icon: Gio.FileIcon | null
    category: WidgetCategory
    /** Intra-category order (lower = further left), as in the bar. */
    barOrder: number
    /** The widget has a bar variant — the Bar switch exists. */
    canBar: boolean
    /** The widget can live in the Control Centre — the Center switch exists. */
    canCc: boolean
    /** The hardware it needs is present. Placement is kept either way. */
    available: boolean
    bar: boolean
    cc: boolean
    /** Placing it in the CC now would find a free cell (true when already placed). */
    ccFits: boolean
    /**
     * The widget's own settings page, built by the widget. The one field that is not data,
     * and so the one a Settings process cannot receive over D-Bus. `screenrecord` is the
     * only widget with one (its capture options, all already GSettings keys in
     * `org.nidara.recording`); before Settings leaves the shell that page has to move to
     * Settings' side as rows over those keys, not stay a Gtk tree the shell builds.
     */
    buildSettings?: () => Gtk.Widget
}

export interface WidgetCatalog {
    list(): WidgetCatalogEntry[]
    setBar(id: string, on: boolean): void
    /** Place in / remove from the Control Centre — placement flag AND grid cell. */
    setCc(id: string, on: boolean): void
}

let source: WidgetCatalog | null = null
let warned = false

export function setWidgetCatalog(catalog: WidgetCatalog): void {
    source = catalog
}

/** The registered catalogue, or an empty one (logged once) if the bundle forgot. */
export function widgetCatalog(): WidgetCatalog {
    if (source) return source
    if (!warned) {
        warned = true
        console.warn("[WidgetCatalog] no catalogue registered — Settings → Widgets is empty. "
                   + "The bundle that owns the widgets calls setWidgetCatalog() in its app.ts.")
    }
    return { list: () => [], setBar: () => {}, setCc: () => {} }
}
