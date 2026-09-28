import Gio from "gi://Gio"
import { AtomicWidget, WidgetSize, WidgetCategory, CATEGORY_ORDER } from "../common/widget-kit"
// Auto-registration: ALL_WIDGETS comes from the generated widgets.gen.ts —
// dropping a file in widgets/ that default-exports an AtomicWidget is ALL it
// takes to register a widget (see scripts/gen-widget-index.mjs).
import { ALL_WIDGETS } from "./widgets.gen"
import { sortWidgetsForBar } from "../core/BarOrder"

const _map = new Map<string, AtomicWidget>(ALL_WIDGETS.map(w => [w.id, w]))

export const registry = {
    get: (id: string): AtomicWidget | null => _map.get(id) ?? null,
    all: (): AtomicWidget[] => [...ALL_WIDGETS],
    barCapable: (): AtomicWidget[] => ALL_WIDGETS.filter(w => w.locations?.includes("bar")),
    ccCapable:  (): AtomicWidget[] => ALL_WIDGETS.filter(w => w.locations?.includes("cc")),
}

export default registry

// ── Hardware availability ─────────────────────────────────────────────────────
// A widget without hardware does not exist for the user: hidden from bar + CC,
// disabled in Settings → Widgets. Placement config is never mutated by this, so
// the widget reappears when the hardware does (see AtomicWidget.isAvailable).

export const widgetAvailable = (w: AtomicWidget): boolean => w.isAvailable?.() ?? true

// Re-run cb whenever any widget's availability may have changed (BT adapter
// plugged, wifi device gone…). Subscriptions are shell-lifetime — callers are
// the per-monitor bar and the CC grid, which live as long as the shell.
export function watchWidgetAvailability(cb: () => void) {
    for (const w of ALL_WIDGETS) w.watchAvailable?.(cb)
}

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth — derived metadata
//
// WIDGET_META, BAR_ORDER and DEFAULT_PLACEMENT used to be hand-maintained
// literals duplicated across CCLayoutManager and WidgetConfig. They are now
// derived from the AtomicWidget definitions so name/icon/size never drift, and
// every registered widget (e.g. battery) is automatically reachable.
// ─────────────────────────────────────────────────────────────────────────────

export interface WidgetMeta {
    name: string
    defaultSize: WidgetSize
    sizes: WidgetSize[]
    icon: Gio.FileIcon
}

// CC-capable widgets keyed by id — consumed by CCLayoutManager + the Settings CC page.
export const WIDGET_META: Record<string, WidgetMeta> = Object.fromEntries(
    ALL_WIDGETS
        .filter(w => w.locations?.includes("cc"))
        .map(w => [w.id, {
            name: w.name,
            defaultSize: w.defaultSize,
            sizes: w.supportedSizes,
            icon: w.icon!,
        }])
)

// The widgets that are always in the CC while their hardware is present (AtomicWidget.ccFixed).
export const CC_FIXED: ReadonlySet<string> = new Set(
    ALL_WIDGETS.filter(w => w.ccFixed && w.locations?.includes("cc")).map(w => w.id))

// Default first-run placement: cc default = widget is cc-capable; bar default = defaultInBar flag.
// A fixed widget is in the CC whatever the defaults say (core/WidgetConfig.ts enforces it).
export const DEFAULT_PLACEMENT: Record<string, { bar: boolean; cc: boolean }> = Object.fromEntries(
    ALL_WIDGETS.map(w => [w.id, {
        bar: w.defaultInBar ?? false,
        cc: CC_FIXED.has(w.id) || (w.defaultInCc ?? (w.locations?.includes("cc") ?? false)),
    }])
)

// How a widget that can say it is ACTIVE shows in the bar before the person picks — and
// only a FIXED one gets to pick (contract.ts `barActive`): its own `defaultBarMode`, else
// "always". A widget without `barActive` is absent — it has no mode, it is simply shown or
// not; one with `barActive` but not fixed is in BAR_PRESENCE (core/WidgetConfig.ts barMode).
export const DEFAULT_BAR_MODE: Record<string, "always" | "active"> = Object.fromEntries(
    ALL_WIDGETS.filter(w => w.barActive && CC_FIXED.has(w.id)).map(w => [w.id, w.defaultBarMode ?? "always"])
)

// Presence indicators: in the bar only while `barActive()` holds, with no choice offered.
export const BAR_PRESENCE: ReadonlySet<string> = new Set(
    ALL_WIDGETS.filter(w => w.barActive && !CC_FIXED.has(w.id)).map(w => w.id))

// Declared in the contract (Settings reads it without importing a widget); re-exported for the bar.
export { CATEGORY_ORDER }

// Curated bar pill order, DERIVED from each widget's declared category + barOrder —
// no hand-maintained list. Adding a widget places it in its category automatically.
// Sort: category index, then barOrder (lower = further left), then registration
// order as a stable tie-break. Any bar-capable widget is included.
// The sort itself is core/BarOrder.ts's, shared with Settings so the page shows the
// default the bar paints. This is only the DEFAULT: the person's own order, and where
// tray icons and search go, is resolved on top of it (BarOrder.resolveOrder).
export const BAR_ORDER: string[] = sortWidgetsForBar(ALL_WIDGETS.filter(w => w.locations?.includes("bar")))
    .map(w => w.id)

// The CC's default layout, in reading order, each tile at its default footprint here
// (owner, 2026-09-28: his own arrangement, with Display above Sound as macOS has them).
// Until the person moves or resizes a tile, the grid is PACKED from this list at every
// change (CCLayoutManager's default mode): a tile whose hardware is missing is simply
// skipped and the ones after it move up, so a desktop without Wi-Fi, Bluetooth or a
// backlight gets no hole. That is what lets Wi-Fi sit at the top — before, hardware
// tiles were appended at the END so that their absence could not leave a hole.
// A widget the person adds to the CC that is not listed here packs after these.
export const CC_DEFAULT_LAYOUT: ReadonlyArray<{ id: string; size: WidgetSize }> = [
    { id: "media",        size: WidgetSize.SQUARE },
    { id: "wifi",         size: WidgetSize.WIDE },
    { id: "bt",           size: WidgetSize.WIDE },
    { id: "brightness",   size: WidgetSize.FULL_WIDTH },
    { id: "volume",       size: WidgetSize.FULL_WIDTH },
    { id: "screenshot",   size: WidgetSize.SINGLE },
    { id: "screenrecord", size: WidgetSize.SINGLE },
    { id: "dark_mode",    size: WidgetSize.WIDE },
    { id: "night_light",  size: WidgetSize.WIDE },
    { id: "focus",        size: WidgetSize.WIDE },
]
