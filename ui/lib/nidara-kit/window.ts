import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import { NidaraAppWindow, type NidaraCloseMode } from "./app-window"
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

/**
 * The sidebar, and everything that only means anything WITH one.
 *
 * Grouped rather than flattened so the signature stays honest: a window without a
 * sidebar has no sidebar options to ignore, and adding one later is filling in
 * this object rather than migrating to a different component.
 */
export interface NidaraWindowSidebar {
    /** The navigation widget — e.g. `NidaraSidebar(...).widget`, or a wizard's step list. */
    widget: Gtk.Widget
    /** Icon for the toggle button (passed in so the kit stays free of the app's icon set). */
    toggleIcon: Gio.FileIcon
    /** Pinned at the top of the sidebar capsule, above the list (e.g. a search box). */
    top?: Gtk.Widget
    width?: number
    /**
     * The content pane's CONSTANT width (see WINDOW_LAYOUT). It is not a hint: it
     * sets the sidebar's breakpoint and the width the window opens at, and the
     * caller is expected to clamp its pages to the same number.
     */
    contentWidth?: number
}

export interface NidaraWindowHeaderSlots {
    /**
     * The leading row. An ARRAY because a header start is a row of things — a nav
     * capsule and a breadcrumb sit in ONE spacing-8 box, and wrapping them in a
     * second one would double the gap. With a sidebar, the toggle button is
     * prepended to whatever is here.
     */
    start?: Gtk.Widget | Gtk.Widget[]
    center?: Gtk.Widget
    /** Conventionally the close button (`NidaraCircleButton`). */
    end?: Gtk.Widget
    cssClasses?: string[]
}

export interface NidaraWindowOpts {
    app: any
    title: string
    /** The main content (the caller swaps its children). */
    content: Gtk.Widget
    /**
     * Give it a sidebar, or do not. **This is an option, not a different kind of
     * window** — see the note on `NidaraWindow` below.
     */
    sidebar?: NidaraWindowSidebar
    header?: NidaraWindowHeaderSlots
    /** Pinned below everything — a wizard's Back/Continue row. Spans the card,
     *  under the sidebar and the content alike. */
    footer?: Gtk.Widget

    /** Hide or destroy on close. Default `"destroy"`; Settings wants `"hide"`. */
    closeMode?: NidaraCloseMode
    /** Return `true` to REFUSE the close. See NidaraAppWindow. */
    onClose?: () => boolean | void
    closeOnEscape?: boolean
    resizable?: boolean

    /** Only a floor for the OPENING size — with a sidebar, the window still opens
     *  at least wide enough to dock it. The window's MINIMUM is the distress width. */
    defaultWidth?: number
    defaultHeight?: number
    /** Overrides the distress floor. Rarely wanted with a sidebar. */
    minWidth?: number
    minHeight?: number

    cssClasses?: string[]
    /** Extra classes beside `nidara-window-glass` on the card. */
    glassClasses?: string[]
    /** Gtk.Window name (for #id CSS / Hyprland matching). */
    name?: string
    /**
     * The Wayland app-id this window declares for ITSELF, instead of inheriting
     * the process-wide one. A real application window is one the compositor should
     * file as one — see `ui/lib/app-id.ts`.
     */
    appId?: string
    // No tooltip opt for the toggle ON PURPOSE — native GTK tooltips are
    // unthemeable. Attach the glass tooltip to the returned `sidebarToggle`.
}

export interface NidaraWindowResult {
    window: Gtk.Window
    /** The glass card. */
    glass: Gtk.Box
    /** Show, or hide if already visible. */
    toggle: () => void
    /** Run the close policy — what a close button should call. */
    close: () => void
    /** Only when a `sidebar` was given. */
    splitView?: NidaraSplitViewResult
    /** Only when a `sidebar` was given. */
    sidebarToggle?: Gtk.Button
}

/**
 * NidaraWindow — the ONE window in this desktop, sidebar optional.
 *
 * Undecorated glass card, a draggable header, one close path, its own app-id;
 * and, if you pass a `sidebar`, a full-height capsule beside the content with the
 * split view and the breakpoint that docks it.
 *
 * ⚠️ **The sidebar is an OPTION, not a second component, and that was learned the
 * hard way (2026-08-26).** For one afternoon there were two exported names — a
 * base and a sidebar version — and the split looked principled because the two
 * layouts really are different (with a sidebar the header sits over the CONTENT,
 * beside a full-height capsule; without one it crosses the whole card). But
 * "does this app have a sidebar" is a per-app choice, not a per-class one —
 * Finder and System Settings differ on it, and the installer will want a step
 * list the day it stops being a two-button wizard. With two names, adding a
 * sidebar meant migrating a window to a different component; with one, it is
 * filling in an object. The base still exists — `app-window.ts`, which builds the
 * toplevel, the glass and the close policy — but it is INTERNAL. There is one
 * name to choose.
 *
 * The header placement is DERIVED, not an option: a sidebar means the header goes
 * over the content pane, because a full-height capsule is what that layout is. If
 * a real case ever wants Finder's spanning toolbar with a sidebar, add the axis
 * then — a parameter nobody uses today is a third way for two windows to drift.
 */
