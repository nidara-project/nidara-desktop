import Gtk from "gi://Gtk?version=4.0"
import { setWindowAppId } from "../app-id"
import Gio from "gi://Gio"
import { NidaraScrolled } from "./scrolled"
import { NidaraSplitView, type NidaraSplitViewResult } from "./split-view"
import { RADIUS, WINDOW_LAYOUT, collapseAtFor, minWindowWidthFor } from "../tokens"

/**
 * Chrome radii, named for what they dress: the window is `glass(floating)` =
 * `RADIUS.lg`, the sidebar capsule is `material-card` = `RADIUS.md`. The numbers
 * themselves live in `lib/tokens.ts` (mirrored by `--nidara-radius-*`), which is
 * where the ladder is documented — these are aliases, not a second source.
 */
export const NIDARA_WINDOW_RADIUS = RADIUS.lg
export const NIDARA_CARD_RADIUS = RADIUS.md

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
    /**
     * The content pane's CONSTANT width (see WINDOW_LAYOUT). It is not a hint: it
     * sets the sidebar's breakpoint and the width the window opens at, and the
     * caller is expected to clamp its pages to the same number.
     */
    contentWidth?: number
    /** Only a floor for the OPENING size — see `openWidth`. The window's minimum is
     *  the distress width, not this. */
    defaultWidth?: number
    defaultHeight?: number
    /** Extra css classes on the Gtk.Window. */
    cssClasses?: string[]
    /** Gtk.Window name (for #id CSS / Hyprland matching). */
    name?: string
    /**
     * The Wayland app-id this window declares for ITSELF, instead of inheriting
     * the process-wide one. A settings-style window is a real application window
     * and the compositor should file it as one — see `ui/lib/app-id.ts`.
     */
    appId?: string
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
        sidebarWidth = WINDOW_LAYOUT.sidebar,
        contentWidth = WINDOW_LAYOUT.content,
        defaultWidth, defaultHeight = 760,
        cssClasses = [], name, appId,
    } = opts

    // The window opens WIDE ENOUGH TO BE ITSELF: sidebar docked and the pane at its
    // full width. A default below the breakpoint would greet every user with the
    // narrow (floating-sidebar) layout, which is the fallback, not the design.
    const minFloorWidth = minWindowWidthFor(WINDOW_LAYOUT.contentFloor)
    const openWidth = Math.max(defaultWidth ?? 0, collapseAtFor(sidebarWidth, contentWidth) + 48)

    // decorated:false + Gtk.WindowHandle on the header = custom CSD, no Adwaita.
    const win = new Gtk.Window({
        title,
        application: app,
        css_classes: cssClasses,
        default_width: openWidth,
        default_height: defaultHeight,
        decorated: false,
        visible: false,
    })
    if (name) win.set_name(name)
    if (appId) setWindowAppId(win, appId)
    // ── The floor is the DISTRESS width, not the pane ─────────────────────────
    //
    // NidaraSplitView's ZeroMinOverlay deliberately severs the content's minimum
    // from the window (so the pane's width can never dictate how a compositor
    // tiles), which also means nothing else would ever stop a resize: before this
    // the window went to 250px with the page clipped at 403 (measured 2026-08-11).
    // GTK forwards a size request as xdg_toplevel.set_min_size.
    //
    // ⚠️ It is a REQUEST, and a tiling compositor is not asking. Hyprland tiles at
    // whatever the layout says; GTK then lays the window out at its own minimum
    // anyway and the compositor CUTS the difference — measured in a 673px tile with
    // the floor at the pane's 802: 129px gone off the right, taking a row's trailing
    // button with it. Hiding a control is worse than tightening text, so the floor
    // is the distress width and the pane yields into a window too small for it.
    //
    // ⚠️ And the floor CANNOT be conditional on being tiled, which was the first fix
    // here: Hyprland never clears the `tiled` toplevel state. Measured on a window it
    // had just floated and resized to 600×800, GTK still carried `tiled-top`,
    // `tiled-left`, `tiled-right`, `tiled-bottom` AND `maximized`. As a signal for
    // "someone else decides how wide I am" it is stuck on, so a floor that reads it
    // is a floor that never comes back.
    win.set_size_request(minFloorWidth, WINDOW_LAYOUT.minHeight)

    // ── Sidebar capsule (toolbar on top, scrolling list below) ────────────────
    // NidaraScrolled, like every other scroll view in the DE — a window's sidebar is
    // not an exception to the rule (design-system.md, "Any ScrolledWindow — windows
    // included"). It was the last GTK scrollbar left inside a Nidara window, sitting
    // two panes away from ours and looking like a different component.
    // reserveLane: false because `.nidara-sidebar` carries its own inset on BOTH sides and
    // the lane lives inside it. Reserving here instead adds the lane to ONE side, so a
    // row's hover/selected fill sits `lane` px further from the right wall than the left —
    // the user spotted that immediately, and a sidebar is where it shows most (narrow
    // capsule, high-contrast selection). The inset does not have to be as wide as the lane:
    // these rows have no trailing control for the pill to reach.
    const { widget: sidebarScrollWidget, scrolled: sidebarScroll } = NidaraScrolled({
        child: sidebar,
        reserveLane: false,
        // Flush with the capsule's rounded bottom, so the pill stops short of it.
        cornerRadius: NIDARA_CARD_RADIUS,
        cssClasses: ["nidara-window-sidebar-scroll"],
    })
    sidebarScroll.vexpand = true
    sidebarScrollWidget.vexpand = true
    // Gap to the search slot above. It lives on the OVERLAY, not on the view: the
    // bar spans the overlay, so a margin on the view alone would leave the lane 4px
    // taller than the viewport it maps to and the thumb would drift from the content.
    sidebarScrollWidget.margin_top = 4

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
    sidebarColumn.append(sidebarScrollWidget)

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

    // ── Split view (fixed breakpoint; popover in collapsed mode) ──────────────
    // The breakpoint is exactly "sidebar + the content pane", so the sidebar docks
    // precisely while there is room for it AND the pane at full width, and leaving
    // it does not change the pane's width. See WINDOW_LAYOUT.
    const splitView = NidaraSplitView({
        sidebar: sidebarColumn,
        content: contentColumn,
        sidebarWidth,
        collapseAt: collapseAtFor(sidebarWidth, contentWidth),
        cssClasses: ["nidara-split-view"],
        name: "nidara-window-splitview",
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
