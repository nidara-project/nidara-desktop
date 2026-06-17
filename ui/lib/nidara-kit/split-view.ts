import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"

export interface NidaraSplitViewResult {
    widget: Gtk.Overlay
    get showSidebar(): boolean
    setShowSidebar(v: boolean): void
    get collapsed(): boolean
    setCollapsed(v: boolean): void
    connectCollapsedChanged(cb: (collapsed: boolean) => void): void
}

/**
 * NidaraSplitView — sidebar + content with overlay-collapse
 *
 * ── Layout ────────────────────────────────────────────────────────────────────
 *
 *   Non-collapsed:
 *     [spacer sidebarWidth px | contentZeroMin hexpand]
 *     sidebar overlay anchored START fills the spacer area visually.
 *
 *   Collapsed (no floatAnchor):
 *     [contentZeroMin takes full width]
 *     sidebar overlay floats on top when showSidebar = true.
 *     Transparent backdrop beneath catches click-outside → closes sidebar.
 *
 *   Collapsed (with floatAnchor):
 *     sidebar is reparented into a Gtk.Popover (xdg_popup) attached to
 *     floatAnchor. Hyprland's blur:popups = true applies compositor blur
 *     to the settings content visible behind the semi-transparent panel.
 *     Popover autohide handles click-outside; no separate backdrop needed.
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
export function NidaraSplitView(opts: {
    sidebar: Gtk.Widget
    content: Gtk.Widget
    sidebarWidth?: number
    /**
     * px — explicit fixed breakpoint: sidebar collapses when widget width drops
     * below this. When omitted (or 0), the breakpoint is CONTENT-DRIVEN: it is
     * derived every poll from `sidebarWidth + content.naturalWidth + collapseMargin`,
     * so the sidebar only collapses once there is no longer room for the sidebar
     * AND the content at its natural (un-clipped) width. This adapts per page —
     * narrow pages keep the sidebar docked at smaller widths than wide ones.
     */
    collapseAt?: number
    /** false disables auto-collapse entirely (manual setCollapsed only). Default true. */
    autoCollapse?: boolean
    /** px added to the content-driven breakpoint (sidebar gap + breathing room). Default 24. */
    collapseMargin?: number
    cssClasses?: string[]
    name?: string
    /**
     * When provided, the floating sidebar opens as a Gtk.Popover attached to
     * this widget instead of an Overlay child. The Popover creates an xdg_popup
     * surface, enabling Hyprland's blur:popups to blur the content behind it.
     * If omitted, the original Overlay + backdrop approach is used.
     */
    floatAnchor?: Gtk.Widget
    /**
     * Called whenever the sidebar's "presentation" changes: `true` when the
     * sidebar widget is on screen (docked, or shown in the collapsed popover),
     * `false` when it is hidden (collapsed with the popover closed, or manually
     * hidden). Lets the caller relocate controls that live inside the sidebar —
     * e.g. move a toolbar into a header slot while the sidebar is gone, so it
     * stays reachable. Called before the sidebar is reparented into the popover,
     * so a toolbar placed back into the sidebar here rides along into the popup.
     */
    onSidebarPresented?: (presented: boolean) => void
}): NidaraSplitViewResult {
    const {
        sidebar,
        content,
        sidebarWidth   = 250,
        collapseAt     = 0,
        autoCollapse   = true,
        collapseMargin = 24,
        cssClasses     = [],
        name,
        floatAnchor,
        onSidebarPresented,
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
    sidebar.vexpand  = true
    sidebar.hexpand  = true  // fill sidebarWrap's full width in docked mode

    // ── Spacer: reserves inline space for sidebar in non-collapsed mode ───────
    const spacer = new Gtk.Box({
        width_request: sidebarWidth,
        hexpand: false,
    })

    // ── Backdrop: catches click-outside in collapsed overlay mode ─────────────
    // Only used when floatAnchor is NOT provided (Popover handles its own autohide).
    const backdrop = new Gtk.Box({
        hexpand: true,
        vexpand: true,
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL,
        css_classes: ["nidara-split-backdrop"],
    })
    backdrop.visible = false
    const bdClick = new Gtk.GestureClick()
    bdClick.connect("pressed", () => {
        if (_collapsed && _showSidebar && !floatAnchor) {
            _showSidebar = false
            applyLayout()
        }
    })
    backdrop.add_controller(bdClick)

    // ── Zero-minimum content wrapper ──────────────────────────────────────────
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

    // ── Popover mode (floatAnchor) ─────────────────────────────────────────────
    // Sidebar is reparented into an xdg_popup (Gtk.Popover) so Hyprland's
    // blur:popups applies compositor blur to the content visible behind it.
    // The Popover is created lazily on first use and reused thereafter.
    //
    // IMPORTANT — why the permanent wrapper Box?
    // GTK4's Gtk.Popover.set_child() stores a `priv->child` pointer and skips
    // the call if `priv->child == child`. After `sidebar.unparent()`, the
    // sidebar's own parent pointer is cleared but the Popover's `priv->child`
    // might still hold the old reference. A second call to set_child(sidebar)
    // then hits the early-return path and never re-parents the widget, leaving
    // the list blank from the second open onwards.
    // Fix: set_child() is called ONCE with a permanent Box. The sidebar moves
    // in/out of that Box via append/unparent — bypassing the Popover's
    // single-child caching entirely.
    //
    // IMPORTANT — why set_parent(root) instead of set_parent(floatAnchor)?
    // pointing_to coordinates are always in the parent widget's coordinate space.
    // Parenting to floatAnchor (a button deep inside the header) would require
    // translate_coordinates(root → floatAnchor) to convert the target window-space
    // rect — this translation is fragile and produces a non-zero x offset that
    // makes the popup appear shifted (visually "wider" than the docked sidebar).
    // Parenting to `root` (the Gtk.Overlay that fills the window from 0,0) means
    // pointing_to IS window-space: no translation, no offset error.
    // Must match .nidara-sidebar-capsule's margin-left (8px) so the popup
    // surface is the same width and left-aligned as the docked sidebar panel.
    const SIDEBAR_GAP = 8

    let _popover: Gtk.Popover | null    = null
    let _popoverBox: Gtk.Overlay | null = null
    let _sidebarInPopover = false

    function ensurePopover(): Gtk.Popover {
        if (_popover) return _popover

        // ── Zero-minimum slot (same trick as contentZeroMin) ──────────────────
        // Gtk.Overlay only measures its BASE child for natural size; overlay
        // children are excluded. The base is an empty Box (natural width = 0),
        // so the Popover width = its own width_request = sidebarWidth-SIDEBAR_GAP,
        // regardless of how wide the sidebar's label text is naturally.
        // The sidebar sits as an overlay child with halign/valign=FILL, so it
        // fills the Overlay's full allocated area (= sidebarWidth-SIDEBAR_GAP).
        const zeroMinBase = new Gtk.Box()
        const sidebarSlot = new Gtk.Overlay({ hexpand: false, vexpand: true })
        sidebarSlot.set_child(zeroMinBase)
        _popoverBox = sidebarSlot

        const pop = new Gtk.Popover({
            has_arrow: false,
            autohide:  true,
            css_classes: ["nidara-sidebar-popup"],
            // sidebarWidth - SIDEBAR_GAP: the popup spans x=SIDEBAR_GAP..x=sidebarWidth
            // in root-space, matching the docked capsule (margin-left:8px inside a
            // sidebarWidth-wide wrapper with no right margin).
            width_request: sidebarWidth - SIDEBAR_GAP,
            position: Gtk.PositionType.BOTTOM,
        })
        pop.set_child(sidebarSlot)  // called once, never again
        // Parent to root (the full-window Overlay at 0,0) so pointing_to
        // coordinates are in window-space — no translate_coordinates needed.
        // floatAnchor is still used as the truthy flag in applyLayout but is
        // NOT the Popover parent.
        pop.set_parent(root)
        pop.connect("closed", () => {
            // Restore sidebar to sidebarWrap when popover closes (any reason)
            if (_sidebarInPopover) {
                sidebar.unparent()                    // removes from sidebarSlot
                sidebar.width_request = -1
                sidebar.halign        = Gtk.Align.FILL
                sidebar.hexpand       = true          // fill sidebarWrap in docked mode
                sidebarWrap.append(sidebar)
                sidebar.vexpand = true
                _sidebarInPopover = false
            }
            // Sync state without calling applyLayout (avoid re-open loop)
            if (_collapsed && _showSidebar) {
                _showSidebar = false
                // The sidebar is gone — hand its in-sidebar controls back to the
                // caller (e.g. a toolbar parks in the header so it stays reachable).
                onSidebarPresented?.(false)
            }
        })
        _popover = pop
        return pop
    }

    function openSidebarInPopover() {
        const pop = ensurePopover()
        if (!_sidebarInPopover) {
            sidebar.unparent()                        // removes from sidebarWrap
            sidebar.halign        = Gtk.Align.FILL    // fill the Overlay slot width
            sidebar.hexpand       = false             // don't push the Overlay wider
            sidebar.width_request = -1                // Overlay allocation drives the width
            _popoverBox!.add_overlay(sidebar)         // overlay child — excluded from measure
            sidebar.vexpand = true
            _sidebarInPopover = true
        }

        // ── Position: mirror the docked sidebar's visual placement ────────────
        //
        // pointing_to is in root's coordinate space (root fills the window from 0,0).
        // .nidara-sidebar-capsule: margin: 8px 0 8px 8px inside a sidebarWidth-wide
        // wrapper → capsule occupies x=[SIDEBAR_GAP, sidebarWidth].
        //
        // With position=BOTTOM the popup top = pointing_to.y + pointing_to.height.
        // rect.y = SIDEBAR_GAP-1 → popup top at y=SIDEBAR_GAP (matches capsule margin-top).
        // rect.width = popup.width_request = sidebarWidth - SIDEBAR_GAP.
        // GTK centers the popup over rect.x + rect.width/2, so popup left = rect.x = SIDEBAR_GAP. ✓
        {
            const rect = new Gdk.Rectangle()
            rect.x      = SIDEBAR_GAP
            rect.y      = SIDEBAR_GAP - 1
            rect.width  = sidebarWidth - SIDEBAR_GAP   // centering aligns left edge to SIDEBAR_GAP
            rect.height = 1
            pop.set_pointing_to(rect)
        }

        // ── Height: same top + bottom gap as the docked capsule ───────────────
        const totalH = root.get_allocated_height() || 600
        pop.height_request = Math.max(totalH - SIDEBAR_GAP * 2, 300)

        if (!pop.visible) pop.popup()
    }

    function closeSidebarPopover() {
        if (_popover?.visible) _popover.popdown()
        // closed signal handles the reparenting
    }

    // ── Layout sync ───────────────────────────────────────────────────────────
    const applyLayout = () => {
        // Relocate any in-sidebar controls FIRST: when the sidebar is about to be
        // presented, a toolbar parked in the header moves back into the sidebar so
        // it rides along (incl. into the popover); when hidden, it parks elsewhere.
        onSidebarPresented?.(_showSidebar)

        if (!_collapsed) {
            // ── Docked mode ───────────────────────────────────────────────────
            spacer.width_request = _showSidebar ? sidebarWidth : 0
            spacer.visible       = _showSidebar
            sidebarWrap.visible  = _showSidebar
            backdrop.visible     = false
            sidebarWrap.remove_css_class("sidebar-floating")
            if (floatAnchor) closeSidebarPopover()
        } else if (floatAnchor) {
            // ── Collapsed + Popover mode ──────────────────────────────────────
            spacer.width_request = 0
            spacer.visible       = false
            sidebarWrap.visible  = false
            backdrop.visible     = false
            if (_showSidebar) {
                openSidebarInPopover()
            } else {
                closeSidebarPopover()
            }
        } else {
            // ── Collapsed + Overlay fallback ──────────────────────────────────
            spacer.width_request = 0
            spacer.visible       = false
            sidebarWrap.visible  = _showSidebar
            backdrop.visible     = _showSidebar
            if (_showSidebar) {
                sidebarWrap.add_css_class("sidebar-floating")
            } else {
                sidebarWrap.remove_css_class("sidebar-floating")
            }
        }
    }

    const doCollapse = (v: boolean) => {
        if (v === _collapsed) return

        // If uncollapsing while sidebar is in the popover, restore it synchronously
        // so sidebarWrap has its child back before applyLayout() runs.
        if (!v && _sidebarInPopover) {
            sidebar.unparent()
            sidebar.width_request = -1
            sidebar.halign        = Gtk.Align.FILL
            sidebar.hexpand       = true  // fill sidebarWrap in docked mode
            sidebarWrap.append(sidebar)
            sidebar.vexpand = true
            _sidebarInPopover = false
            _popover?.popdown()
        }

        _collapsed = v
        // Collapsing → hide sidebar (becomes overlay-on-demand)
        // Uncollapsing → always restore sidebar inline
        _showSidebar = !v
        applyLayout()
        callbacks.forEach(cb => cb(_collapsed))
    }

    applyLayout()

    // ── Auto-collapse: 200 ms poll while mapped ────────────────────────────────
    //
    // Breakpoint is either the explicit `collapseAt` px, or — when that is 0 —
    // content-driven: sidebarWidth + the content's current natural width +
    // collapseMargin. The content natural is measured every tick so it adapts to
    // the active page (Settings swaps pages), and the sidebar collapses exactly
    // when the window can no longer fit the sidebar plus un-clipped content.
    const collapseThreshold = (): number => {
        if (collapseAt > 0) return collapseAt
        // measure() → [minimum, natural, min_baseline, nat_baseline]
        const contentNat = content.measure(Gtk.Orientation.HORIZONTAL, -1)[1]
        return sidebarWidth + contentNat + collapseMargin
    }

    if (autoCollapse) {
        let timerId: number | null = null

        const startPoll = () => {
            if (timerId !== null) return
            timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 200, () => {
                const w = root.get_width()
                if (w > 0) doCollapse(w < collapseThreshold())
                return GLib.SOURCE_CONTINUE
            })
        }

        const stopPoll = () => {
            if (timerId === null) return
            GLib.source_remove(timerId)
            timerId = null
        }

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
