import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import status from "../../core/Status"
import { NidaraClamp, NidaraSidebar, NidaraWindow } from "../../../lib/nidara-kit"

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
import AccessibilityPage from "./pages/Accessibility"
import UsersPage from "./pages/Users"
import GamingPage from "./pages/Gaming"
import AiPage from "./pages/Ai"
import { beginPage, endPage, clearSearchIndex, getSearchIndex, type SettingsNav } from "./SettingsHelpers"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import IconButton from "../../common/IconButton"

/**
 * Settings - System Configuration Panel
 * Pure GTK4 — no Adwaita dependency.
 */
export default function Settings(monitor: Gdk.Monitor) {
    clearSearchIndex()

    // ── Navigation controls ───────────────────────────────────────────────────
    const backBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.chevronLeft, pixel_size: 14, css_classes: ["nd-icon"] }),
        css_classes: ["nidara-icon-btn", "nav-btn"],
        tooltip_text: t("settings.nav.back"),
        sensitive: false,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })
    const forwardBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.chevronRight, pixel_size: 14, css_classes: ["nd-icon"] }),
        css_classes: ["nidara-icon-btn", "nav-btn"],
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

    // The glass window itself is assembled by NidaraWindow at the end (so its
    // header/toolbar can wire to the sidebar, search and nav built below).

    // ── Sidebar ───────────────────────────────────────────────────────────────
    // The navigation list itself is the universal NidaraSidebar component; it's
    // created after the pages are built (below) so its onSelect can call navigateTo.
    // Order = macOS-style thematic clusters with title-less dividers (groupStart):
    // 1) connectivity · 2) the bulk (look/shell/behaviour/apps) · 3) system & devices.
    const categories = [
        // ── Connectivity ────────────────────────────────────────────────────────
        { id: "network",      label: t("settings.network.title"),     icon: Icons.globe,         component: NetworkPage      },
        { id: "bluetooth",    label: t("settings.bluetooth.title"),   icon: Icons.bluetooth,     component: BluetoothPage    },
        // ── Look, shell & behaviour ─────────────────────────────────────────────
        { id: "appearance",   label: t("settings.appearance.title"),  icon: Icons.palette,       component: AppearancePage,   groupStart: true },
        { id: "display",      label: t("settings.display.title"),     icon: Icons.monitor,       component: DisplayPage      },
        { id: "audio",        label: t("settings.audio.title"),       icon: Icons.speaker,       component: AudioPage        },
        { id: "bar",          label: t("settings.bar.title"),         icon: Icons.panelTop,      component: BarPage          },
        { id: "dock",         label: t("settings.dock.title"),        icon: Icons.dock,          component: DockPage         },
        { id: "widgets",      label: t("settings.widgets.title"),     icon: Icons.puzzle,        component: WidgetsPage      },
        { id: "gaming",       label: t("settings.gaming.title"),      icon: Icons.gamepad,       component: GamingPage       },
        { id: "notifications",label: t("settings.notif.title"),       icon: Icons.bell,          component: NotificationsPage },
        { id: "accessibility",label: t("settings.accessibility.title"),icon: Icons.accessibility,component: AccessibilityPage },
        { id: "apps",         label: t("settings.apps.section"),      icon: Icons.grid,          component: AppsPage         },
        // ── System & devices ────────────────────────────────────────────────────
        { id: "input",        label: t("settings.input.title"),       icon: Icons.keyboard,      component: InputPage,        groupStart: true },
        { id: "power",        label: t("settings.power.title"),       icon: Icons.battery,       component: PowerPage        },
        { id: "region",       label: t("settings.region.title"),      icon: Icons.clock,         component: RegionPage       },
        { id: "autostart",    label: t("settings.autostart.title"),   icon: Icons.rocket,        component: AutostartPage    },
        { id: "users",        label: t("settings.users.title"),       icon: Icons.userRound,     component: UsersPage        },
        { id: "ai",           label: t("settings.ai.title"),          icon: Icons.sparkles,      component: AiPage           },
        { id: "about",        label: t("settings.about.title"),       icon: Icons.info,          component: AboutPage        },
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

    // Page id → breadcrumb metadata. Seeded from categories; subpages add their own.
    const pageTitles = new Map<string, { title: string; parentId?: string }>()
    categories.forEach(c => pageTitles.set(c.id, { title: c.label }))

    const showPage = (id: string) => {
        if (id === activePageId) return
        const next = pageCache.get(id)
        if (!next) return
        const current = pageCache.get(activePageId)
        if (current) contentArea.remove(current)
        contentArea.append(next)
        activePageId = id
    }

    // Every page (and dynamically-pushed subpage) is a clamped, scrollable box.
    const wrapPage = (widget: Gtk.Widget): Gtk.Widget => {
        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
            css_classes: ["settings-page-scroll"],
        })
        scroll.set_child(NidaraClamp(widget, 800, true))   // NidaraClamp replaces Adw.Clamp
        return scroll
    }

    // ── Header breadcrumb (title, with a clickable parent for subpages) ─────────
    const breadcrumb = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER, css_classes: ["nidara-window-breadcrumb"] })
    const updateBreadcrumb = (pageId: string) => {
        let c = breadcrumb.get_first_child()
        while (c) { breadcrumb.remove(c); c = breadcrumb.get_first_child() }
        const meta = pageTitles.get(pageId)
        if (!meta) return   // e.g. the search-results page — no title
        if (meta.parentId) {
            const parent = pageTitles.get(meta.parentId)
            const link = new Gtk.Button({
                label: parent?.title ?? "",
                css_classes: ["nidara-breadcrumb-link"],
                valign: Gtk.Align.CENTER,
            })
            link.connect("clicked", () => navigateTo(meta.parentId!))
            breadcrumb.append(link)
            breadcrumb.append(new Gtk.Label({ label: "›", css_classes: ["nidara-breadcrumb-sep"] }))
        }
        breadcrumb.append(new Gtk.Label({ label: meta.title, css_classes: ["nidara-window-title"], halign: Gtk.Align.START }))
    }

    // Navigation handle handed to each page so it can push detail subpages. Its
    // methods reference navigateTo/history defined below; they only run on user
    // interaction, by which point those are initialised.
    const nav: SettingsNav = {
        pushSubpage: ({ id, title, parentId, build }) => {
            pageTitles.set(id, { title, parentId })
            let w: Gtk.Widget
            try { w = build() }
            catch (e) {
                console.error(`[Settings] Failed to build subpage ${id}:`, e)
                w = new Gtk.Label({ label: t("settings.page.load-error") })
            }
            pageCache.set(id, wrapPage(w))   // rebuild on each push → fresh content
            navigateTo(id)
        },
        goBack: () => { if (historyIdx > 0) navigateTo(history[--historyIdx], false) },
    }

    categories.forEach(cat => {
        // Build page widget
        let pageWidget: Gtk.Widget
        try {
            beginPage(cat.id, cat.label)
            pageWidget = (cat.component as (n: SettingsNav) => Gtk.Widget)(nav)
            endPage()
        } catch (e) {
            endPage()
            console.error(`[Settings] Failed to load page ${cat.id}:`, e)
            pageWidget = new Gtk.Label({ label: `${t("settings.page.load-error")}: ${cat.label}` })
        }

        pageCache.set(cat.id, wrapPage(pageWidget))
    })

    // navigateTo is defined further down; the onSelect closure only runs on a
    // user click, by which point it's assigned.
    const sidebar = NidaraSidebar(
        categories.map(c => ({ id: c.id, label: c.label, icon: c.icon, groupStart: c.groupStart })),
        (id) => navigateTo(id),
    )
    sidebar.widget.set_name("nidara-settings-sidebar-list")

    // ── Search results page ───────────────────────────────────────────────────
    const searchResultsList = new Gtk.ListBox({
        css_classes: ["nidara-list", "search-results-list"],
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

    const srClamp = NidaraClamp(searchResultsPage, 800, true)
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
                css_classes: ["search-result-page-icon", "nd-icon"],
                opacity: 0.6,
            }))

            const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true })
            text.append(new Gtk.Label({ label: item.label, css_classes: ["nidara-row-title"], halign: Gtk.Align.START }))
            if (item.subtitle) {
                text.append(new Gtk.Label({
                    label: item.subtitle,
                    css_classes: ["nidara-row-subtitle"],
                    halign: Gtk.Align.START,
                    ellipsize: 3,
                    max_width_chars: 50,
                }))
            }
            row.append(text)
            row.append(new Gtk.Label({ label: item.pageLabel, css_classes: ["search-result-chip"] }))
            row.append(new Gtk.Image({ gicon: Icons.chevronRight, pixel_size: 14, opacity: 0.4, css_classes: ["nd-icon"] }))

            const lbr = new Gtk.ListBoxRow({ css_classes: ["nidara-row", "search-result-row"] })
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
        sidebar.select(pageId)
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
        updateBreadcrumb(pageId)
        updateNavButtons()
    }

    // Row activation (user click) is handled by NidaraSidebar's onSelect →
    // navigateTo. row-selected stays here for the defensive re-sync (e.g. GTK
    // clearing selection when the search page steals focus).
    sidebar.widget.connect("row-selected", () => {
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

    // ── Search ────────────────────────────────────────────────────────────────
    // Custom search box: our own nd-icon magnifier + Gtk.Text. Gtk.SearchEntry
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
        hexpand: true,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.CENTER,
    })
    searchEntry.append(new Gtk.Image({
        gicon: Icons.search,
        pixel_size: 15,
        css_classes: ["nd-icon", "settings-search-icon"],
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
            sidebar.unselectAll()
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

    // ── Window shell ──────────────────────────────────────────────────────────
    // The universal NidaraWindow assembles the glass window + split view + header.
    // Settings supplies the sidebar, the content, the search box (sidebar top), the
    // nav capsule + breadcrumb title (header start) and the close button (header end).
    const closeBtn = IconButton({
        icon: Icons.close,
        iconSize: 14,
        variant: "danger",
        tooltip: t("settings.window.close"),
        onClick: () => cw.window.set_visible(false),
    })

    const cw = NidaraWindow({
        app,
        title: "Nidara Settings",
        name: "nidara-settings-window",
        cssClasses: ["nd-ignore", "nidara-settings-window"],
        sidebar: sidebar.widget,
        content: contentArea,
        toggleIcon: Icons.sidebar,
        toggleTooltip: t("settings.nav.menu"),
        sidebarTop: searchEntry,
        headerTitle: breadcrumb,
        headerEnd: closeBtn,
        toolbarExtra: navCapsule,
        sidebarWidth: 250,
        defaultWidth: 1000,
        defaultHeight: 700,
    })
    const win = cw.window

    // Keep status.settings_open honest — it's what dumpState reports as
    // overlays.settings. notify::visible catches every show/hide path (present(),
    // the close button's set_visible(false), and close-request), so the flag tracks
    // the real window state instead of staying permanently false. (One window in
    // practice; on a multi-monitor multi-window setup the last event wins, which is
    // moot until that design is revisited — see tech-debt #16.)
    status.settings_open = win.get_visible()
    win.connect("notify::visible", () => { status.settings_open = win.get_visible() })

    cw.splitView.connectCollapsedChanged(() => {
        if (!sidebar.getSelectedId() && activePageId)
            syncSidebarSelection(activePageId)
    })

    ;(win as any).toggle = cw.toggle

    // Drive navigation from outside (`ags request settingsPage <id>`) — lets
    // scripts and agents open a specific page without synthesizing clicks.
    ;(win as any).navigateToPage = (id: string): boolean => {
        if (!pageCache.has(id)) return false
        navigateTo(id)
        return true
    }

    // Default page — seeds history. Appearance is the chosen landing (not the
    // sidebar's first item), falling back to the first category if it's ever gone.
    const defaultPage = categories.find(c => c.id === "appearance")?.id ?? categories[0]?.id
    if (defaultPage) navigateTo(defaultPage)

    return win
}
