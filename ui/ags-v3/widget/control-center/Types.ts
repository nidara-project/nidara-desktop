import { Gtk } from "ags/gtk4"

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
    icon?: string                       // icon name for Settings UI
    locations?: WidgetLocation[]        // where this widget can appear
    defaultSize: WidgetSize
    supportedSizes: WidgetSize[]
    buildContent: (size: WidgetSize) => Gtk.Widget
    buildBarContent?: () => Gtk.Widget  // compact bar variant
}
