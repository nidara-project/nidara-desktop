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
        { id: "appearance",   label: t("settings.appearance.page.title.apariencia"),         icon: Icons.palette,       component: AppearancePage   },
        { id: "display",      label: t("settings.display.page.title.pantalla"),              icon: Icons.monitor,       component: DisplayPage      },
        { id: "audio",        label: t("settings.audio.page.title.sonido"),                  icon: Icons.speaker,       component: AudioPage        },
        { id: "network",      label: t("settings.network.page.title.red"),                   icon: Icons.globe,         component: NetworkPage      },
        { id: "input",        label: t("settings.input.title"),                              icon: Icons.keyboard,      component: InputPage        },
        { id: "bluetooth",    label: t("settings.bluetooth.page.title.bluetooth"),           icon: Icons.bluetooth,     component: BluetoothPage    },
        { id: "region",       label: t("settings.region.title"),                             icon: Icons.clock,         component: RegionPage       },
        { id: "defaultapps",  label: t("settings.defaultapps.title"),                        icon: Icons.app,           component: DefaultAppsPage  },
        { id: "apps",         label: t("settings.apps.page.title.aplicaciones"),             icon: Icons.grid,          component: AppsPage         },
        { id: "accessibility",label: t("settings.accessibility.title"),                      icon: Icons.accessibility, component: AccessibilityPage },
        { id: "notifications",label: t("settings.notif.title"),                              icon: Icons.bell,          component: NotificationsPage },
        { id: "bar",          label: t("settings.bar.title"),                                icon: Icons.panelTop,      component: BarPage          },
        { id: "dock",         label: t("settings.dock.page.title.dock"),                     icon: Icons.dock,          component: DockPage         },
        { id: "widgets",      label: t("settings.widgets.page.title.widgets"),               icon: Icons.puzzle,        component: WidgetsPage      },
        { id: "gaming",       label: t("settings.gaming.page.title.gaming"),                 icon: Icons.gamepad,       component: GamingPage       },
        { id: "autostart",    label: t("settings.autostart.page.title.inicio-automatico"),   icon: Icons.rocket,        component: AutostartPage    },
        { id: "power",        label: t("settings.power.page.title.energia"),                 icon: Icons.battery,       component: PowerPage        },
        { id: "about",        label: t("settings.about.page.title.acerca-de"),               icon: Icons.info,          component: AboutPage        },
    ]

    // ── Page stack (Gtk.Stack replaces Adw.ViewStack) ─────────────────────────
    // hhomogeneous: false — don't propagate the maximum of ALL pages as the
    // minimum width. With true (the default), the stack's minimum = max of every
    // page's minimum, which prevented the window from narrowing below ~1043 px.
    // With false, only the visible page's size is measured, so the window can
    // resize freely and collapse detection works correctly.
    const stack = new Gtk.Stack({
        hexpand: true,
        vexpand: true,
        hhomogeneous: false,
        vhomogeneous: false,
        css_classes: ["settings-stack"],
        transition_type: Gtk.StackTransitionType.NONE,
    })

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
            pageWidget = new Gtk.Label({ label: `Error cargando la página ${cat.label}` })
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
        stack.add_named(scroll, cat.id)
    })

    sidebar.set_name("crystal-settings-sidebar-list")

    // ── Search results page ───────────────────────────────────────────────────
    const searchResultsList = new Gtk.ListBox({
        css_classes: ["settings-list-box", "search-results-list"],
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

    const srClamp = CrystalClamp(searchResultsPage, 800, true)
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
            searchEntry.text = ""
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
            const row = sidebar.get_row_at_index(i + 1) // +1: spacer at index 0
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
        stack.visible_child_name = pageId
        syncSidebarSelection(pageId)
        updateNavButtons()
    }

    sidebar.connect("row-activated", (_, row) => {
        if (!row?.name) return
        navigateTo(row.name)
    })

    sidebar.connect("row-selected", () => {
        if (isProgrammaticNav) return
        const currentPage = stack.visible_child_name
        if (currentPage && currentPage !== "search-results")
            syncSidebarSelection(currentPage)
    })

    backBtn.connect("clicked", () => {
        if (historyIdx > 0) navigateTo(history[--historyIdx], false)
    })
    forwardBtn.connect("clicked", () => {
        if (historyIdx < history.length - 1) navigateTo(history[++historyIdx], false)
    })

    // Header spacer row — non-interactive, 44px, mirrors content header height
    const spacerRow = new Gtk.ListBoxRow({
        css_classes: ["sidebar-header-spacer-row"],
        selectable: false,
        activatable: false,
        focusable: false,
    })
    spacerRow.set_child(new Gtk.Box({}))
    sidebar.prepend(spacerRow)

    // Sidebar scroll
    const sidebarScroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        css_classes: ["settings-sidebar-scroll", "crystal-sidebar-capsule"],
        vexpand: true,
    })
    sidebarScroll.set_child(sidebar)
    sidebarScroll.set_name("crystal-settings-sidebar-scroll")

    // ── Search ────────────────────────────────────────────────────────────────
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: t("settings.search.placeholder"),
        css_classes: ["settings-search"],
        width_request: 280,
        max_width_chars: 30,
        valign: Gtk.Align.CENTER,
    })

    let pageBeforeSearch = ""

    searchEntry.connect("search-changed", () => {
        const query = searchEntry.text.trim()
        if (query) {
            if (stack.visible_child_name !== "search-results")
                pageBeforeSearch = stack.visible_child_name || categories[0]?.id || ""
            populateResults(query)
            stack.visible_child_name = "search-results"
            isProgrammaticNav = true
            sidebar.unselect_all()
            isProgrammaticNav = false
        } else {
            const target = pageBeforeSearch || categories[0]?.id || ""
            navigateTo(target, false)
            pageBeforeSearch = ""
        }
    })

    searchEntry.connect("stop-search", () => { searchEntry.text = "" })

    // ── Sidebar toggle ────────────────────────────────────────────────────────
    const sidebarToggle = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.sidebar, pixel_size: 16, css_classes: ["cs-icon"] }),
        css_classes: ["crystal-icon-btn", "sidebar-toggle"],
        tooltip_text: t("settings.nav.menu"),
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })

    // ── Header ────────────────────────────────────────────────────────────────
    const headerStart = new Gtk.Box({
        spacing: 8,
        valign: Gtk.Align.CENTER,
        css_classes: ["header-start-box"],
    })
    headerStart.append(sidebarToggle)
    headerStart.append(navCapsule)

    const closeBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.close, pixel_size: 14, css_classes: ["cs-icon"] }),
        css_classes: ["crystal-icon-btn"],
        tooltip_text: t("settings.window.close"),
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })
    closeBtn.connect("clicked", () => win.set_visible(false))

    const contentHeader = new Gtk.CenterBox({ css_classes: ["settings-header"] })
    contentHeader.set_start_widget(headerStart)
    contentHeader.set_center_widget(searchEntry)
    contentHeader.set_end_widget(closeBtn)

    // Gtk.WindowHandle makes the header draggable for window movement.
    // This replaces the title bar drag area that Adw.Window provided implicitly.
    const headerHandle = new Gtk.WindowHandle()
    headerHandle.set_child(contentHeader)

    // ── Content column ────────────────────────────────────────────────────────
    const contentColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
        margin_top: 8,
        margin_end: 8,
        margin_bottom: 8,
    })
    contentColumn.append(headerHandle)
    contentColumn.append(stack)

    // ── CrystalSplitView (replaces Adw.OverlaySplitView + Adw.Breakpoint) ────
    // collapseAt: CrystalSplitView self-manages the poll timer — no extra
    // wiring needed here. The ZeroMinBox wrapper inside the split view ensures
    // the window minimum stays near sidebarWidth so Hyprland can tile freely.
    const splitView = CrystalSplitView({
        sidebar: sidebarScroll,
        content: contentColumn,
        sidebarWidth: 250,
        collapseAt: 800,
        cssClasses: ["crystal-split-view"],
        name: "settings-splitview",
        // floatAnchor enables Popover mode in collapsed state so Hyprland's
        // blur:popups applies compositor blur to the content behind the sidebar.
        floatAnchor: sidebarToggle,
    })

    sidebarToggle.connect("clicked", () => {
        splitView.setShowSidebar(!splitView.showSidebar)
    })

    splitView.connectCollapsedChanged(() => {
        if (!sidebar.get_selected_row() && stack.visible_child_name)
            syncSidebarSelection(stack.visible_child_name)
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
