import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import { NidaraSplitView, type NidaraSplitViewResult } from "./split-view"

export interface NidaraWindowOpts {
    app: any
    title: string
    /** Sidebar navigation widget — e.g. NidaraSidebar(...).widget. */
    sidebar: Gtk.Widget
    /** Main content widget (the caller swaps its children). */
    content: Gtk.Widget
    /** Icon for the sidebar toggle button (passed in so the lib stays free of the
     *  app's icon set). */
    toggleIcon: Gio.FileIcon
    /** Optional widget centered in the header (rarely used now). */
    headerCenter?: Gtk.Widget
    /** Optional widget in the header start, after the toggle + nav (e.g. a title /
     *  breadcrumb). */
    headerTitle?: Gtk.Widget
    /** Optional widget at the header's end (a close button, etc.). */
    headerEnd?: Gtk.Widget
    /** Optional widget pinned at the top of the sidebar capsule (e.g. a search box). */
    sidebarTop?: Gtk.Widget
    /** Optional widget placed in the header next to the toggle (e.g. a back/forward
     *  nav capsule). */
    toolbarExtra?: Gtk.Widget
    sidebarWidth?: number
    defaultWidth?: number
    defaultHeight?: number
    /** Extra css classes on the Gtk.Window. */
    cssClasses?: string[]
    /** Gtk.Window name (for #id CSS / Hyprland matching). */
    name?: string
    // No tooltip opt for the toggle ON PURPOSE — native GTK tooltips are
    // unthemeable. Attach the glass tooltip to the returned `sidebarToggle`.
}

export interface NidaraWindowResult {
    window: Gtk.Window
    /** Toggle visibility (presents on show). */
    toggle: () => void
    splitView: NidaraSplitViewResult
    /** The sidebar toggle button. */
    sidebarToggle: Gtk.Button
}

/**
 * NidaraWindow — the ONE place a settings-style window shell is assembled.
 *
 * Undecorated glass window + NidaraSplitView (sidebar capsule | content) and a
 * draggable header. The toggle + nav capsule + title live permanently in the
 * header start (toggle · nav · title … end); the sidebar capsule top holds an
 * optional search box. The caller supplies the sidebar, the content, and optional
 * header/sidebar widgets — so any new window is built by reusing this, not by
 * re-assembling the chrome. See feedback_universal_components.
 */
export function NidaraWindow(opts: NidaraWindowOpts): NidaraWindowResult {
    const {
        app, title, sidebar, content, toggleIcon,
        headerCenter, headerTitle, headerEnd, sidebarTop, toolbarExtra,
        sidebarWidth = 250, defaultWidth = 1000, defaultHeight = 700,
        cssClasses = [], name,
    } = opts

    // decorated:false + Gtk.WindowHandle on the header = custom CSD, no Adwaita.
    const win = new Gtk.Window({
        title,
        application: app,
        css_classes: cssClasses,
        default_width: defaultWidth,
        default_height: defaultHeight,
        decorated: false,
        visible: false,
    })
    if (name) win.set_name(name)

    // ── Sidebar capsule (toolbar on top, scrolling list below) ────────────────
    const sidebarScroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        css_classes: ["nidara-window-sidebar-scroll"],
        vexpand: true,
    })
    sidebarScroll.set_child(sidebar)

    const sidebarColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["nidara-sidebar-capsule"],
        vexpand: true,
    })
    // Optional search box pinned above the navigation list.
    if (sidebarTop) {
        const topSlot = new Gtk.Box({ css_classes: ["nidara-sidebar-top"] })
        topSlot.append(sidebarTop)
        sidebarColumn.append(topSlot)
    }
    sidebarColumn.append(sidebarScroll)

    // ── Sidebar toggle ────────────────────────────────────────────────────────
    const sidebarToggle = new Gtk.Button({
        child: new Gtk.Image({ gicon: toggleIcon, pixel_size: 16, css_classes: ["nd-icon"] }),
        css_classes: ["nidara-icon-btn", "sidebar-toggle"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })

    // ── Header over the content (draggable) ───────────────────────────────────
    // Toggle + nav capsule + title live here permanently (no reparenting): the
    // toggle stays reachable whether the sidebar is docked, collapsed or hidden.
    const headerStart = new Gtk.Box({
        spacing: 8,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
        css_classes: ["nidara-window-tools"],
    })
    headerStart.append(sidebarToggle)
    if (toolbarExtra) headerStart.append(toolbarExtra)
    if (headerTitle) headerStart.append(headerTitle)

    const contentHeader = new Gtk.CenterBox({ css_classes: ["nidara-window-header"] })
    contentHeader.set_start_widget(headerStart)
    if (headerCenter) contentHeader.set_center_widget(headerCenter)
    if (headerEnd) contentHeader.set_end_widget(headerEnd)

    const headerHandle = new Gtk.WindowHandle()
    headerHandle.set_child(contentHeader)

    const contentColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true, vexpand: true,
        margin_top: 8,
    })
    contentColumn.append(headerHandle)
    contentColumn.append(content)

    // ── Split view (content-driven collapse; popover in collapsed mode) ───────
    const splitView = NidaraSplitView({
        sidebar: sidebarColumn,
        content: contentColumn,
        sidebarWidth,
        cssClasses: ["nidara-split-view"],
        name: "nidara-window-splitview",
        floatAnchor: sidebarToggle,
    })

    sidebarToggle.connect("clicked", () => {
        splitView.setShowSidebar(!splitView.showSidebar)
    })

    // ── Glass container ───────────────────────────────────────────────────────
    const mainContainer = new Gtk.Box({ css_classes: ["nidara-window-glass"] })
    mainContainer.set_name("nidara-window-glass")
    mainContainer.append(splitView.widget)
    win.set_child(mainContainer)

    // Hide instead of destroy — the window is reused across toggles.
    win.connect("close-request", () => { win.set_visible(false); return true })

    const toggle = () => {
        win.visible = !win.visible
        if (win.visible) win.present()
    }

    return { window: win, toggle, splitView, sidebarToggle }
}
