import GLib from "gi://GLib"
import registry, { widgetAvailable } from "../widgets/index"
import widgetConfig from "./WidgetConfig"
import status from "./Status"
import ccLayout from "../surfaces/control-center/CCLayoutManager"
import type { WidgetCatalog } from "./WidgetCatalog"

/**
 * The shell's side of the widget catalogue seam (`core/WidgetCatalog.ts`): the registry,
 * the placement store and the CC grid, answered as data. Imported by `app.ts` ONLY —
 * this module is exactly what Settings must not reach (#571).
 */
export const widgetCatalogSource: WidgetCatalog = {
    list: () => registry.all().map(w => {
        const placement = widgetConfig.get(w.id)
        const canCc = w.locations?.includes("cc") ?? false
        return {
            id: w.id,
            name: w.name,
            icon: w.icon ?? null,
            category: w.category,
            barOrder: w.barOrder ?? 0,
            canBar: (w.locations?.includes("bar") ?? false) && w.buildBarContent != null,
            canCc,
            available: widgetAvailable(w),
            bar: placement.bar,
            barMode: widgetConfig.barModeChoosable(w.id) ? widgetConfig.barMode(w.id) : null,
            cc: placement.cc,
            ccFixed: canCc && widgetConfig.ccFixed(w.id),
            ccFits: canCc && (placement.cc || ccLayout.canAdd(w.id)),
        }
    }),
    setBar: (id, on) => widgetConfig.setBar(id, on),
    setBarMode: (id, mode) => widgetConfig.setBarMode(id, mode),
    editBarOrder: () => { status.bar_edit_mode = true },
    setCc: (id, on) => {
        widgetConfig.setCC(id, on)
        if (on) ccLayout.add(id)
        else ccLayout.remove(id)
    },
}

// Session-lifetime subscriptions, like the registry's watchAvailable contract.
// Coalesce the placement flag and grid-cell changes into one settled snapshot.
let notificationsStarted = false
export function startWidgetCatalogNotifications(changed: () => void): void {
    if (notificationsStarted) return
    notificationsStarted = true
    let pending = 0
    const schedule = () => {
        if (pending) return
        pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pending = 0
            changed()
            return GLib.SOURCE_REMOVE
        })
    }
    widgetConfig.connect("changed", schedule)
    ccLayout.connect("changed", schedule)
    for (const w of registry.all()) w.watchAvailable?.(schedule)
}
