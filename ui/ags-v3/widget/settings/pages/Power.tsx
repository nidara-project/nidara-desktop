import { Astal, Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"

/**
 * Power Settings Page 🔋 - Crystal V3 (macOS Tahoe Inspired)
 */
export default function PowerPage() {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 32,
        css_classes: ["settings-page", "power-page"],
        margin_start: 12,
        margin_end: 12,
        margin_top: 40,
        margin_bottom: 40,
    })

    // Header Section (Tahoe Style)
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_bottom: 24,
        margin_start: 6
    })
    
    headerBox.append(new Gtk.Label({
        label: "Energía",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))
    
    headerBox.append(new Gtk.Label({
        label: "Administra el rendimiento y el consumo de batería",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))
    
    page.append(headerBox)

    // ── Helper: Boxed List Group ──
    const listGroup = (title: string) => {
        const box = new Gtk.Box({ 
            orientation: Gtk.Orientation.VERTICAL, 
            spacing: 12,
            css_classes: ["settings-group"] 
        })
        
        if (title) {
            box.append(new Gtk.Label({
                label: title.toUpperCase(),
                css_classes: ["settings-group-title"],
                halign: Gtk.Align.START,
                margin_start: 10
            }))
        }
        
        const listBox = new Gtk.ListBox({
            css_classes: ["settings-list-box", "boxed-list"],
            selection_mode: Gtk.SelectionMode.SINGLE
        })
        
        box.append(listBox)
        return { box, listBox }
    }

    const profileGroup = listGroup("Perfil de Rendimiento")
    const profiles = [
        { id: "performance", label: "Alto Rendimiento", icon: "power-profile-performance-symbolic" },
        { id: "balanced", label: "Equilibrado", icon: "power-profile-balanced-symbolic" },
        { id: "power-saver", label: "Ahorro de Energía", icon: "power-profile-power-saver-symbolic" },
    ]

    const checkIcons: Map<string, Gtk.Image> = new Map()

    profiles.forEach(p => {
        const rowContent = new Gtk.Box({
            spacing: 16,
            margin_start: 16,
            margin_end: 16,
            margin_top: 14,
            margin_bottom: 14,
        })

        const icon = new Gtk.Image({ 
            icon_name: p.icon, 
            pixel_size: 20,
            css_classes: ["sidebar-icon"] 
        })
        
        rowContent.append(icon)
        rowContent.append(new Gtk.Label({ 
            label: p.label, 
            hexpand: true, 
            halign: Gtk.Align.START, 
            css_classes: ["settings-row-label"] 
        }))

        const checkIcon = new Gtk.Image({
            icon_name: "object-select-symbolic",
            css_classes: ["profile-check", "suggested-action"],
            pixel_size: 16,
            visible: false 
        })
        rowContent.append(checkIcon)
        checkIcons.set(p.id, checkIcon)

        const row = new Gtk.ListBoxRow({ child: rowContent, css_classes: ["settings-item-row"] })
        row.set_name(p.id)
        profileGroup.listBox.append(row)
    })

    const updateCurrentProfile = () => {
        execAsync(["powerprofilesctl", "get"]).then(current => {
            const cleanCurrent = current.trim()
            profiles.forEach((p, idx) => {
                if (p.id === cleanCurrent) {
                    const row = profileGroup.listBox.get_row_at_index(idx)
                    if (row) profileGroup.listBox.select_row(row)
                }
            })
        }).catch(err => console.error("[PowerPage] Failed to get profile:", err))
    }

    profileGroup.listBox.connect("row-selected", (_, row) => {
        checkIcons.forEach(icon => icon.visible = false)
        if (row) {
            const profileId = row.get_name()
            if (profileId) {
                const icon = checkIcons.get(profileId)
                if (icon) icon.visible = true
                execAsync(["powerprofilesctl", "set", profileId])
                    .catch(err => console.error("[PowerPage] Failed to set profile:", err))
            }
        }
    })

    page.append(profileGroup.box)

    // Initial sync
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        updateCurrentProfile()
        return GLib.SOURCE_REMOVE
    })

    return page
}
