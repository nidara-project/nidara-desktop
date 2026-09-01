import Gtk from "gi://Gtk?version=4.0"
import { manifest } from "./manifest"
import { listGroup, settingRow, pageBox, bindWhileRealized } from "./SettingsHelpers"
import { getConfigEntry } from "../../core/ConfigRegistry"
import { t } from "../../core/i18n"

export function buildPreferencePage(pageId: string): Gtk.Widget {
    const pageDecl = manifest.find((p) => p.id === pageId)
    if (!pageDecl) {
        throw new Error(`[buildPreferencePage] Unknown preference page id: "${pageId}" in manifest`)
    }

    const page = pageBox(`${pageId}-page`)

    for (const group of pageDecl.groups) {
        const title = group.i18n ? t(group.i18n as any) : ""
        const footer = group.footer ? t(group.footer as any) : ""
        const groupWidget = listGroup(title, footer)

        for (const item of group.items) {
            if (typeof item !== "string") {
                throw new Error(`[buildPreferencePage] Unsupported item in page "${pageId}": only string config keys supported in P1`)
            }
            const row = settingRow(item)
            groupWidget.listBox.append(row)
        }

        if (group.footerWhen) {
            const { key, in: allowedValues } = group.footerWhen
            const footerLabel = groupWidget.footerLabel
            if (footerLabel) {
                const entry = getConfigEntry(key)
                if (!entry) {
                    throw new Error(`[buildPreferencePage] footerWhen references unknown config key "${key}"`)
                }
                const syncFooter = () => {
                    const val = String(entry.get())
                    footerLabel.visible = allowedValues.includes(val)
                }
                syncFooter()
                bindWhileRealized(page, () => {
                    syncFooter()
                    if (entry.subscribe) {
                        return entry.subscribe(() => syncFooter())
                    }
                    return () => {}
                })
            }
        }

        page.append(groupWidget.box)
    }

    return page
}
