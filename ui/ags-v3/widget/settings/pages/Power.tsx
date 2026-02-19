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
        margin_start: 40,
        margin_end: 40,
        margin_top: 40
    })

    const title = new Gtk.Label({
        label: "Energía",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START
    })

    const subtitle = new Gtk.Label({
        label: "Administra el rendimiento y el consumo de batería",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START
    })

    page.append(title)
    page.append(subtitle)
    page.append(new Gtk.Separator())

    // Profiles Section
    const profileBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12
    })

    const profiles = [
        { id: "performance", label: "Alto Rendimiento", icon: "power-profile-performance-symbolic" },
        { id: "balanced", label: "Equilibrado", icon: "power-profile-balanced-symbolic" },
        { id: "power-saver", label: "Ahorro de Energía", icon: "power-profile-power-saver-symbolic" },
    ]

    const profileList = new Gtk.ListBox({
        css_classes: ["settings-list"],
        selection_mode: Gtk.SelectionMode.NONE
    })

    const updateCurrentProfile = () => {
        execAsync(["powerprofilesctl", "get"]).then(current => {
            const cleanCurrent = current.trim()
            profiles.forEach((p, idx) => {
                const row = profileList.get_row_at_index(idx)
                if (row) {
                    if (p.id === cleanCurrent) {
                        row.add_css_class("active-profile")
                    } else {
                        row.remove_css_class("active-profile")
                    }
                }
            })
        }).catch(err => console.error("[PowerPage] Failed to get profile:", err))
    }

    profiles.forEach(p => {
        const rowContent = new Gtk.Box({
            spacing: 16,
            margin_start: 16,
            margin_end: 16,
            margin_top: 12,
            margin_bottom: 12,
            halign: Gtk.Align.FILL
        })

        rowContent.append(new Gtk.Image({ icon_name: p.icon, pixel_size: 24 }))
        rowContent.append(new Gtk.Label({ label: p.label, hexpand: true, halign: Gtk.Align.START }))

        const checkIcon = new Gtk.Image({
            icon_name: "object-select-symbolic",
            css_classes: ["profile-check"],
            visible: false
        })
        rowContent.append(checkIcon)

        const btn = new Gtk.Button({
            child: rowContent,
            css_classes: ["settings-row-btn"]
        })

        btn.connect("clicked", () => {
            execAsync(["powerprofilesctl", "set", p.id])
                .then(() => updateCurrentProfile())
                .catch(err => console.error("[PowerPage] Failed to set profile:", err))
        })

        const row = new Gtk.ListBoxRow({ child: btn })
        profileList.append(row)
    })

    profileBox.append(new Gtk.Label({
        label: "Perfil de Rendimiento",
        css_classes: ["settings-section-title"],
        halign: Gtk.Align.START
    }))
    profileBox.append(profileList)
    page.append(profileBox)

    // Initial sync
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        updateCurrentProfile()
        return GLib.SOURCE_REMOVE
    })

    return page
}
