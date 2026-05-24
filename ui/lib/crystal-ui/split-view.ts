import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

export interface CrystalSplitViewResult {
    widget: Gtk.Overlay
    get showSidebar(): boolean
    setShowSidebar(v: boolean): void
    get collapsed(): boolean
    setCollapsed(v: boolean): void
    connectCollapsedChanged(cb: (collapsed: boolean) => void): void
}

/**
 * CrystalSplitView — sidebar + content with overlay-collapse
 *
 * ── Layout ────────────────────────────────────────────────────────────────────
 *
 *   Non-collapsed:
 *     [spacer sidebarWidth px | contentZeroMin hexpand]
 *     sidebar overlay anchored START fills the spacer area visually.
 *
 *   Collapsed:
 *     [contentZeroMin takes full width]
 *     sidebar overlay floats on top when showSidebar = true.
 *     Transparent backdrop beneath catches click-outside → closes sidebar.
 *
 * ── Zero-minimum content wrapper ─────────────────────────────────────────────
 *
 *   GTK4's Gtk.Overlay measures ONLY its base child for minimum size; overlay
 *   children are excluded (GtkOverlayLayoutChild.measure defaults to false).
 *   We exploit this: the base child is an empty Gtk.Box (minimum = 0) and the
 *   actual content is an overlay child with halign/valign FILL so it always
 *   fills the available allocation. This way the ancestor Gtk.Window's minimum
 *   width = sidebarWidth (spacer) instead of sidebarWidth + content_minimum.
 *   GTK sends this small minimum to Hyprland via xdg_toplevel.set_min_size,
 *   which allows free floating resize and compositor tiling below the content's
 *   natural width.
 *
 * ── Auto-collapse ─────────────────────────────────────────────────────────────
 *
 *   When collapseAt > 0 the split view self-manages collapse by polling
 *   root.get_width() every 200 ms while the widget is mapped. This covers both
 *   floating resize (where notify::width on the window is reliable) and Wayland
 *   compositor tiling (where the configure event bypasses GTK property
 *   notifications on internal widgets).
 */
export function CrystalSplitView(opts: {
    sidebar: Gtk.Widget
    content: Gtk.Widget
    sidebarWidth?: number
    /** px — sidebar auto-collapses when widget width drops below this. 0 = manual only. */
    collapseAt?: number
    cssClasses?: string[]
    name?: string
}): CrystalSplitViewResult {
    const {
        sidebar,
        content,
        sidebarWidth = 250,
        collapseAt   = 0,
        cssClasses   = [],
        name,
    } = opts

    let _showSidebar = true
    let _collapsed   = false
    const callbacks: Array<(c: boolean) => void> = []

    // ── Sidebar overlay (always a Gtk.Overlay layer, never inline) ────────────
    const sidebarWrap = new Gtk.Box({
        width_request: sidebarWidth,
        hexpand: false,
        vexpand: true,
        halign: Gtk.Align.START,
        valign: Gtk.Align.FILL,
    })
    sidebarWrap.append(sidebar)
    sidebar.vexpand = true

    // ── Spacer: reserves inline space for sidebar in non-collapsed mode ───────
    const spacer = new Gtk.Box({
        width_request: sidebarWidth,
        hexpand: false,
    })

    // ── Backdrop: catches click-outside in collapsed mode ─────────────────────
    const backdrop = new Gtk.Box({
        hexpand: true,
        vexpand: true,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL,
        css_classes: ["crystal-split-backdrop"],
    })
    backdrop.visible = false
    const bdClick = new Gtk.GestureClick()
    bdClick.connect("pressed", () => {
        if (_collapsed && _showSidebar) {
            _showSidebar = false
            applyLayout()
        }
    })
    backdrop.add_controller(bdClick)

    // ── Zero-minimum content wrapper ──────────────────────────────────────────
    // Gtk.Overlay measures only its BASE child for minimum size; overlay children
    // (add_overlay) are NOT included in the minimum computation by default.
    //
    // Base = empty Gtk.Box → minimum width = 0
    // content = overlay child with FILL alignment → allocated at full parent size
    //
    // Result: contentZeroMin.minimum_width = 0, so the root Overlay (and the
    // ancestor window) reports minimum ≈ sidebarWidth instead of
    // sidebarWidth + content_minimum.
    const contentZeroMin = new Gtk.Overlay({
        hexpand: true,
        vexpand: true,
    })
    contentZeroMin.set_child(new Gtk.Box({ hexpand: true, vexpand: true }))
    content.halign  = Gtk.Align.FILL
    content.valign  = Gtk.Align.FILL
    content.hexpand = true
    content.vexpand = true
    contentZeroMin.add_overlay(content)

    // ── Content base layer ────────────────────────────────────────────────────
    const contentBase = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        vexpand: true,
    })
    contentBase.append(spacer)
    contentBase.append(contentZeroMin)

    // ── Root: Gtk.Overlay ─────────────────────────────────────────────────────
    const root = new Gtk.Overlay({
        hexpand: true,
        vexpand: true,
        css_classes: cssClasses,
    })
    if (name) root.set_name(name)
    root.set_child(contentBase)
    root.add_overlay(backdrop)     // z: below sidebar
    root.add_overlay(sidebarWrap)  // z: above backdrop

    // ── Layout sync ───────────────────────────────────────────────────────────
    const applyLayout = () => {
        if (!_collapsed) {
            spacer.width_request = _showSidebar ? sidebarWidth : 0
            spacer.visible       = _showSidebar
            sidebarWrap.visible  = _showSidebar
            backdrop.visible     = false
        } else {
            spacer.width_request = 0
            spacer.visible       = false
            sidebarWrap.visible  = _showSidebar
            backdrop.visible     = _showSidebar
        }
    }

    const doCollapse = (v: boolean) => {
        if (v === _collapsed) return
        _collapsed = v
        // Collapsing → hide sidebar (it becomes overlay-on-demand)
        // Uncollapsing → always restore sidebar (it belongs inline again)
        _showSidebar = !v
        applyLayout()
        callbacks.forEach(cb => cb(_collapsed))
    }

    applyLayout()

    // ── Auto-collapse: 200 ms poll while mapped ────────────────────────────────
    // notify::width is only available on top-level GtkWindow, not on internal
    // widgets. GTK4 removed size-allocate as a vfunc-less signal. Polling
    // root.get_width() every 200 ms while mapped is the portable solution:
    // it handles floating resize, tiling, and multi-monitor moves equally.
    if (collapseAt > 0) {
        let timerId: number | null = null

        const startPoll = () => {
            if (timerId !== null) return
            timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 200, () => {
                const w = root.get_width()
                if (w > 0) doCollapse(w < collapseAt)
                return GLib.SOURCE_CONTINUE
            })
        }

        const stopPoll = () => {
            if (timerId === null) return
            GLib.source_remove(timerId)
            timerId = null
        }

        // `map` fires when the widget is first drawn on screen;
        // `unmap` fires when hidden. These are the correct GTK4 signals —
        // `notify::mapped` is NOT a standard GObject property notification
        // on GtkWidget and silently does nothing.
        root.connect("map", startPoll)
        root.connect("unmap", stopPoll)
    }

    return {
        widget: root,

        get showSidebar() { return _showSidebar },
        setShowSidebar(v: boolean) {
            _showSidebar = v
            applyLayout()
        },

        get collapsed() { return _collapsed },
        setCollapsed(v: boolean) { doCollapse(v) },

        connectCollapsedChanged(cb) { callbacks.push(cb) },
    }
}
