import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import { listGroup, pageHeader, pageBox } from "../SettingsHelpers"

export default function PowerPage() {
    const page = pageBox("power-page")
    page.append(pageHeader("Energía", "Administra el rendimiento y el consumo de batería"))

    const profileGroup = listGroup("Perfil de Rendimiento")
    // Override selection_mode for this specific group
    profileGroup.listBox.selection_mode = Gtk.SelectionMode.SINGLE

    const profiles = [
        { id: "performance",  label: "Alto Rendimiento",  icon: "power-profile-performance-symbolic" },
        { id: "balanced",     label: "Equilibrado",        icon: "power-profile-balanced-symbolic" },
        { id: "power-saver",  label: "Ahorro de Energía",  icon: "power-profile-power-saver-symbolic" },
    ]

    const checkIcons = new Map<string, Gtk.Image>()

    profiles.forEach(p => {
        const rowContent = new Gtk.Box({
            spacing: 16,
            margin_start: 16,
            margin_end: 16,
            margin_top: 14,
            margin_bottom: 14,
        })
        rowContent.append(new Gtk.Image({ icon_name: p.icon, pixel_size: 20, css_classes: ["sidebar-icon"] }))
        rowContent.append(new Gtk.Label({
            label: p.label,
            hexpand: true,
            halign: Gtk.Align.START,
            css_classes: ["settings-row-label"],
        }))
        const checkIcon = new Gtk.Image({
            icon_name: "object-select-symbolic",
            css_classes: ["profile-check", "suggested-action"],
            pixel_size: 16,
            visible: false,
        })
        rowContent.append(checkIcon)
        checkIcons.set(p.id, checkIcon)

        const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
        row.set_child(rowContent)
        row.set_name(p.id)
        profileGroup.listBox.append(row)
    })

    profileGroup.listBox.connect("row-selected", (_: any, row: any) => {
        checkIcons.forEach(icon => { icon.visible = false })
        if (row) {
            const profileId = row.get_name()
            if (profileId) {
                checkIcons.get(profileId)!.visible = true
                execAsync(["powerprofilesctl", "set", profileId])
                    .catch(err => console.error("[PowerPage] Failed to set profile:", err))
            }
        }
    })

    page.append(profileGroup.box)

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        execAsync(["powerprofilesctl", "get"]).then((current: string) => {
            const clean = current.trim()
            profiles.forEach((p, idx) => {
                if (p.id === clean) {
                    const row = profileGroup.listBox.get_row_at_index(idx)
                    if (row) profileGroup.listBox.select_row(row)
                }
            })
        }).catch((err: any) => console.error("[PowerPage] Failed to get profile:", err))
        return GLib.SOURCE_REMOVE
    })

    return page
}
