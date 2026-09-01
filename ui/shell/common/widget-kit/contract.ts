// The widget contract — what a widget IS, never where it is drawn.
//
// This lived in surfaces/control-center/Types.ts, which made the Control Centre the
// owner of a vocabulary the bar speaks too: every widget had to import a surface to
// declare itself. It is the kit's now. Nothing here may reference a surface, and the
// whole of common/widget-kit/ MUST stay leaf modules (see panel.ts for the cycle that
// crashes the shell at boot if it doesn't).

import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"

export type WidgetLocation = "bar" | "cc"

// Coarse grouping that drives BOTH the curated bar order (system rightmost, nearest
// the tray) and the Settings → Widgets section grouping. Single source
// of truth: each widget declares its category; BAR_ORDER and the Settings sections are
// derived from it (see widgets/index.ts CATEGORY_ORDER), never hand-maintained.
export type WidgetCategory = "system" | "utilities" | "media"

export enum WidgetSize {
    SINGLE = "1x1",
    WIDE = "2x1",
    TALL = "1x2",
    SQUARE = "2x2",
    FULL_WIDTH = "4x1"
}

// What the host guarantees a tile's content at a given size. This is the WHOLE of
// what a widget is allowed to know about the surface drawing it: it receives its
// room, it never derives it. The host's own constants (the CC's UNIT/GAP, the
// island's padding) live with the host — see CCLayoutManager — and can move without
// a widget noticing, which is the point of handing these over instead.
export interface ContentBudget {
    /** inner width in px — the tile's span minus the island's padding */
    width: number
    /** inner height in px — same, vertically */
    height: number
    /** Distance in px between two of the host's repeating slots (the CC's cell
     *  pitch). For a widget that draws SEVERAL things of its own and wants them to
     *  land on the host's rhythm rather than bunched in the middle — cpu-memory
     *  spaces its CPU and RAM rings one pitch apart so each sits where a 1×1
     *  widget's icon would. Space repeated content by `pitch - <content width>`;
     *  do NOT reconstruct it from cell arithmetic. */
    pitch: number
}

export interface AtomicWidget {
    id: string
    name: string
    icon?: Gio.FileIcon                 // icon for Settings UI
    category: WidgetCategory            // drives bar order + Settings grouping (see WidgetCategory)
    barOrder?: number                   // optional intra-category fine-tune (lower = further left). Default 0.
    locations?: WidgetLocation[]        // where this widget can appear
    defaultInBar?: boolean              // shown in the bar by default (default false)
    defaultInCc?: boolean               // seeded into the CC by default (default = "cc" in locations)
    defaultSize: WidgetSize
    supportedSizes: WidgetSize[]
    // Widgets that don't size anything can keep a one-arg signature.
    buildContent: (size: WidgetSize, budget: ContentBudget) => Gtk.Widget
    centerContent?: boolean             // center the WIDE (2×1) content instead of the
                                        // default left-anchored capsule layout (icon+label)
    buildBarContent?: () => Gtk.Widget                      // compact bar variant (icon only)
    buildBarExpanded?: (onClose: () => void) => Gtk.Widget  // bar inline expansion panel
    /** The expansion panel handles its OWN horizontal insets, so the bar drops the
     *  14px it normally gives every panel. For content that must reach the panel's
     *  inner edge — a scroll view, whose bar sits at that edge by the shell-wide
     *  rule (design-system.md, "Any ScrolledWindow"). The widget then owes its own
     *  content the inset the panel used to provide. */
    barExpandedFlush?: boolean
    // Intercept a click on the bar pill. Return true = handled, the expansion
    // panel does NOT open; false = fall through to the normal behaviour. Consulted
    // on every click (not once at build time), so it can answer differently as the
    // widget's state changes — screenrecord uses it to make the pill a one-click
    // Stop while a capture is live. Keep it for actions that are unambiguous in
    // that state; anything needing a choice belongs in the panel.
    barClick?: () => boolean
    buildCCDetail?: (onClose: () => void) => Gtk.Widget     // CC full-panel detail (no inner scroll)
    ccDetailRows?: number                                   // squircle height in grid rows (default 2)
    // Per-widget settings page. When present, the Settings → Widgets card shows a
    // "Configure" row that pushes this as a subpage. Keep the widget's own options
    // co-located with the widget (the "mini-app" contract). Omit if it has none.
    buildSettings?: () => Gtk.Widget
    // Hardware gate. When it returns false the widget does not exist for the user:
    // hidden from the bar and the CC, disabled (with a hint) in Settings → Widgets.
    // Omit for widgets with no hardware dependency (= always available). User
    // placement config is NOT touched by availability, so the widget comes back
    // when the hardware does.
    isAvailable?: () => boolean
    // Optional companion: invoke cb whenever availability may have changed (e.g.
    // BT adapter plugged/removed). Subscriptions are shell-lifetime — no dispose.
    watchAvailable?: (cb: () => void) => void
    // On/off state for CC tiles: while true, the WHOLE island fills with the live
    // accent colour (standard quick-settings convention) instead of the
    // base glass — see BaseIsland/SquircleContainer's getActive/watchActive. Omit
    // for widgets with no persistent on/off state (screenshot, clipboard, media…).
    getActive?: () => boolean
    watchActive?: (cb: () => void) => (() => void)
    // Fractional variant of getActive for gauge-style tiles (CC sliders: volume,
    // brightness) — fills that fraction (0..1) of the island from the bottom with
    // accent, same single shape/border as getActive. Size-aware (receives the
    // widget's current WidgetSize) because a slider widget's OTHER sizes (its 1×1
    // icon, its 4×1 horizontal bar) aren't gauges and must return 0 for those, or
    // the whole island fills unexpectedly at that size too. Shares watchActive.
    getFill?: (size: WidgetSize) => number
    // Override which colour getActive/getFill fills with — a hex string, live
    // theme accent if omitted. Set for a FIXED semantic colour that must not move
    // with the user's accent choice (screenrecord: DANGER_HEX, same red as every
    // other "needs attention" indicator — see lib/status-colors.ts).
    activeColorHex?: string
    // Static alpha, or a getter for a live-varying one (a pulsing indicator reads
    // it every redraw — pair with a watchActive that ticks a redraw timer while
    // active, e.g. screenrecord). Default 0.85 if omitted.
    activeAlpha?: number | (() => number)
}

// The content-building subset of a widget, produced by the kit's spec factories
// (tile.ts's roundToggleSpec) and by the two CC factories still to move
// (Sliders/MediaIsland). The registry widgets (widgets/*.ts) own the metadata
// (category, sizes, placement) and delegate only buildContent to these factories, so
// a spec carries no category — keeping `category` mandatory on real widgets without
// forcing the factories to fake one.
export type CCWidgetSpec = Omit<AtomicWidget, "category">