export function NidaraWindow(opts: NidaraWindowOpts): NidaraWindowResult {
    const {
        app, title, content, sidebar, header, footer,
        closeMode, onClose, closeOnEscape, resizable,
        defaultWidth, defaultHeight, minWidth, minHeight,
        cssClasses = [], glassClasses = [], name, appId,
    } = opts

    const headerStartWidgets = (): Gtk.Widget[] => {
        const st = header?.start
        return st ? (Array.isArray(st) ? st : [st]) : []
    }

    // ── No sidebar: the header crosses the card, and the base is the whole thing ──
    if (!sidebar) {
        const start = headerStartWidgets()
        let startWidget: Gtk.Widget | undefined
        if (start.length === 1) {
            startWidget = start[0]
        } else if (start.length > 1) {
            const row = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, css_classes: ["nidara-window-tools"] })
            for (const w of start) row.append(w)
            startWidget = row
        }
        const base = NidaraAppWindow({
            app, title, content, footer,
            header: header && {
                start: startWidget, center: header.center, end: header.end,
                cssClasses: header.cssClasses,
            },
            closeMode, onClose, closeOnEscape, resizable,
            defaultWidth, defaultHeight, minWidth, minHeight,
            cssClasses, glassClasses, name, appId,
        })
        return { window: base.window, glass: base.glass, toggle: base.toggle, close: base.close }
    }

    // ── With a sidebar ────────────────────────────────────────────────────────
    const sidebarWidth = sidebar.width ?? WINDOW_LAYOUT.sidebar
    const contentWidth = sidebar.contentWidth ?? WINDOW_LAYOUT.content

    // The window opens WIDE ENOUGH TO BE ITSELF: sidebar docked and the pane at its
    // full width. A default below the breakpoint would greet every user with the
    // narrow (floating-sidebar) layout, which is the fallback, not the design.
    const minFloorWidth = minWindowWidthFor(WINDOW_LAYOUT.contentFloor)
    const openWidth = Math.max(defaultWidth ?? 0, collapseAtFor(sidebarWidth, contentWidth) + 48)

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
        child: sidebar.widget,
        reserveLane: false,
        // Flush with the capsule's rounded bottom, so the pill stops short of it.
        cornerRadius: NIDARA_CARD_RADIUS,
        cssClasses: ["nidara-window-sidebar-scroll"],
    })
    sidebarScroll.vexpand = true
    sidebarScrollWidget.vexpand = true
    // Gap to the search slot above (when present).
    sidebarScrollWidget.margin_top = sidebar.top ? 4 : 0

    const sidebarColumn = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["nidara-sidebar-capsule"],
        vexpand: true,
    })
    // Optional search box pinned above the navigation list.
    if (sidebar.top) {
        const topSlot = new Gtk.Box({ css_classes: ["nidara-sidebar-top"] })
        topSlot.append(sidebar.top)
        sidebarColumn.append(topSlot)
    }
    sidebarColumn.append(sidebarScrollWidget)

    // ── Sidebar toggle ────────────────────────────────────────────────────────
    const sidebarToggle = new Gtk.Button({
        child: new Gtk.Image({ gicon: sidebar.toggleIcon, pixel_size: 16, css_classes: ["nd-icon"] }),
        css_classes: ["nidara-icon-btn", "sidebar-toggle"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
    })

    // ── Header over the CONTENT (draggable) ───────────────────────────────────
    // Not across the card: the sidebar capsule is full height, so a header spanning
    // the window would cross it. The toggle leads the row permanently (no
    // reparenting) — it stays reachable whether the sidebar is docked, collapsed or
    // hidden — and the caller's own widgets follow it in the same spacing-8 box.
    const headerStart = new Gtk.Box({
        spacing: 8,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
        css_classes: ["nidara-window-tools"],
    })
    headerStart.append(sidebarToggle)
    for (const w of headerStartWidgets()) headerStart.append(w)

    const contentHeader = new Gtk.CenterBox({
        css_classes: ["nidara-window-header", ...(header?.cssClasses ?? [])],
    })
    contentHeader.set_start_widget(headerStart)
    if (header?.center) contentHeader.set_center_widget(header.center)
    if (header?.end) contentHeader.set_end_widget(header.end)

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

    // No `header` passed to the base: this layout's header is inside the content
    // column above, which is the one thing the sidebar changes about the chrome.
    const base = NidaraAppWindow({
        app, title, content: splitView.widget, footer,
        closeMode, onClose, closeOnEscape, resizable,
        defaultWidth: openWidth,
        // 760 is the SIDEBAR layout's default, not every window's: a two-pane
        // window that opens short looks broken, while About is 429 tall because
        // that is its content. Defaulting it for everyone made About 760 the first
        // time this component was unified (caught on screen, 2026-08-26).
        defaultHeight: defaultHeight ?? 760,
        minWidth: minWidth ?? minFloorWidth,
        minHeight: minHeight ?? WINDOW_LAYOUT.minHeight,
        cssClasses, glassClasses, name, appId,
    })
    base.glass.set_name("nidara-window-glass")

    return {
        window: base.window,
        glass: base.glass,
        toggle: base.toggle,
        close: base.close,
        splitView,
        sidebarToggle,
    }
}
