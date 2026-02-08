declare module "ags/gtk4/app" {
    const value: any;
    export default value;
}

declare module "ags/gtk4" {
    export namespace Gtk {
        export type Widget = any;
        export type Box = any;
        export type CenterBox = any;
        export type Label = any;
        export type Popover = any;
        export type Image = any;
        export type Overlay = any;
        export type DrawingArea = any;
        export type DropTarget = any;
        export type EventControllerMotion = any;
        export type GestureClick = any;
        export type Button = any;
        export type Separator = any;
        export type WidgetPaintable = any;
        export type TextDirection = any;
        export type IconTheme = any;
        export type IconLookupFlags = any;
        export type PositionType = any;
        export type Align = any;
        export type Overflow = any;
        export type Orientation = any;
    }
    export namespace Gdk {
        export type Display = any;
        export type Cursor = any;
        export type DragAction = any;
        export type ContentProvider = any;
        export const DragAction: any;
        export const Cursor: any;
        export const Display: any;
        export const cairo_set_source_pixbuf: any;
    }
    export const Astal: any;
    export const Gtk: any;
    export const Gdk: any;
}

declare module "ags/file" {
    export const writeFile: any;
    export const readFile: any;
}

declare module "ags/process" {
    export const execAsync: any;
}

declare module "ags/gtk4/jsx-runtime" {
    export const astal: any;
}
