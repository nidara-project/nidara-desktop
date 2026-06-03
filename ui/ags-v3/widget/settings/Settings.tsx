import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { CrystalClamp, CrystalSplitView } from "../../../lib/crystal-ui"

// Page Imports
import AppearancePage from "./pages/Appearance"
import DisplayPage from "./pages/Display"
import AudioPage from "./pages/Audio"
import NetworkPage from "./pages/Network"
import PowerPage from "./pages/Power"
import DockPage from "./pages/Dock"
import BarPage from "./pages/Bar"
import NotificationsPage from "./pages/Notifications"
import RegionPage from "./pages/Region"
import WidgetsPage from "./pages/Widgets"
import AboutPage from "./pages/About"
import InputPage from "./pages/Input"
import AppsPage from "./pages/Apps"
import BluetoothPage from "./pages/Bluetooth"
import AutostartPage from "./pages/Autostart"
import DefaultAppsPage from "./pages/DefaultApps"
import AccessibilityPage from "./pages/Accessibility"
import UsersPage from "./pages/Users"
import GamingPage from "./pages/Gaming"
import { beginPage, endPage, clearSearchIndex, getSearchIndex } from "./SettingsHelpers"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import IconButton from "../common/IconButton"

/**
 * Settings - System Configuration Panel
 * Pure GTK4 — no Adwaita dependency.
 */
