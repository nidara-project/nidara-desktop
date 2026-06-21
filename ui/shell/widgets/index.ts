import Gio from "gi://Gio"
import { AtomicWidget, WidgetSize, WidgetCategory } from "../surfaces/control-center/Types"
// Auto-registration: ALL_WIDGETS comes from the generated widgets.gen.ts —
// dropping a file in widgets/ that default-exports an AtomicWidget is ALL it
// takes to register a widget (see scripts/gen-widget-index.mjs).
import { ALL_WIDGETS } from "./widgets.gen"

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

// Default first-run placement: cc default = widget is cc-capable; bar default = defaultInBar flag.
export const DEFAULT_PLACEMENT: Record<string, { bar: boolean; cc: boolean }> = Object.fromEntries(
    ALL_WIDGETS.map(w => [w.id, {
        bar: w.defaultInBar ?? false,
        cc: w.defaultInCc ?? (w.locations?.includes("cc") ?? false),
    }])
)

// Category order, left → right across the bar: optional/content on the left,
// system/connectivity on the right (nearest the tray), macOS-style. Also the
// section order in Settings → Widgets.
export const CATEGORY_ORDER: WidgetCategory[] = ["media", "utilities", "system"]

// Curated bar pill order, DERIVED from each widget's declared category + barOrder —
// no hand-maintained list. Adding a widget places it in its category automatically.
// Sort: category index, then barOrder (lower = further left), then registration
// order as a stable tie-break. Any bar-capable widget is included.
export const BAR_ORDER: string[] = ALL_WIDGETS
    .filter(w => w.locations?.includes("bar"))
    .map((w, i) => ({ w, i }))
    .sort((a, b) =>
        (CATEGORY_ORDER.indexOf(a.w.category) - CATEGORY_ORDER.indexOf(b.w.category)) ||
        ((a.w.barOrder ?? 0) - (b.w.barOrder ?? 0)) ||
        (a.i - b.i))
    .map(({ w }) => w.id)

// CC initial seed order — UNIVERSAL widgets only (always available, no hardware gate).
// Hardware-gated default widgets (wifi, bt, brightness — defaultInCc true but isAvailable
// hardware-dependent) are deliberately NOT seeded here: IslandGrid's syncCCLayout adds them
// to a free cell only when their hardware is present. This is load-bearing — seeding a
// hardware-gated tile here would have it removed on hardware-less machines (e.g. a desktop
// without a backlight), and CCLayoutManager.remove() does NOT reflow, so it would leave a
// hole. Keep this list to widgets that are always available; let the adaptive ones append.
export const CC_DEFAULT_ORDER: string[] = [
    "media",
    "dark_mode",
    "focus",
    "volume",
    "cpu_memory",
    "calculator",
]
