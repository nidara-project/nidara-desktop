import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"

export type WidgetLocation = "bar" | "cc"

// Coarse grouping that drives BOTH the curated bar order (system rightmost, nearest
// the tray — macOS-style) and the Settings → Widgets section grouping. Single source
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

// Inner space the host guarantees to a tile's content at a given size — the
// cell span minus the island's own padding. Computed by the host (IslandGrid)
// from its layout constants; widgets size their content from THIS, never from
// UNIT/GAP/padding math (host constants can change under you).
export interface ContentBudget {
    width: number
    height: number
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
}

// The content-building subset of a widget, produced by the CC factories in
// Toggles/Sliders/MediaIsland. The registry widgets (widgets/*.ts) own the
// metadata (category, sizes, placement) and delegate only buildContent to these
// factories, so a spec carries no category — keeping `category` mandatory on real
// widgets without forcing the factories to fake one.
export type CCWidgetSpec = Omit<AtomicWidget, "category">