export default function Settings(monitor: Gdk.Monitor) {
    clearSearchIndex()

    // ── Navigation controls ───────────────────────────────────────────────────
    const backBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.chevronLeft, pixel_size: 14, css_classes: ["cs-icon"] }),
        css_classes: ["crystal-icon-btn", "nav-btn"],
        tooltip_text: t("settings.nav.back"),
        sensitive: false,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })
    const forwardBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.chevronRight, pixel_size: 14, css_classes: ["cs-icon"] }),
        css_classes: ["crystal-icon-btn", "nav-btn"],
        tooltip_text: t("settings.nav.forward"),
        sensitive: false,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })

    // Navigation capsule (pill shape via CSS)
    const navCapsule = new Gtk.Box({
        css_classes: ["navigation-capsule"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })
    navCapsule.append(backBtn)
    navCapsule.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["nav-separator"] }))
    navCapsule.append(forwardBtn)

    // ── Window (pure Gtk.Window, no Adwaita) ──────────────────────────────────
    // decorated: false + Gtk.WindowHandle on the header area = custom CSD
    // without any Adwaita header plumbing.
    const win = new Gtk.Window({
        name: "crystal-settings-window",
        title: "Crystal Shell Settings",
        application: app,
        css_classes: ["fc-ignore", "crystal-settings-window"],
        default_width: 1000,
        default_height: 700,
        decorated: false,
        visible: false,
    })

    // ── Sidebar ───────────────────────────────────────────────────────────────
    const sidebar = new Gtk.ListBox({
        css_classes: ["settings-sidebar"],
        selection_mode: Gtk.SelectionMode.SINGLE,
        activate_on_single_click: true,
        vexpand: true,
    })

    const categories = [
        { id: "users",        label: t("settings.users.title"),                              icon: Icons.user,          component: UsersPage        },
        { id: "appearance",   label: t("settings.appearance.title"),         icon: Icons.palette,       component: AppearancePage   },
        { id: "display",      label: t("settings.display.title"),              icon: Icons.monitor,       component: DisplayPage      },
        { id: "audio",        label: t("settings.audio.title"),                  icon: Icons.speaker,       component: AudioPage        },
        { id: "network",      label: t("settings.network.title"),                   icon: Icons.globe,         component: NetworkPage      },
        { id: "input",        label: t("settings.input.title"),                              icon: Icons.keyboard,      component: InputPage        },
        { id: "bluetooth",    label: t("settings.bluetooth.title"),           icon: Icons.bluetooth,     component: BluetoothPage    },
        { id: "region",       label: t("settings.region.title"),                             icon: Icons.clock,         component: RegionPage       },
        { id: "defaultapps",  label: t("settings.defaultapps.title"),                        icon: Icons.app,           component: DefaultAppsPage  },
        { id: "apps",         label: t("settings.apps.title"),             icon: Icons.grid,          component: AppsPage         },
        { id: "accessibility",label: t("settings.accessibility.title"),                      icon: Icons.accessibility, component: AccessibilityPage },
        { id: "notifications",label: t("settings.notif.title"),                              icon: Icons.bell,          component: NotificationsPage },
        { id: "bar",          label: t("settings.bar.title"),                                icon: Icons.panelTop,      component: BarPage          },
        { id: "dock",         label: t("settings.dock.title"),                     icon: Icons.dock,          component: DockPage         },
        { id: "widgets",      label: t("settings.widgets.title"),               icon: Icons.puzzle,        component: WidgetsPage      },
        { id: "gaming",       label: t("settings.gaming.title"),                 icon: Icons.gamepad,       component: GamingPage       },
        { id: "autostart",    label: t("settings.autostart.title"),   icon: Icons.rocket,        component: AutostartPage    },
        { id: "power",        label: t("settings.power.title"),                 icon: Icons.battery,       component: PowerPage        },
        { id: "about",        label: t("settings.about.title"),               icon: Icons.info,          component: AboutPage        },
    ]

    // ── Page container — single-child swap model ──────────────────────────────
    // We intentionally avoid Gtk.Stack here. With hhomogeneous/vhomogeneous:false,
    // Gtk.Stack gives all hidden pages a 0×0 allocation. During CSS reloads
    // (e.g. dark-mode toggle) GTK snapshots the full widget tree and calls
    // pixman_region32_init_rect with those 0×0 rects, producing the
    // "Invalid rectangle" BUG warning. Keeping only the active page in the
    // widget tree at all times eliminates the problem entirely.
    const pageCache = new Map<string, Gtk.Widget>()
    const contentArea = new Gtk.Box({
        hexpand: true,
        vexpand: true,
        css_classes: ["settings-stack"],
    })
    let activePageId = ""

    const showPage = (id: string) => {
        if (id === activePageId) return
        const next = pageCache.get(id)
        if (!next) return
        const current = pageCache.get(activePageId)
        if (current) contentArea.remove(current)
        contentArea.append(next)
        activePageId = id
    }

    categories.forEach(cat => {
        const rowContent = new Gtk.Box({
            spacing: 12,
            css_classes: ["settings-sidebar-row"],
            margin_start: 14,
            margin_end: 14,
            margin_top: 0,
            margin_bottom: 0,
            valign: Gtk.Align.CENTER,
        })

        const icon = new Gtk.Image({ pixel_size: 18, css_classes: ["sidebar-icon", "cs-icon"] })
        icon.gicon = cat.icon

        rowContent.append(icon)
        rowContent.append(new Gtk.Label({ label: cat.label, css_classes: ["sidebar-label"] }))

        const listRow = new Gtk.ListBoxRow({ css_classes: ["settings-row-container"] })
        listRow.set_child(rowContent)
        listRow.set_name(cat.id)
        sidebar.append(listRow)

        // Build page widget
        let pageWidget: Gtk.Widget
        try {
            beginPage(cat.id, cat.label)
            pageWidget = cat.component()
            endPage()
        } catch (e) {
            endPage()
            console.error(`[Settings] Failed to load page ${cat.id}:`, e)
            pageWidget = new Gtk.Label({ label: `${t("settings.page.load-error")}: ${cat.label}` })
        }

        // CrystalClamp replaces Adw.Clamp
        const clamp = CrystalClamp(pageWidget, 800, true)

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ["settings-page-scroll"],
        })
        scroll.set_child(clamp)
        pageCache.set(cat.id, scroll)
    })

    sidebar.set_name("crystal-settings-sidebar-list")

    // ── Search results page ───────────────────────────────────────────────────
    const searchResultsList = new Gtk.ListBox({
        css_classes: ["settings-list-box", "search-results-list"],
        selection_mode: Gtk.SelectionMode.NONE,
        activate_on_single_click: true,
    })

    const searchResultsEmpty = new Gtk.Label({
        label: t("settings.search.no-results"),
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

    const srClamp = CrystalClamp(searchResultsPage, 800, true)
    const srScroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        hexpand: true,
        vexpand: true,
        css_classes: ["settings-page-scroll"],
    })
    srScroll.set_child(srClamp)
    pageCache.set("search-results", srScroll)

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
                gicon: cat?.icon ?? Icons.settings,
                pixel_size: 18,
                css_classes: ["search-result-page-icon", "cs-icon"],
                opacity: 0.6,
            }))

            const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true })
            text.append(new Gtk.Label({ label: item.label, css_classes: ["settings-row-label"], halign: Gtk.Align.START }))
            if (item.subtitle) {
                text.append(new Gtk.Label({
                    label: item.subtitle,
                    css_classes: ["settings-row-subtitle"],
                    halign: Gtk.Align.START,
                    ellipsize: 3,
                    max_width_chars: 50,
                }))
            }
            row.append(text)
            row.append(new Gtk.Label({ label: item.pageLabel, css_classes: ["search-result-chip"] }))
            row.append(new Gtk.Image({ gicon: Icons.chevronRight, pixel_size: 14, opacity: 0.4, css_classes: ["cs-icon"] }))

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
            searchInput.text = ""
            navigateTo(pageId)
        }
    })

    // ── Navigation history ────────────────────────────────────────────────────
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
            history.splice(historyIdx + 1)
            history.push(pageId)
            historyIdx = history.length - 1
        }
        showPage(pageId)
        syncSidebarSelection(pageId)
        updateNavButtons()
    }

    sidebar.connect("row-activated", (_, row) => {
        if (!row?.name) return
        navigateTo(row.name)
    })

    sidebar.connect("row-selected", () => {
        if (isProgrammaticNav) return
        if (activePageId && activePageId !== "search-results")
            syncSidebarSelection(activePageId)
    })

    backBtn.connect("clicked", () => {
        if (historyIdx > 0) navigateTo(history[--historyIdx], false)
    })
    forwardBtn.connect("clicked", () => {
        if (historyIdx < history.length - 1) navigateTo(history[++historyIdx], false)
    })

    // Sidebar list scroll (lives inside the capsule column below).
    const sidebarScroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        css_classes: ["settings-sidebar-scroll"],
        vexpand: true,
    })
    sidebarScroll.set_child(sidebar)
    sidebarScroll.set_name("crystal-settings-sidebar-scroll")

    // The sidebar capsule = ONE glass column holding the toolbar (toggle + nav) at
    // the top and the list below it. This whole column is the split view's sidebar,
    // so the toolbar rides into the collapsed popover with the list. When the
    // sidebar is hidden, the toolbar is parked in the header slot (see moveTools).
    const sidebarColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["crystal-sidebar-capsule"],
        vexpand: true,
    })
    sidebarColumn.append(sidebarScroll)

    // ── Search ────────────────────────────────────────────────────────────────
    // Custom search box: our own cs-icon magnifier + Gtk.Text. Gtk.SearchEntry
    // would force the icon theme's magnifier glyph; this matches the rest of the
    // shell (same pattern as Prism's search field).
    const searchInput = new Gtk.Text({
        placeholder_text: t("settings.search.placeholder"),
        css_classes: ["settings-search-text"],
        hexpand: true,
        valign: Gtk.Align.CENTER,
    })
    const searchEntry = new Gtk.Box({
        css_classes: ["settings-search"],
        spacing: 8,
        width_request: 220,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    searchEntry.append(new Gtk.Image({
        gicon: Icons.search,
        pixel_size: 15,
        css_classes: ["cs-icon", "settings-search-icon"],
        valign: Gtk.Align.CENTER,
    }))
    searchEntry.append(searchInput)

    let pageBeforeSearch = ""

    searchInput.connect("changed", () => {
        const query = searchInput.text.trim()
        if (query) {
            if (activePageId !== "search-results")
                pageBeforeSearch = activePageId || categories[0]?.id || ""
            populateResults(query)
            showPage("search-results")
            isProgrammaticNav = true
            sidebar.unselect_all()
            isProgrammaticNav = false
        } else {
            const target = pageBeforeSearch || categories[0]?.id || ""
            navigateTo(target, false)
            pageBeforeSearch = ""
        }
    })

    // Escape clears the search (Gtk.Text has no built-in stop-search signal).
    const searchKeys = new Gtk.EventControllerKey()
    searchKeys.connect("key-pressed", (_: any, keyval: number) => {
        if (keyval === Gdk.KEY_Escape) { searchInput.text = ""; return true }
        return false
    })
    searchInput.add_controller(searchKeys)

    // ── Sidebar toggle ────────────────────────────────────────────────────────
    const sidebarToggle = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.sidebar, pixel_size: 16, css_classes: ["cs-icon"] }),
        css_classes: ["crystal-icon-btn", "sidebar-toggle"],
        tooltip_text: t("settings.nav.menu"),
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })

    // ── Sidebar toolbar (toggle + nav) ────────────────────────────────────────
    // Lives INSIDE the sidebar capsule (its top). When the sidebar is hidden
    // (collapsed + popover closed, or manually hidden) it parks in the header slot
    // so it stays reachable; when the sidebar is presented again — docked or in the
    // popover — it moves back into the capsule. Driven by onSidebarPresented below.
    const sidebarTools = new Gtk.Box({
        spacing: 8,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
        css_classes: ["settings-sidebar-tools"],
    })
    sidebarTools.append(sidebarToggle)
    sidebarTools.append(navCapsule)

    // Park slot for the toolbar inside the content header (shown only while the
    // sidebar is hidden).
    const headerToolsSlot = new Gtk.Box({
        valign: Gtk.Align.CENTER,
        css_classes: ["settings-header-tools"],
    })

    // Relocate the toolbar between the sidebar capsule (top) and the header slot.
    const moveTools = (intoSidebar: boolean) => {
        const target = intoSidebar ? sidebarColumn : headerToolsSlot
        if (sidebarTools.get_parent() === target) return
        if (sidebarTools.get_parent()) sidebarTools.unparent()
        if (intoSidebar) sidebarColumn.prepend(sidebarTools)
        else headerToolsSlot.append(sidebarTools)
    }

    // ── Content header (over the content, right side) ─────────────────────────
    // Shared round glass close control (crystal-circle-btn, red on hover) — the
    // single source of truth for close/remove buttons across the shell.
    const closeBtn = IconButton({
        icon: Icons.close,
        iconSize: 14,
        variant: "danger",
        tooltip: t("settings.window.close"),
        onClick: () => win.set_visible(false),
    })

    const contentHeader = new Gtk.CenterBox({ css_classes: ["settings-header"] })
    contentHeader.set_start_widget(headerToolsSlot)
    contentHeader.set_center_widget(searchEntry)
    contentHeader.set_end_widget(closeBtn)

    // Gtk.WindowHandle makes the header draggable for window movement.
    // This replaces the title bar drag area that Adw.Window provided implicitly.
    const headerHandle = new Gtk.WindowHandle()
    headerHandle.set_child(contentHeader)

    // ── Content column ────────────────────────────────────────────────────────
    // Header (toolbar slot + search + close) over the content. The toolbar slot is
    // only populated while the sidebar is hidden; otherwise the toolbar lives in
    // the sidebar capsule.
    const contentColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
        margin_top: 8,
        // No right margin: the header separator reaches the glass right edge. The
        // page keeps its own inner padding so content isn't cramped.
        margin_bottom: 8,
    })
    contentColumn.append(headerHandle)
    contentColumn.append(contentArea)

    // ── CrystalSplitView (replaces Adw.OverlaySplitView + Adw.Breakpoint) ────
    // Content-driven collapse (no fixed collapseAt): the split view measures the
    // active page's natural width every poll and collapses the sidebar only when
    // the window can no longer fit sidebar + un-clipped content. The ZeroMinBox
    // wrapper keeps the window minimum near sidebarWidth so Hyprland can tile.
    const splitView = CrystalSplitView({
        sidebar: sidebarColumn,
        content: contentColumn,
        sidebarWidth: 250,
        cssClasses: ["crystal-split-view"],
        name: "settings-splitview",
        // floatAnchor enables Popover mode in collapsed state so Hyprland's
        // blur:popups applies compositor blur to the content behind the sidebar.
        floatAnchor: sidebarToggle,
        // Toolbar rides inside the capsule when the sidebar is shown; parks in the
        // header slot when it's hidden.
        onSidebarPresented: (presented) => moveTools(presented),
    })

    sidebarToggle.connect("clicked", () => {
        splitView.setShowSidebar(!splitView.showSidebar)
    })

    splitView.connectCollapsedChanged(() => {
        if (!sidebar.get_selected_row() && activePageId)
            syncSidebarSelection(activePageId)
    })

    // ── Main glass container ──────────────────────────────────────────────────
    const mainContainer = new Gtk.Box({ css_classes: ["settings-main-glass"] })
    mainContainer.set_name("settings-main-glass")
    mainContainer.append(splitView.widget)

    // Gtk.Window.set_child() replaces Adw.Window.set_content()
    win.set_child(mainContainer)

    // Hide instead of destroy — window is reused across toggles
    win.connect("close-request", () => { win.set_visible(false); return true })

    ;(win as any).toggle = () => {
        win.visible = !win.visible
        if (win.visible) win.present()
    }

    // Default page — seeds history
    if (categories.length > 0) navigateTo(categories[0].id)

    return win
}
