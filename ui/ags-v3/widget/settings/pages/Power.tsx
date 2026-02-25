import { Astal, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"

/**
 * Power Settings Page 🔋
 */
export default function PowerPage() {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page"],
        margin_start: 30,
        margin_end: 30,
        margin_top: 30,
        margin_bottom: 30,
    })

    // Header Section
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_bottom: 12
    })
    headerBox.append(new Gtk.Label({
        label: "Energía",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START
    }))
    headerBox.append(new Gtk.Label({
        label: "Administra el rendimiento y el consumo de batería",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START
    }))
    page.append(headerBox)

    const profiles = [
        { id: "performance", label: "Alto Rendimiento", icon: "power-profile-performance-symbolic" },
        { id: "balanced", label: "Equilibrado", icon: "power-profile-balanced-symbolic" },
        { id: "power-saver", label: "Ahorro de Energía", icon: "power-profile-power-saver-symbolic" },
    ]

    const profileList = new Gtk.ListBox({
        css_classes: ["settings-list-box", "boxed-list"],
        selection_mode: Gtk.SelectionMode.SINGLE // Better for profiles
    })

    const updateCurrentProfile = () => {
        execAsync(["powerprofilesctl", "get"]).then(current => {
            const cleanCurrent = current.trim()
            profiles.forEach((p, idx) => {
                if (p.id === cleanCurrent) {
                    const row = profileList.get_row_at_index(idx)
                    if (row) profileList.select_row(row)
                }
            })
        }).catch(err => console.error("[PowerPage] Failed to get profile:", err))
    }

    profiles.forEach(p => {
        const rowContent = new Gtk.Box({
            spacing: 16,
            margin_start: 12,
            margin_end: 12,
            margin_top: 10,
            margin_bottom: 10,
        })

        rowContent.append(new Gtk.Image({ icon_name: p.icon, pixel_size: 20 }))
        rowContent.append(new Gtk.Label({ label: p.label, hexpand: true, halign: Gtk.Align.START, css_classes: ["settings-row-label"] }))

        const checkIcon = new Gtk.Image({
            icon_name: "object-select-symbolic",
            css_classes: ["profile-check"],
            pixel_size: 16
        })
        rowContent.append(checkIcon)

        const row = new Gtk.ListBoxRow({ child: rowContent })
        row.set_name(p.id)
        profileList.append(row)
    })

    profileList.connect("row-selected", (_, row) => {
        if (row) {
            const profileId = row.get_name()
            if (profileId) {
                execAsync(["powerprofilesctl", "set", profileId])
                    .catch(err => console.error("[PowerPage] Failed to set profile:", err))
            }
        }
    })

    const groupBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })
    groupBox.append(new Gtk.Label({
        label: "Perfil de Rendimiento",
        css_classes: ["settings-group-title"],
        halign: Gtk.Align.START,
        margin_start: 6
    }))
    groupBox.append(profileList)
    page.append(groupBox)

    // Initial sync
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        updateCurrentProfile()
        return GLib.SOURCE_REMOVE
    })

    return page
}
