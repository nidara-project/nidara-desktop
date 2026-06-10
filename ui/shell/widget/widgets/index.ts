import Gio from "gi://Gio"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
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

// Curated bar pill order (system/connectivity widgets rightmost, nearest the tray).
// Any registered bar-capable widget not listed here falls to the end (see WidgetConfig).
export const BAR_ORDER: string[] = [
    "media",
    "cpu_memory",
    "battery",
    "brightness",
    "dark_mode",
    "focus",
    "night_light",
    "calculator",
    "clipboard",
    "screenshot",
    "screenrecord",
    "vpn",
    "bt",
    "ethernet",
    "wifi",
    "volume",
]

// CC initial seed order. Widgets enabled by default but not listed here are
// appended by IslandGrid's reconciliation pass (syncCCLayout).
export const CC_DEFAULT_ORDER: string[] = [
    "media",
    "wifi",
    "ethernet",
    "focus",
    "dark_mode",
    "bt",
    "volume",
    "cpu_memory",
    "calculator",
]
