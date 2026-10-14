import Gio from "gi://Gio"
import type { BarMode, WidgetCategory } from "../common/widget-kit/contract"

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
 * same interface is served over `org.nidara.Shell` by `WidgetCatalogWire.ts`;
 * `WidgetCatalogRemote.ts` provides an async client with a cached list(). Page
 * builders live in Settings (surfaces/settings/widgetSettings.ts), keyed by widget id.
 * The icon is still a Gio.FileIcon; a wire adapter must serialize it as a string.
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
    /** "Always" / "When active" in the bar, or null where there is no choice to offer —
     *  a widget that is only shown or not, or a presence indicator (contract.ts
     *  `barActive`). Settings → Top bar offers the choice by this. */
    barMode: BarMode | null
    cc: boolean
    /** Always in the Control Centre: its Center switch is on and cannot be turned off. */
    ccFixed: boolean
    /** Placing it in the CC now would find a free cell (true when already placed). */
    ccFits: boolean
}

export interface WidgetCatalog {
    list(): WidgetCatalogEntry[]
    watch?(changed: () => void): () => void
    connected?: boolean
    lastError?: string | null
    setBar(id: string, on: boolean): void | Promise<void>
    setBarMode(id: string, mode: BarMode): void | Promise<void>
    /** Put the bar in its edit mode, where the right group is reordered in place — the
     *  order is edited there, not in Settings (Settings → Top bar's "Reorder" button). */
    editBarOrder(): void | Promise<void>
    /** Place in / remove from the Control Centre — placement flag AND grid cell. */
    setCc(id: string, on: boolean): void | Promise<void>
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
    return { list: () => [], setBar: () => {}, setBarMode: () => {}, editBarOrder: () => {}, setCc: () => {} }
}
