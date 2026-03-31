import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
// @ts-ignore
import Adw from "gi://Adw?version=1"

// Page Imports
import NetworkPage from "./pages/Network"
import AudioPage from "./pages/Audio"
import DockPage from "./pages/Dock"
import PowerPage from "./pages/Power"
import AppearancePage from "./pages/Appearance"
import { beginPage, endPage, clearSearchIndex, getSearchIndex } from "./SettingsHelpers"

/**
 * Settings - System Configuration Panel
 * macOS Tahoe Inspired Design
 */
export default function Settings(monitor: Gdk.Monitor) {
    console.log("[Settings] Initializing window components...");
    clearSearchIndex()

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
                beginPage(cat.id, cat.label)
                pageWidget = cat.component();
                endPage()
            } catch (e) {
                endPage()
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

    // --- Search results page ---
    const searchResultsList = new Gtk.ListBox({
        css_classes: ["settings-list-box", "boxed-list", "search-results-list"],
        selection_mode: Gtk.SelectionMode.NONE,
        activate_on_single_click: true,
    })

    const searchResultsEmpty = new Gtk.Label({
        label: "Sin resultados",
        css_classes: ["settings-placeholder"],
        margin_top: 40,
        visible: false,
    })

    const searchResultsPage = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ["settings-page"],
        margin_start: 12,
        margin_end: 12,
        margin_top: 32,
        margin_bottom: 32,
    })
    searchResultsPage.append(searchResultsList)
    searchResultsPage.append(searchResultsEmpty)

    const srClamp = new Adw.Clamp({ maximum_size: 800, tightening_threshold: 600, vexpand: true })
    srClamp.set_child(searchResultsPage)
    const srScroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        hexpand: true,
        vexpand: true,
        css_classes: ["settings-page-scroll"],
    })
    srScroll.set_child(srClamp)
    stack.add_named(srScroll, "search-results")

    const populateResults = (query: string) => {
        let child = searchResultsList.get_first_child()
        while (child) { searchResultsList.remove(child); child = searchResultsList.get_first_child() }

        const q = query.toLowerCase().trim()
        const matches = getSearchIndex().filter(item =>
            item.label.toLowerCase().includes(q) ||
            item.subtitle.toLowerCase().includes(q)
        )

        matches.forEach(item => {
            const cat = categories.find(c => c.id === item.pageId)
            const row = new Gtk.Box({
                spacing: 12,
                margin_start: 16,
                margin_end: 16,
                margin_top: 12,
                margin_bottom: 12,
            })

            row.append(new Gtk.Image({
                icon_name: cat?.icon || "preferences-symbolic",
                pixel_size: 18,
                css_classes: ["search-result-page-icon"],
                opacity: 0.6,
            }))

            const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true })
            text.append(new Gtk.Label({ label: item.label, css_classes: ["settings-row-label"], halign: Gtk.Align.START }))
            if (item.subtitle) {
                text.append(new Gtk.Label({
                    label: item.subtitle, css_classes: ["settings-row-subtitle"],
                    halign: Gtk.Align.START, ellipsize: 3, max_width_chars: 50,
                }))
            }
            row.append(text)

            row.append(new Gtk.Label({ label: item.pageLabel, css_classes: ["search-result-chip"] }))
            row.append(new Gtk.Image({ icon_name: "go-next-symbolic", pixel_size: 14, opacity: 0.4 }))

            const lbr = new Gtk.ListBoxRow({ css_classes: ["settings-item-row", "search-result-row"] })
            lbr.set_child(row)
            ;(lbr as any)._targetPageId = item.pageId
            searchResultsList.append(lbr)
        })

        searchResultsList.visible = matches.length > 0
        searchResultsEmpty.visible = matches.length === 0
    }

    searchResultsList.connect("row-activated", (_: any, row: any) => {
        const pageId = (row as any)._targetPageId
        if (pageId) {
            searchEntry.text = ""
            sidebar.invalidate_filter()
            navigateTo(pageId)
        }
    })

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

    // Sidebar wrapper: spacer (matches header height) + scroll
    // The spacer border-bottom visually extends the header divider line into the sidebar
    const sidebarWrapper = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    sidebarWrapper.append(new Gtk.Box({ css_classes: ["sidebar-header-spacer"] }))
    sidebarWrapper.append(sidebarScroll)

    // Content Area: ToolbarView for correct Tahoe Header integration
    const contentToolbarView = new Adw.ToolbarView({
        top_bar_style: Adw.ToolbarStyle.FLAT,
        hexpand: true,
        vexpand: true,
    })
    contentToolbarView.set_name("crystal-settings-content-view")
    contentToolbarView.set_content(stack)

    // Main Responsive Overlay Split View 🏔️
    const splitView = new Adw.OverlaySplitView({
        name: "settings-splitview",
        sidebar: sidebarWrapper,
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

    let pageBeforeSearch = ""

    searchEntry.connect("search-changed", () => {
        const query = searchEntry.text.trim()
        if (query) {
            if (stack.visible_child_name !== "search-results") {
                pageBeforeSearch = stack.visible_child_name || categories[0]?.id || ""
            }
            populateResults(query)
            stack.visible_child_name = "search-results"
            isProgrammaticNav = true
            sidebar.unselect_all()
            isProgrammaticNav = false
        } else {
            sidebar.invalidate_filter()
            const target = pageBeforeSearch || categories[0]?.id || ""
            navigateTo(target, false)
            pageBeforeSearch = ""
        }
    })

    searchEntry.connect("stop-search", () => {
        searchEntry.text = ""
    })

    // Sidebar Toggle Button 📲
    const sidebarToggle = new Gtk.Button({
        icon_name: "view-sidebar-symbolic",
        css_classes: ["sidebar-toggle"],
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

    // Custom close button (full control over size/shape)
    const closeBtn = new Gtk.Button({
        css_classes: ["settings-close-btn"],
        tooltip_text: "Cerrar",
        valign: Gtk.Align.CENTER,
    })
    closeBtn.connect("clicked", () => win.set_visible(false))

    const header = new Adw.HeaderBar({
        show_end_title_buttons: false,
        show_start_title_buttons: false,
        css_classes: ["settings-header"],
    })
    header.set_title_widget(searchEntry)
    header.pack_start(headerStart)
    header.pack_end(closeBtn)

    // 💎 NATIVE RESPONSIVE BREAKPOINT 💎
    const breakpoint = new Adw.Breakpoint({
        condition: Adw.BreakpointCondition.parse("max-width: 1100px")
    })
    breakpoint.add_setter(splitView, "collapsed", true)
    win.add_breakpoint(breakpoint)

    contentToolbarView.add_top_bar(header)

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
