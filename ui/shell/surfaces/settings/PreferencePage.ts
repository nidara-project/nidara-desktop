import Gtk from "gi://Gtk?version=4.0"
import { manifest, type PageDecl, type WhenDecl, type ItemDecl } from "./manifest"
import { listGroup, createRow, settingRow, pageBox, bindWhileRealized, setPageRefresherScope, clearPageRefresherScope } from "./SettingsHelpers"
import { getConfigEntry } from "../../core/ConfigRegistry"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import { build as buildBar } from "./custom/bar"
import { build as buildGaming } from "./custom/gaming"
import { build as buildPower } from "./custom/power"
import { build as buildRegion } from "./custom/region"
import { build as buildAppearance } from "./custom/appearance"
import { build as buildAi } from "./custom/ai"

export interface PageCtx {
    page: Gtk.Widget
    pageId: string
}

/** What a builder is told about the slot it fills. `title` and `subtitle` arrive
 *  ALREADY TRANSLATED: the manifest's i18n key is resolved here, once, so a builder
 *  cannot render a label the manifest did not declare — which is the whole point of
 *  declaring one. A decoration and a page header get empty strings: they have no
 *  identity to render. A custom GROUP gets its declared title and no subtitle. */
export interface SlotDecl {
    title: string
    subtitle: string
}

export type ItemBuilder = (slot: SlotDecl) => Gtk.Widget

const NO_LABEL: SlotDecl = { title: "", subtitle: "" }

const PAGE_BUILDERS = {
    bar: buildBar,
    gaming: buildGaming,
    power: buildPower,
    region: buildRegion,
    appearance: buildAppearance,
    ai: buildAi,
} as const

// ── Compile-time type verification ──────────────────────────────────────────
// Ensures every declared custom/decoration/header in manifest has a matching builder,
// and that builders do not define unreferenced items.
type Manifest = typeof manifest

type ExtractItemCustoms<I> =
    (I extends { custom: infer IC extends string } ? IC : never) |
    (I extends { decoration: infer DC extends string } ? DC : never) |
    (I extends { items: readonly (infer SubI)[] } ? ExtractItemCustoms<SubI> : never)

type ExtractCustoms<P> =
    (P extends { header?: { custom: infer C extends string } } ? C : never) |
    (P extends { groups: readonly (infer G)[] }
        ? (G extends { custom?: infer GC extends string } ? GC : never) |
          (G extends { items?: readonly (infer I)[] }
              ? ExtractItemCustoms<I>
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

const _checkAppearance = (null as unknown as ValidatePage<"appearance">) satisfies true
const _checkAppearanceExtra = (null as unknown as ValidateBuilder<"appearance">) satisfies true

const _checkAi = (null as unknown as ValidatePage<"ai">) satisfies true
const _checkAiExtra = (null as unknown as ValidateBuilder<"ai">) satisfies true

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

function bindSensitivity(widget: Gtk.Widget, page: Gtk.Widget, when: WhenDecl) {
    const entry = getConfigEntry(when.key)
    if (!entry) {
        throw new Error(`[buildPreferencePage] sensitiveWhen references unknown config key "${when.key}"`)
    }
    const sync = () => {
        const val = String(entry.get())
        widget.sensitive = when.in.includes(val)
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

    setPageRefresherScope(pageId)
    try {
        const page = pageBox(`${pageId}-page`)
        const ctx: PageCtx = { page, pageId }

        const builderFactory = PAGE_BUILDERS[pageId as keyof typeof PAGE_BUILDERS]
        const builders: Record<string, ItemBuilder> = builderFactory ? builderFactory(ctx) : {}

        if (pageDecl.header) {
            const headerBuilder = builders[pageDecl.header.custom]
            if (!headerBuilder) {
                throw new Error(`[buildPreferencePage] Missing header builder "${pageDecl.header.custom}" on page "${pageId}"`)
            }
            page.append(headerBuilder(NO_LABEL))
        }

        for (const group of (pageDecl.groups ?? [])) {
            if (group.custom) {
                const groupBuilder = builders[group.custom]
                if (!groupBuilder) {
                    throw new Error(`[buildPreferencePage] Missing custom group builder "${group.custom}" on page "${pageId}"`)
                }
                page.append(groupBuilder({ title: group.i18n ? t(group.i18n as any) : "", subtitle: "" }))
                continue
            }

            const title = group.i18n ? t(group.i18n as any) : ""
            const footer = group.footer ? t(group.footer as any) : ""
            const groupWidget = listGroup(title, footer)

            const appendItem = (item: ItemDecl, container: { append(w: Gtk.Widget): void }) => {
                if (typeof item === "string") {
                    const row = settingRow(item)
                    container.append(row)
                } else if ("custom" in item) {
                    const ib = builders[item.custom]
                    if (!ib) {
                        throw new Error(`[buildPreferencePage] Missing custom item builder "${item.custom}" on page "${pageId}"`)
                    }
                    const row = ib({ title: t(item.i18n as any), subtitle: t(`${item.i18n}.desc` as any) })
                    if (item.visibleWhen) {
                        bindVisibility(row, page, item.visibleWhen)
                    }
                    if (item.sensitiveWhen) {
                        bindSensitivity(row, page, item.sensitiveWhen)
                    }
                    container.append(row)
                } else if ("decoration" in item) {
                    const db = builders[item.decoration]
                    if (!db) {
                        throw new Error(`[buildPreferencePage] Missing decoration builder "${item.decoration}" on page "${pageId}"`)
                    }
                    const row = db(NO_LABEL)
                    if (item.visibleWhen) {
                        bindVisibility(row, page, item.visibleWhen)
                    }
                    if (item.sensitiveWhen) {
                        bindSensitivity(row, page, item.sensitiveWhen)
                    }
                    container.append(row)
                } else if ("disclosure" in item) {
                    const advChevron = new Gtk.Image({ gicon: Icons.chevronDown, pixel_size: 16, css_classes: ["nd-icon"] })
                    const advToggleRow = createRow(t(item.disclosure as any), "", advChevron)
                    container.append(advToggleRow)

                    const advInner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
                    for (const subItem of item.items) {
                        appendItem(subItem, advInner)
                    }
                    const advRevealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN, reveal_child: true })
                    advRevealer.set_child(advInner)
                    const advRevealerRow = new Gtk.ListBoxRow({ activatable: false, selectable: false, css_classes: ["settings-adv-revealer-row"] })
                    advRevealerRow.set_child(advRevealer)
                    container.append(advRevealerRow)

                    groupWidget.listBox.connect("row-activated", (_: Gtk.ListBox, row: Gtk.ListBoxRow) => {
                        if (row !== advToggleRow) return
                        const open = !advRevealer.reveal_child
                        advRevealer.reveal_child = open
                        advChevron.gicon = open ? Icons.chevronDown : Icons.chevronRight
                    })
                } else if ("key" in item) {
                    const row = settingRow(item.key)
                    if (item.visibleWhen) {
                        bindVisibility(row, page, item.visibleWhen)
                    }
                    if (item.sensitiveWhen) {
                        bindSensitivity(row, page, item.sensitiveWhen)
                    }
                    container.append(row)
                } else {
                    throw new Error(`[buildPreferencePage] Unsupported item in page "${pageId}": ${JSON.stringify(item)}`)
                }
            }

            for (const item of (group.items ?? [])) {
                appendItem(item, groupWidget.listBox)
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
    } finally {
        clearPageRefresherScope()
    }
}

