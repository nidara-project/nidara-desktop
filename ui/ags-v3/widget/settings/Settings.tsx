import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { drawSquircle } from "../common/DrawingUtils"

// Page Imports
import NetworkPage from "./pages/Network"
import AudioPage from "./pages/Audio"
import PowerPage from "./pages/Power"

/**
 * Settings - System Configuration Panel 🛠️
 */
export default function Settings(monitor: Gdk.Monitor) {
    const win = new Gtk.Window({
        name: "crystal-settings",
        application: app,
        title: "Configuración del Sistema",
        default_width: 900,
        default_height: 650,
        visible: false,
    })

    // Sidebar: Categories
    const sidebar = new Gtk.ListBox({
        css_classes: ["settings-sidebar"],
        selection_mode: Gtk.SelectionMode.SINGLE,
        width_request: 220,
    })

    const categories = [
        { id: "network", label: "Red", icon: "network-workgroup-symbolic", component: NetworkPage },
        { id: "audio", label: "Sonido", icon: "audio-speakers-symbolic", component: AudioPage },
        { id: "power", label: "Energía", icon: "power-profile-balanced-symbolic", component: PowerPage },
        { id: "appearance", label: "Apariencia", icon: "preferences-desktop-theme-symbolic", component: null },
        { id: "input", label: "Entrada", icon: "input-mouse-symbolic", component: null },
    ]

    const stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
        transition_duration: 300,
        hexpand: true,
        vexpand: true,
        css_classes: ["settings-stack"]
    })

    categories.forEach(cat => {
        const row = new Gtk.Box({
            spacing: 12,
            css_classes: ["settings-sidebar-row"],
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        })
        row.append(new Gtk.Image({ icon_name: cat.icon, pixel_size: 20 }))
        row.append(new Gtk.Label({ label: cat.label }))

        const listRow = new Gtk.ListBoxRow({ child: row })
        listRow.set_name(cat.id)
        sidebar.append(listRow)

        // Use component if available, otherwise placeholder
        let page
        if (cat.component) {
            page = cat.component()
        } else {
            page = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 20,
                css_classes: ["settings-page", `page-${cat.id}`],
                margin_start: 40,
                margin_end: 40,
                margin_top: 40
            })
            page.append(new Gtk.Label({
                label: cat.label,
                css_classes: ["settings-page-title"],
                halign: Gtk.Align.START
            }))
            page.append(new Gtk.Separator())
            page.append(new Gtk.Label({
                label: `Configuración de ${cat.label} próximamente...`,
                css_classes: ["settings-placeholder"]
            }))
        }

        stack.add_titled(page, cat.id, cat.label)
    })

    sidebar.connect("row-selected", (_, row) => {
        if (row) {
            stack.set_visible_child_name(row.get_name() || "network")
        }
    })

    // Layout
    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        css_classes: ["settings-main-box"]
    })

    const sidebarScroll = new Gtk.ScrolledWindow({
        child: sidebar,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        css_classes: ["settings-sidebar-scroll"]
    })

    mainBox.append(sidebarScroll)
    mainBox.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }))
    mainBox.append(stack)

    win.set_child(mainBox)

        // Toggle Mechanism
        ; (win as any).toggle = () => {
            win.visible = !win.visible
            if (win.visible) win.present()
        }

    return win
}
