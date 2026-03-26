import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
// @ts-ignore
import Adw from "gi://Adw?version=1"

// Page Imports
import NetworkPage from "./pages/Network"
import AudioPage from "./pages/Audio"
import DockPage from "./pages/Dock"
import PowerPage from "./pages/Power"
import AppearancePage from "./pages/Appearance"

/**
 * Settings - System Configuration Panel
 * macOS Tahoe Inspired Design
 */
export default function Settings(monitor: Gdk.Monitor) {
    console.log("[Settings] Initializing window components...");

    const header = new Adw.HeaderBar({
        title_widget: new Gtk.Label({
            label: "Configuración del Sistema",
            css_classes: ["settings-title"]
        }),
        show_end_title_buttons: true,
        show_start_title_buttons: true,
    })

    const win = new Adw.Window({
        name: "crystal-settings",
        application: app,
        css_classes: ["background", "glass", "fc-ignore", "crystal-settings-window"],
        default_width: 1000,
        default_height: 700,
        visible: false,
    })

    // Sidebar: Categories
    const sidebar = new Gtk.ListBox({
        css_classes: ["settings-sidebar", "navigation-sidebar"],
        selection_mode: Gtk.SelectionMode.SINGLE,
        vexpand: true,
    })

    const categories = [
        { id: "appearance", label: "Apariencia", icon: "preferences-desktop-theme-symbolic", component: AppearancePage },
        { id: "network", label: "Red", icon: "network-workgroup-symbolic", component: NetworkPage },
        { id: "audio", label: "Sonido", icon: "audio-speakers-symbolic", component: AudioPage },
        { id: "dock", label: "Dock / Panel", icon: "dock-bottom-symbolic", component: DockPage },
        { id: "power", label: "Energía", icon: "power-profile-balanced-symbolic", component: PowerPage },
        { id: "input", label: "Dispositivos", icon: "input-mouse-symbolic", component: null },
    ]

    const stack = new Adw.ViewStack({
        hexpand: true,
        vexpand: true,
        margin_start: 8,
        margin_end: 16, // Breathing room on the right
        margin_top: 0,   // 💎 NO TOP MARGIN 💎
        margin_bottom: 0, 
    })

    categories.forEach(cat => {
        const rowContent = new Gtk.Box({
            spacing: 16,
            css_classes: ["settings-sidebar-row"],
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        })
        
        const icon = new Gtk.Image({ 
            icon_name: cat.icon, 
            pixel_size: 20,
            css_classes: ["sidebar-icon"] 
        })
        
        rowContent.append(icon)
        rowContent.append(new Gtk.Label({ 
            label: cat.label,
            css_classes: ["sidebar-label"] 
        }))

        const listRow = new Gtk.ListBoxRow({ 
            child: rowContent,
            css_classes: ["settings-row-container", "crystal-sidebar-row"],
            name: cat.id
        })
        sidebar.append(listRow)

        // Modern Page Wrapper with Adw.Clamp
        let pageWidget: Gtk.Widget;
        
        if (cat.component) {
            try {
                pageWidget = cat.component();
            } catch (e) {
                console.error(`[Settings] Failed to load page ${cat.id}:`, e);
                pageWidget = new Gtk.Label({ label: `Error cargando la página ${cat.label}` });
            }
        } else {
            const placeholder = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 20,
                margin_top: 60,
                vexpand: true,
            })
            placeholder.append(new Gtk.Label({
                label: cat.label,
                css_classes: ["settings-page-title"]
            }))
            placeholder.append(new Gtk.Label({
                label: `La configuración de ${cat.label} estará disponible pronto.`,
                css_classes: ["settings-placeholder"]
            }))
            pageWidget = placeholder;
        }

        const clamp = new Adw.Clamp({
            maximum_size: 800,
            tightening_threshold: 600,
            child: pageWidget,
            vexpand: true,
        })

        const scroll = new Gtk.ScrolledWindow({
            child: clamp,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ["settings-page-scroll"]
        })

        stack.add_titled_with_icon(scroll, cat.id, cat.label, cat.icon)
    })

    sidebar.connect("row-selected", (_, row) => {
        if (row) {
            const id = row.get_name() || "appearance"
            stack.set_visible_child_name(id)
            console.log(`[Settings] Sidebar selected: ${id}`)
        }
    })

    // Layout Composition using ToolbarView
    const toolbarView = new Adw.ToolbarView({
        top_bar_style: Adw.ToolbarStyle.FLAT,
        vexpand: true,
    })
    
    toolbarView.add_top_bar(header)

    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        css_classes: ["settings-content-wrapper"],
        vexpand: true, // IMPORTANT: Allow full height
    })

    const sidebarWrapper = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        width_request: 260,
        css_classes: ["crystal-sidebar-island"],
        vexpand: true,
        margin_start: 0,  // 💎 NO LEFT MARGIN 💎
        margin_end: 8,    // Space between panels
        margin_top: 0,   // 💎 NO TOP MARGIN 💎
        margin_bottom: 0  
    })

    const sidebarScroll = new Gtk.ScrolledWindow({
        child: sidebar,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        css_classes: ["settings-sidebar-scroll"],
        vexpand: true, // 💎 IMPORTANT: Allow full height
    })

    sidebarWrapper.append(sidebarScroll)
    
    mainBox.append(sidebarWrapper)
    mainBox.append(stack)

    toolbarView.set_content(mainBox)
    win.set_content(toolbarView)

    // Toggle Mechanism
    ; (win as any).toggle = () => {
        console.log(`[Settings] Toggling window visibility. Current: ${win.visible}`);
        win.visible = !win.visible
        if (win.visible) {
            win.present()
            console.log("[Settings] Window presented.");
        }
    }

    // Default selection
    const firstRow = sidebar.get_row_at_index(0)
    if (firstRow) sidebar.select_row(firstRow)

    console.log("[Settings] window ready to return.");
    return win
}
