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

    // --- Navigation Controls (Tahoe Style) --- 🧭
    const backBtn = new Gtk.Button({
        icon_name: "go-previous-symbolic",
        css_classes: ["navigation-btn", "flat"],
        tooltip_text: "Atrás",
    })
    const forwardBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        css_classes: ["navigation-btn", "flat"],
        tooltip_text: "Adelante",
    })

    // Navigation Capsule 💊 (True Pill Shape via CSS)
    const navCapsule = new Gtk.Box({ 
        css_classes: ["navigation-capsule"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER
    })
    navCapsule.append(backBtn)
    navCapsule.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["nav-separator"] }))
    navCapsule.append(forwardBtn)


    const win = new Adw.Window({
        name: "crystal-settings",
        application: app,
        css_classes: ["background", "glass", "fc-ignore", "crystal-settings-window"],
        default_width: 1000,
        default_height: 700,
        visible: false,
    })
    win.set_name("crystal-settings-window")

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
        margin_end: 8, 
        margin_top: 8,
        margin_bottom: 8, 
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

    sidebar.set_name("crystal-settings-sidebar-list")
    
    // Connect selection to stack navigation 💎
    sidebar.connect("row-selected", (_, row) => {
        if (row && row.name) {
            stack.visible_child_name = row.name
            console.log(`[Settings] Navigating to page: ${row.name}`)
        }
    })

    // --- Responsive Floating Architecture --- 🏔️
    // Sidebar: Floating Pill (Directly in SplitView)
    const sidebarScroll = new Gtk.ScrolledWindow({
        child: sidebar,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        css_classes: ["settings-sidebar-scroll", "crystal-settings-sidebar-view"],
        vexpand: true,
    })
    sidebarScroll.set_name("crystal-settings-sidebar-scroll")

    // Content: Stack Area + Header
    const contentToolbarView = new Adw.ToolbarView({
        top_bar_style: Adw.ToolbarStyle.FLAT,
        vexpand: true,
        hexpand: true,
    })
    contentToolbarView.set_name("crystal-settings-content-view")

    // Main Responsive Overlay Split View 🏔️
    const splitView = new Adw.OverlaySplitView({
        name: "settings-splitview",
        sidebar: sidebarScroll,
        content: contentToolbarView,
        hexpand: true,
        vexpand: true,
        min_sidebar_width: 220,
        max_sidebar_width: 280,
        css_classes: ["crystal-settings-splitview", "glass"]
    })

    // Search Component 🔍
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: "Buscar ajustes...",
        css_classes: ["settings-search", "pill"],
        hexpand: true,
        max_width_chars: 30,
        valign: Gtk.Align.CENTER,
    })

    // Sidebar Toggle Button 📲
    const sidebarToggle = new Gtk.Button({
        icon_name: "view-sidebar-symbolic",
        css_classes: ["sidebar-toggle", "flat", "pill"],
        tooltip_text: "Menú",
        valign: Gtk.Align.CENTER,
    })
    sidebarToggle.connect("clicked", () => {
        splitView.set_show_sidebar(!splitView.show_sidebar)
    })

    // Header Assembly (Pure GTK Design)
    const headerStart = new Gtk.Box({ 
        spacing: 12, 
        valign: Gtk.Align.CENTER,
        css_classes: ["header-start-box"] 
    })
    headerStart.append(sidebarToggle)
    headerStart.append(navCapsule)

    const header = new Adw.HeaderBar({
        title_widget: searchEntry,
        show_end_title_buttons: true,
        show_start_title_buttons: false, 
        css_classes: ["settings-headerbar", "compact"]
    })
    header.pack_start(headerStart)

    contentToolbarView.add_top_bar(header)
    contentToolbarView.set_content(stack)

    // 💎 NATIVE RESPONSIVE BREAKPOINT 💎
    const breakpoint = new Adw.Breakpoint({
        condition: Adw.BreakpointCondition.parse("max-width: 850px") 
    })
    breakpoint.add_setter(splitView, "collapsed", true)
    win.add_breakpoint(breakpoint)

    // Synchronize window class for CSS gradient partitioning
    const syncCollapsedMode = () => {
        if (splitView.collapsed) {
            win.add_css_class("collapsed-mode")
        } else {
            win.remove_css_class("collapsed-mode")
        }
    }
    splitView.connect("notify::collapsed", syncCollapsedMode)
    syncCollapsedMode() // Run initial check

    win.set_content(splitView)


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
