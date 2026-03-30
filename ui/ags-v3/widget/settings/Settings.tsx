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
        css_classes: ["nav-btn", "flat"],
        tooltip_text: "Atrás",
        sensitive: false,
    })
    const forwardBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        css_classes: ["nav-btn", "flat"],
        tooltip_text: "Adelante",
        sensitive: false,
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
        title: "Crystal Shell Settings",
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
            css_classes: ["settings-row-container", "crystal-sidebar-row"],
        })
        listRow.set_child(rowContent)
        listRow.set_name(cat.id)
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
            vexpand: true,
        })
        clamp.set_child(pageWidget)

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ["settings-page-scroll"]
        })
        scroll.set_child(clamp)

        stack.add_titled_with_icon(scroll, cat.id, cat.label, cat.icon)
    })

    sidebar.set_name("crystal-settings-sidebar-list")

    // --- Navigation history ---
    const history: string[] = []
    let historyIdx = -1
    let isProgrammaticNav = false

    const syncSidebarSelection = (pageId: string) => {
        isProgrammaticNav = true
        for (let i = 0; i < categories.length; i++) {
            const row = sidebar.get_row_at_index(i)
            if (row?.get_name() === pageId) { sidebar.select_row(row); break }
        }
        isProgrammaticNav = false
    }

    const updateNavButtons = () => {
        backBtn.sensitive = historyIdx > 0
        forwardBtn.sensitive = historyIdx < history.length - 1
    }

    const navigateTo = (pageId: string, addToHistory = true) => {
        if (addToHistory) {
            history.splice(historyIdx + 1) // discard forward history
            history.push(pageId)
            historyIdx = history.length - 1
        }
        stack.visible_child_name = pageId
        syncSidebarSelection(pageId)
        updateNavButtons()
    }

    sidebar.connect("row-selected", (_, row) => {
        if (isProgrammaticNav || !row?.name) return
        navigateTo(row.name)
    })

    backBtn.connect("clicked", () => {
        if (historyIdx > 0) navigateTo(history[--historyIdx], false)
    })

    forwardBtn.connect("clicked", () => {
        if (historyIdx < history.length - 1) navigateTo(history[++historyIdx], false)
    })

    // --- Responsive Floating Architecture --- 🏔️
    // Sidebar: Floating Pill (Directly in SplitView)
    const sidebarScroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        css_classes: ["settings-sidebar-scroll", "crystal-sidebar-capsule"],
        vexpand: true,
    })
    sidebarScroll.set_child(sidebar)
    sidebarScroll.set_name("crystal-settings-sidebar-scroll")

    // Content Area: ToolbarView for correct Tahoe Header integration
    const contentToolbarView = new Adw.ToolbarView({
        top_bar_style: Adw.ToolbarStyle.FLAT,
        vexpand: true,
        hexpand: true,
    })
    contentToolbarView.set_name("crystal-settings-content-view")

    // Master Scroll with Adw.Clamp
    const clamp = new Adw.Clamp({
        maximum_size: 800,
        hexpand: true,
        vexpand: true,
    })
    clamp.set_child(stack)
    contentToolbarView.set_content(clamp)

    // Main Responsive Overlay Split View 🏔️
    const splitView = new Adw.OverlaySplitView({
        name: "settings-splitview",
        sidebar: sidebarScroll,
        content: contentToolbarView,
        hexpand: true,
        vexpand: true,
        min_sidebar_width: 250,
        max_sidebar_width: 250,
        css_classes: ["crystal-split-view", "glass"]
    })

    // DESACTIVAR SEPARADOR VERTICAL (Tahoe Clean Look)
    try {
        // @ts-ignore
        if (splitView.set_show_sidebar_separator) splitView.set_show_sidebar_separator(false)
    } catch (e) {}

    // Search Component 🔍
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: "Buscar ajustes...",
        css_classes: ["settings-search", "pill"],
        hexpand: true,
        max_width_chars: 30,
        valign: Gtk.Align.CENTER,
    })

    sidebar.set_filter_func((row) => {
        const query = searchEntry.text.toLowerCase().trim()
        if (!query) return true
        const cat = categories.find(c => c.id === row.get_name())
        return !!cat && cat.label.toLowerCase().includes(query)
    })

    searchEntry.connect("search-changed", () => {
        sidebar.invalidate_filter()
        const query = searchEntry.text.toLowerCase().trim()
        if (!query) return
        // Auto-navigate to first visible match (without adding to history)
        const match = categories.find(c => c.label.toLowerCase().includes(query))
        if (match) {
            stack.visible_child_name = match.id
            syncSidebarSelection(match.id)
        }
    })

    searchEntry.connect("stop-search", () => {
        searchEntry.text = ""
        sidebar.invalidate_filter()
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

    // Header Assembly
    const headerStart = new Gtk.Box({ 
        spacing: 12, 
        valign: Gtk.Align.CENTER,
        css_classes: ["header-start-box"] 
    })
    headerStart.append(sidebarToggle)
    headerStart.append(navCapsule)

    const header = new Adw.HeaderBar({
        show_end_title_buttons: true,
        show_start_title_buttons: false, 
        css_classes: ["settings-header", "compact"]
    })
    header.set_title_widget(searchEntry)
    header.pack_start(headerStart)

    // Integrate Header back into ToolbarView
    contentToolbarView.add_top_bar(header)

    // 💎 NATIVE RESPONSIVE BREAKPOINT 💎
    const breakpoint = new Adw.Breakpoint({
        condition: Adw.BreakpointCondition.parse("max-width: 1100px") 
    })
    breakpoint.add_setter(splitView, "collapsed", true)
    win.add_breakpoint(breakpoint)

    const mainContainer = new Gtk.Box({ css_classes: ["settings-main-glass"] })
    mainContainer.set_name("settings-main-glass")
    mainContainer.append(splitView)
    win.set_content(mainContainer)

    // Restaura la selección tras colapso/expansión del SplitView
    splitView.connect("notify::collapsed", () => {
        if (!sidebar.get_selected_row() && stack.visible_child_name)
            syncSidebarSelection(stack.visible_child_name)
    })

    // Hide instead of destroy so the window can be reopened later
    win.connect("close-request", () => {
        win.set_visible(false)
        return true // Prevent GTK4 default destroy
    })

    ; (win as any).toggle = () => {
        win.visible = !win.visible
        if (win.visible) win.present()
    }

    // Default selection — navigate to first page, seeding history
    if (categories.length > 0) navigateTo(categories[0].id)

    console.log("[Settings] window ready to return.");
    return win
}
