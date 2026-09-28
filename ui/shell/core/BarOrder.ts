import { defineSettings } from "./configFile"
import { CATEGORY_ORDER, type WidgetCategory } from "../common/widget-kit/contract"

/**
 * The ORDER of the bar's right group — one list for everything in it (owner, 2026-09-26).
 * =====================================================================================
 *
 * The right group holds three kinds of item: widgets (a plugin, #640, is a widget loaded
 * at run time, so it is not a fourth), the apps' tray icons, and search. Until this module
 * each kind had its own rule — widgets by category in code, tray icons by D-Bus arrival,
 * search fixed — and none of them could be moved. Now they are ONE list of keys:
 *
 *   `widget:<id>` · `tray:<StatusNotifierItem Id>` · `shell:search`
 *
 * The Control Centre and the clock are not in it: they stay at the right end, because the
 * CC and notification panels hang from that edge (and macOS pins the same two).
 *
 * The rules, each an owner's decision of 2026-09-26:
 *  - **Not personalised = derived.** An empty `bar-order` means the default order: tray
 *    icons in the order they arrived, then widgets by category (`sortWidgetsForBar`), then
 *    search (tray first since 2026-09-28: apps left of the system's controls, as macOS).
 *    Nothing is written until the person reorders, so a default can still improve with an
 *    update.
 *  - **Personalised, an item the list does not name goes to the LEFT end** — a new tray
 *    app, a widget just switched on. It is the first to fold behind the `»` and it never
 *    pushes aside what the person arranged (macOS does the same).
 *  - **The `»` folds from the left**, whatever the item is: the order IS the priority.
 *  - A tray icon, or search, can be kept out of the bar (`bar-hidden`), the way a
 *    widget can (through its placement).
 *
 * Tray icons are keyed by the SNI `Id` property, never the D-Bus name, which changes every
 * time the app starts. The shell records each one it sees in `tray-known`, so Settings can
 * list and place an app's icon while the app is closed.
 *
 * ⚠️ A leaf for Settings' sake (#571): the store and the rules, no widget, no surface. The
 * bar and Settings both call `resolveOrder`, and the same function is what makes the page
 * show the order the bar paints.
 */

export const SEARCH_KEY = "shell:search"
export const widgetKey = (id: string) => `widget:${id}`
export const trayKey = (sniId: string) => `tray:${sniId}`

export type BarKeyKind = "widget" | "tray" | "shell"
export function parseBarKey(key: string): { kind: BarKeyKind, id: string } | null {
    const i = key.indexOf(":")
    if (i <= 0) return null
    const kind = key.slice(0, i)
    if (kind !== "widget" && kind !== "tray" && kind !== "shell") return null
    return { kind, id: key.slice(i + 1) }
}

// SNI Id → (title, icon — a theme name or a file path —, desktop app id or "").
type TrayKnown = Record<string, [string, string, string]>

const isStringList = (v: unknown) => Array.isArray(v) && v.every(s => typeof s === "string")
const store = defineSettings<{ barOrder: string[], barHidden: string[], trayKnown: TrayKnown }>(
    "widgets",
    { barOrder: [], barHidden: [], trayKnown: {} },
    {
        barOrder: isStringList,
        barHidden: isStringList,
        trayKnown: v => typeof v === "object" && v !== null
            && Object.values(v).every(p => Array.isArray(p) && p.length === 3 && isStringList(p)),
    },
)

/** The default left-to-right order of the bar's widgets: category (`CATEGORY_ORDER`),
 *  then `barOrder` (lower = further left), then the order given (registration) — the
 *  sort is stable. The bar (`widgets/index.ts` BAR_ORDER) and Settings share it. */
export function sortWidgetsForBar<T extends { category: WidgetCategory, barOrder?: number }>(list: T[]): T[] {
    return [...list].sort((a, b) =>
        (CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)) ||
        ((a.barOrder ?? 0) - (b.barOrder ?? 0)))
}

/** The default order of a set of items, each list already in its own default order:
 *  the apps' icons first, left of the system's controls, as macOS has them — and the
 *  same side a new icon arrives on once the order is personalised (`resolveOrder`). */
export function defaultOrder(widgetKeys: string[], trayKeys: string[]): string[] {
    return [...trayKeys, ...widgetKeys, SEARCH_KEY]
}

/** The order the bar paints `present` in (`present` = the items that exist and are shown,
 *  in their DEFAULT order). Not personalised: `present` itself. Personalised: the items
 *  the saved list does not name first, then the rest as saved. */
export function resolveOrder(saved: string[], present: string[]): string[] {
    if (saved.length === 0) return present
    const savedSet = new Set(saved)
    const presentSet = new Set(present)
    return [...present.filter(k => !savedSet.has(k)), ...saved.filter(k => presentSet.has(k))]
}

/** `order` with `key` moved to just before `before` (null = to the end). */
export function moveBefore(order: string[], key: string, before: string | null): string[] {
    const out = order.filter(k => k !== key)
    const at = before === null ? -1 : out.indexOf(before)
    if (at < 0) out.push(key)
    else out.splice(at, 0, key)
    return out
}

export const savedBarOrder = (): string[] => store.get("barOrder")
/** Save the order Settings shows. What it does not name falls to the left end later. */
export const setSavedBarOrder = (order: string[]) => store.set("barOrder", [...order])
/** Back to the derived order. */
export const resetBarOrder = () => store.set("barOrder", [])

/** An item kept out of the bar by the person: a tray icon or search (`bar-hidden`,
 *  by order key). A widget's own switch is its placement (core/WidgetConfig.ts). */
export const isBarHidden = (key: string): boolean => store.get("barHidden").includes(key)
export function setBarHidden(key: string, hidden: boolean) {
    const now = store.get("barHidden").filter(k => k !== key)
    if (hidden) now.push(key)
    store.set("barHidden", now)
}

export interface KnownTrayItem { id: string, title: string, icon: string, appId: string }

/** Tray icons seen so far, in the order they were first seen. */
export const knownTrayItems = (): KnownTrayItem[] =>
    Object.entries(store.get("trayKnown")).map(([id, [title, icon, appId]]) => ({ id, title, icon, appId }))

/** Called by the shell when an app shows a tray icon. Writes only when something changed:
 *  every bar (one per monitor) reports the same item. */
export function rememberTrayItem(sniId: string, title: string, icon: string, appId: string) {
    const known = store.get("trayKnown")
    const prev = known[sniId]
    if (prev && prev[0] === title && prev[1] === icon && prev[2] === appId) return
    store.set("trayKnown", { ...known, [sniId]: [title, icon, appId] })
}

/** Any of the three keys changed — here or in another process (Settings). */
export function watchBarOrder(cb: () => void): () => void {
    const offs = [
        store.subscribe("barOrder", cb),
        store.subscribe("barHidden", cb),
        store.subscribe("trayKnown", cb),
    ]
    return () => { for (const off of offs) off() }
}
