import registry, { widgetAvailable } from "../widgets/index"
import widgetConfig from "./WidgetConfig"
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
            cc: placement.cc,
            ccFits: canCc && (placement.cc || ccLayout.canAdd(w.id)),
            buildSettings: w.buildSettings,
        }
    }),
    setBar: (id, on) => widgetConfig.setBar(id, on),
    setCc: (id, on) => {
        widgetConfig.setCC(id, on)
        if (on) ccLayout.add(id)
        else ccLayout.remove(id)
    },
}
