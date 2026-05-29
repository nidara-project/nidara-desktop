import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"

export type WidgetLocation = "bar" | "cc"

export enum WidgetSize {
    SINGLE = "1x1",
    WIDE = "2x1",
    TALL = "1x2",
    SQUARE = "2x2",
    FULL_WIDTH = "4x1"
}

export interface AtomicWidget {
    id: string
    name: string
    icon?: Gio.FileIcon                 // icon for Settings UI
    locations?: WidgetLocation[]        // where this widget can appear
    defaultInBar?: boolean              // shown in the bar by default (default false)
    defaultInCc?: boolean               // seeded into the CC by default (default = "cc" in locations)
    defaultSize: WidgetSize
    supportedSizes: WidgetSize[]
    buildContent: (size: WidgetSize) => Gtk.Widget
    buildBarContent?: () => Gtk.Widget                      // compact bar variant (icon only)
    buildBarExpanded?: (onClose: () => void) => Gtk.Widget  // bar inline expansion panel
    buildCCDetail?: (onClose: () => void) => Gtk.Widget     // CC full-panel detail (no inner scroll)
    ccDetailRows?: number                                   // squircle height in grid rows (default 2)
}
