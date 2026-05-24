import { Gtk } from "ags/gtk4"
import ccLayout, { WIDGET_META, SIZE_MAP } from "../../control-center/CCLayoutManager"
import { pageBox, pageHeader, listGroup } from "../SettingsHelpers"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"

function sizeLabel(id: string): string {
    const size = ccLayout.effectiveSize(id)
    const { w, h } = SIZE_MAP[size]
    return `${w}×${h}`
}

export default function ControlCenterPage(): Gtk.Widget {
    const page = pageBox("cc-settings-page")
    page.append(pageHeader(t("settings.controlcenter.page.title.centro-de-control"), t("settings.controlcenter.page.subtitle.gestiona-los-widgets-del-panel-de-contro")))

    const activeGroup   = listGroup(t("settings.controlcenter.group.widgets-activos"))
    const inactiveGroup = listGroup(t("settings.controlcenter.group.widgets-disponibles"))

    const rebuild = () => {
        // Clear both list boxes
        ;[activeGroup.listBox, inactiveGroup.listBox].forEach(lb => {
            let c = lb.get_first_child()
            while (c) { const n = c.get_next_sibling(); lb.remove(c); c = n }
        })

        // Active widgets
        const activeIds = ccLayout.activeIds()
        if (activeIds.length === 0) {
            const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            row.set_child(new Gtk.Label({
                label: t("settings.controlcenter.label.no-hay-widgets-activos"),
                css_classes: ["settings-row-subtitle"],
                margin_top: 12, margin_bottom: 12, margin_start: 16,
                halign: Gtk.Align.START,
            }))
            activeGroup.listBox.append(row)
        }

        for (const id of activeIds) {
            const meta = WIDGET_META[id]
            if (!meta) continue

            const box = new Gtk.Box({ spacing: 12, margin_start: 16, margin_end: 12, margin_top: 10, margin_bottom: 10 })

            box.append(new Gtk.Image({ gicon: meta.icon, pixel_size: 20, css_classes: ["sidebar-icon", "cs-icon"] }))

            const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER })
            text.append(new Gtk.Label({ label: meta.name, css_classes: ["settings-row-label"], halign: Gtk.Align.START }))
            text.append(new Gtk.Label({
                label: `Tamaño ${sizeLabel(id)}`,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
            box.append(text)

            const removeBtn = new Gtk.Button({
                child: new Gtk.Image({ gicon: Icons.minus, pixel_size: 16 , css_classes: ["cs-icon"] }),
                css_classes: ["settings-icon-btn", "settings-icon-btn--danger"],
                valign: Gtk.Align.CENTER,
                tooltip_text: t("settings.controlcenter.tooltip.quitar-del-cc"),
            })
            removeBtn.connect("clicked", () => { ccLayout.remove(id); rebuild() })
            box.append(removeBtn)

            const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            row.set_child(box)
            activeGroup.listBox.append(row)
        }

        // Inactive (available) widgets
        const inactiveIds = ccLayout.inactiveIds()
        if (inactiveIds.length === 0) {
            const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            row.set_child(new Gtk.Label({
                label: t("settings.controlcenter.label.todos-los-widgets-estan-activos"),
                css_classes: ["settings-row-subtitle"],
                margin_top: 12, margin_bottom: 12, margin_start: 16,
                halign: Gtk.Align.START,
            }))
            inactiveGroup.listBox.append(row)
        }

        for (const id of inactiveIds) {
            const meta = WIDGET_META[id]
            if (!meta) continue
            const { w, h } = SIZE_MAP[meta.defaultSize]

            const box = new Gtk.Box({ spacing: 12, margin_start: 16, margin_end: 12, margin_top: 10, margin_bottom: 10 })

            box.append(new Gtk.Image({ gicon: meta.icon, pixel_size: 20, css_classes: ["sidebar-icon", "cs-icon"] }))

            const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER })
            text.append(new Gtk.Label({ label: meta.name, css_classes: ["settings-row-label"], halign: Gtk.Align.START }))
            text.append(new Gtk.Label({
                label: `Tamaño por defecto ${w}×${h}`,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
            box.append(text)

            const addBtn = new Gtk.Button({
                child: new Gtk.Image({ gicon: Icons.plus, pixel_size: 16 , css_classes: ["cs-icon"] }),
                css_classes: ["settings-icon-btn"],
                valign: Gtk.Align.CENTER,
                tooltip_text: t("settings.controlcenter.tooltip.anadir-al-cc"),
            })
            addBtn.connect("clicked", () => { ccLayout.add(id); rebuild() })
            box.append(addBtn)

            const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            row.set_child(box)
            inactiveGroup.listBox.append(row)
        }
    }

    rebuild()

    // Refresh when layout changes from outside (e.g. Widgets page toggling CC placement)
    const layoutSigId = ccLayout.connect("changed", rebuild)
    page.connect("unrealize", () => { try { ccLayout.disconnect(layoutSigId) } catch {} })

    page.append(activeGroup.box)
    page.append(inactiveGroup.box)
    return page
}
