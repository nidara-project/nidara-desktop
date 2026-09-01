import Gtk from "gi://Gtk?version=4.0"
import { manifest, type PageDecl, type WhenDecl } from "./manifest"
import { listGroup, settingRow, pageBox, bindWhileRealized } from "./SettingsHelpers"
import { getConfigEntry } from "../../core/ConfigRegistry"
import { t } from "../../core/i18n"
import { build as buildBar } from "./custom/bar"
import { build as buildGaming } from "./custom/gaming"
import { build as buildPower } from "./custom/power"
import { build as buildRegion } from "./custom/region"

export interface PageCtx {
    page: Gtk.Widget
    pageId: string
}

export type ItemBuilder = (decl?: any) => Gtk.Widget

const PAGE_BUILDERS = {
    bar: buildBar,
    gaming: buildGaming,
    power: buildPower,
    region: buildRegion,
} as const

// ── Compile-time type verification ──────────────────────────────────────────
// Ensures every declared custom/decoration/header in manifest has a matching builder,
// and that builders do not define unreferenced items.
type Manifest = typeof manifest

type ExtractCustoms<P> =
    (P extends { header?: { custom: infer C extends string } } ? C : never) |
    (P extends { groups: readonly (infer G)[] }
        ? (G extends { custom?: infer GC extends string } ? GC : never) |
          (G extends { items?: readonly (infer I)[] }
              ? (I extends { custom: infer IC extends string } ? IC : never) |
                (I extends { decoration: infer DC extends string } ? DC : never)
              : never)
        : never)

type PageFromManifest<Id extends string> = Extract<Manifest[number], { id: Id }>

type ValidatePage<Id extends keyof typeof PAGE_BUILDERS> =
    ExtractCustoms<PageFromManifest<Id>> extends keyof ReturnType<(typeof PAGE_BUILDERS)[Id]>
        ? true
        : {
            error: "Declared custom item has no matching builder"
            missingBuilders: Exclude<ExtractCustoms<PageFromManifest<Id>>, keyof ReturnType<(typeof PAGE_BUILDERS)[Id]>>
        }

type ValidateBuilder<Id extends keyof typeof PAGE_BUILDERS> =
    keyof ReturnType<(typeof PAGE_BUILDERS)[Id]> extends ExtractCustoms<PageFromManifest<Id>>
        ? true
        : {
            error: "Builder has extra unused item"
            extraBuilders: Exclude<keyof ReturnType<(typeof PAGE_BUILDERS)[Id]>, ExtractCustoms<PageFromManifest<Id>>>
        }

const _checkBar = (null as unknown as ValidatePage<"bar">) satisfies true
const _checkBarExtra = (null as unknown as ValidateBuilder<"bar">) satisfies true

const _checkGaming = (null as unknown as ValidatePage<"gaming">) satisfies true
const _checkGamingExtra = (null as unknown as ValidateBuilder<"gaming">) satisfies true

const _checkPower = (null as unknown as ValidatePage<"power">) satisfies true
const _checkPowerExtra = (null as unknown as ValidateBuilder<"power">) satisfies true

const _checkRegion = (null as unknown as ValidatePage<"region">) satisfies true
const _checkRegionExtra = (null as unknown as ValidateBuilder<"region">) satisfies true

function bindVisibility(widget: Gtk.Widget, page: Gtk.Widget, when: WhenDecl) {
    const entry = getConfigEntry(when.key)
    if (!entry) {
        throw new Error(`[buildPreferencePage] visibleWhen/footerWhen references unknown config key "${when.key}"`)
    }
    const sync = () => {
        const val = String(entry.get())
        widget.visible = when.in.includes(val)
    }
    sync()
    bindWhileRealized(page, () => {
        sync()
        if (entry.subscribe) {
            return entry.subscribe(() => sync())
        }
        return () => {}
    })
}

export function buildPreferencePage(pageId: string): Gtk.Widget {
    const pageDecl: PageDecl | undefined = (manifest as readonly PageDecl[]).find((p) => p.id === pageId)
    if (!pageDecl) {
        throw new Error(`[buildPreferencePage] Unknown preference page id: "${pageId}" in manifest`)
    }

    const page = pageBox(`${pageId}-page`)
    const ctx: PageCtx = { page, pageId }

    const builderFactory = PAGE_BUILDERS[pageId as keyof typeof PAGE_BUILDERS]
    const builders: Record<string, ItemBuilder> = builderFactory ? builderFactory(ctx) : {}

    if (pageDecl.header) {
        const headerBuilder = builders[pageDecl.header.custom]
        if (!headerBuilder) {
            throw new Error(`[buildPreferencePage] Missing header builder "${pageDecl.header.custom}" on page "${pageId}"`)
        }
        page.append(headerBuilder())
    }

    for (const group of pageDecl.groups) {
        if (group.custom) {
            const groupBuilder = builders[group.custom]
            if (!groupBuilder) {
                throw new Error(`[buildPreferencePage] Missing custom group builder "${group.custom}" on page "${pageId}"`)
            }
            const title = group.i18n ? t(group.i18n as any) : ""
            page.append(groupBuilder(title))
            continue
        }

        const title = group.i18n ? t(group.i18n as any) : ""
        const footer = group.footer ? t(group.footer as any) : ""
        const groupWidget = listGroup(title, footer)

        for (const item of (group.items ?? [])) {
            if (typeof item === "string") {
                const row = settingRow(item)
                groupWidget.listBox.append(row)
            } else if ("custom" in item) {
                const ib = builders[item.custom]
                if (!ib) {
                    throw new Error(`[buildPreferencePage] Missing custom item builder "${item.custom}" on page "${pageId}"`)
                }
                const row = ib(item)
                if (item.visibleWhen) {
                    bindVisibility(row, page, item.visibleWhen)
                }
                groupWidget.listBox.append(row)
            } else if ("decoration" in item) {
                const db = builders[item.decoration]
                if (!db) {
                    throw new Error(`[buildPreferencePage] Missing decoration builder "${item.decoration}" on page "${pageId}"`)
                }
                const row = db(item)
                if (item.visibleWhen) {
                    bindVisibility(row, page, item.visibleWhen)
                }
                groupWidget.listBox.append(row)
            } else {
                throw new Error(`[buildPreferencePage] Unsupported item in page "${pageId}": ${JSON.stringify(item)}`)
            }
        }

        if (group.footerWhen) {
            const footerLabel = groupWidget.footerLabel
            if (footerLabel) {
                bindVisibility(footerLabel, page, group.footerWhen)
            }
        }

        page.append(groupWidget.box)
    }

    return page
}
