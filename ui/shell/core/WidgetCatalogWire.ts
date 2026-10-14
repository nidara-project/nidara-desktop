import type { WidgetCatalog, WidgetCatalogEntry } from "./WidgetCatalog"

export const CATALOG_VERSION = 1
export const SHELL_BUS = "org.nidara.Shell"
export const SHELL_PATH = "/org/nidara/Shell"
export const CATALOG_SIGNAL = "WidgetCatalogChanged"
export type WireEntry = Omit<WidgetCatalogEntry, "icon"> & { icon: string | null }
export interface CatalogReply { version: number; entries: WireEntry[] }

export function catalogSnapshot(catalog: WidgetCatalog): CatalogReply {
    return { version: CATALOG_VERSION, entries: catalog.list().map(({ icon, ...entry }) => ({
        ...entry, icon: icon?.to_string() ?? null,
    })) }
}

/** Reject mismatched or malformed replies before they become UI state. */
export function readCatalogReply(text: string): CatalogReply {
    const reply = JSON.parse(text)
    if (reply?.version !== CATALOG_VERSION || !Array.isArray(reply.entries))
        throw Error("Unsupported widget catalogue reply")
    const ids = new Set<string>()
    for (const w of reply.entries) {
        if (!w || typeof w.id !== "string" || !w.id || ids.has(w.id)
            || typeof w.name !== "string" || !["system", "utilities", "media"].includes(w.category)
            || !Number.isFinite(w.barOrder) || !(w.icon === null || typeof w.icon === "string")
            || !(w.barMode === null || w.barMode === "always" || w.barMode === "active")
            || ["canBar", "canCc", "available", "bar", "cc", "ccFixed", "ccFits"].some(k => typeof w[k] !== "boolean"))
            throw Error("Malformed widget catalogue entry")
        ids.add(w.id)
    }
    return reply
}

/** One command through ShellActions/Request; invalid arguments never mutate stores. */
export async function widgetCatalogRequest(catalog: WidgetCatalog, args: string[]): Promise<string> {
    const [verb = "list", id, value] = args
    if (verb === "list" && args.length <= 1) return JSON.stringify(catalogSnapshot(catalog))
    if (verb === "editBarOrder" && args.length === 1) {
        await catalog.editBarOrder()
        return JSON.stringify(catalogSnapshot(catalog))
    }
    if (!["bar", "cc", "mode"].includes(verb) || args.length !== 3)
        throw Error("usage: widgetCatalog [list | bar <id> <true|false> | cc <id> <true|false> | mode <id> <always|active> | editBarOrder]")
    const entry = catalog.list().find(w => w.id === id)
    if (!entry) throw Error(`Unknown widget: ${id}`)
    if (verb === "mode") {
        if (value !== "always" && value !== "active") throw Error("Invalid bar mode")
        if (!entry.canBar || entry.barMode === null) throw Error("Widget has no selectable bar mode")
        await catalog.setBarMode(id, value)
    } else {
        if (value !== "true" && value !== "false") throw Error("Expected true or false")
        const on = value === "true"
        if (verb === "bar") {
            if (!entry.canBar) throw Error("Widget has no bar variant")
            if (on && !entry.available) throw Error("Widget hardware is unavailable")
            await catalog.setBar(id, on)
        } else {
            if (!entry.canCc) throw Error("Widget has no Control Center variant")
            if (!on && entry.ccFixed) throw Error("Widget is fixed in the Control Center")
            if (on && !entry.available) throw Error("Widget hardware is unavailable")
            if (on && !entry.cc && !entry.ccFits) throw Error("Control Center has no free cell")
            await catalog.setCc(id, on)
        }
    }
    const after = catalog.list().find(w => w.id === id)
    const applied = verb === "mode" ? after?.barMode === value
        : verb === "bar" ? after?.bar === (value === "true") : after?.cc === (value === "true")
    if (!applied) throw Error("Widget placement did not change to the requested value")
    return JSON.stringify(catalogSnapshot(catalog))
}
