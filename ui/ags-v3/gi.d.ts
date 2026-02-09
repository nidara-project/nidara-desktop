declare module "gi://AstalHyprland" {
    export namespace AstalHyprland {
        export type Hyprland = any;
        export type Client = any;
    }
    const AstalHyprland: any;
    export default AstalHyprland;
}

declare module "gi://AstalApps" {
    export namespace AstalApps {
        export type Application = any;
    }
    const AstalApps: any;
    export default AstalApps;
}

declare module "gi://GLib" {
    export namespace GLib {
        export const PRIORITY_DEFAULT: any;
        export const PRIORITY_DEFAULT_IDLE: any;
        export const SOURCE_REMOVE: any;
        export const idle_add: any;
    }
    const GLib: any;
    export default GLib;
}

declare module "gi://GObject" {
    export namespace GObject {
        export type Value = any;
        export const TYPE_STRING: any;
    }
    const GObject: any;
    export default GObject;
}

declare module "gi://Gio" {
    export namespace Gio {
        export type Icon = any;
    }
    const Gio: any;
    export default Gio;
}

declare module "gi://cairo" {
    const value: any;
    export default value;
}

declare module "gi://GdkPixbuf" {
    const GdkPixbuf: any;
    export default GdkPixbuf;
}

declare module "gi://Gtk4LayerShell" {
    const value: any;
    export default value;
}

declare module "gi://AstalTray" { export namespace AstalTray { export type Item = any; } const v: any; export default v; }
declare module "gi://AstalWp" { export namespace AstalWp { export type Wp = any; } const v: any; export default v; }
declare module "gi://AstalBattery" { export namespace AstalBattery { export type Device = any; } const v: any; export default v; }
declare module "gi://AstalNetwork" { export namespace AstalNetwork { export type Network = any; } const v: any; export default v; }
declare module "gi://AstalMpris" { export namespace AstalMpris { export type Player = any; } const v: any; export default v; }
declare module "gi://AstalAuth" { const v: any; export default v; }
declare module "gi://AstalBluetooth" { export namespace AstalBluetooth { export type Bluetooth = any; export type Device = any; } const v: any; export default v; }
declare module "gi://AstalNotifd" { export namespace AstalNotifd { export type Notification = any; } const v: any; export default v; }

declare module "ags/gtk4" {
    export const Astal: any;
    export const App: any;
    export const Gtk: any;
    export const Gdk: any;
    export namespace Gtk {
        export type Box = any;
        export type Label = any;
        export type Button = any;
        export type Image = any;
        export type Window = any;
        export type CenterBox = any;
        export type PopoverMenu = any;
        export type Scale = any;
        export type Grid = any;
        export type EventControllerMotion = any;
        export type GestureClick = any;
        export type Popover = any;
        export type Widget = any;
        export type Separator = any;
        export type Overlay = any;
        export type DrawingArea = any;
        export type DropTarget = any;
        export type RevealerTransitionType = any;
    }
    export namespace Gdk {
        export type Monitor = any;
        export type Cursor = any;
    }
}

declare module "ags/time" {
    export const createPoll: any;
}

declare module "ags/process" {
    export const execAsync: any;
}

declare global {
    namespace Gtk {
        export type Box = any;
        export type Label = any;
        export type Button = any;
        export type Image = any;
        export type Window = any;
        export type CenterBox = any;
        export type PopoverMenu = any;
        export type Scale = any;
        export type Grid = any;
        export type EventControllerMotion = any;
        export type GestureClick = any;
        export type Popover = any;
        export type Widget = any;
        export type Separator = any;
        export type Overlay = any;
        export type DrawingArea = any;
        export type DropTarget = any;
        export type RevealerTransitionType = any;
        export type Viewport = any;
        export type Fixed = any;
        export const Align: any;
        export const Orientation: any;
    }
    namespace Gdk {
        export type Monitor = any;
        export type Cursor = any;
    }
    namespace AstalHyprland {
        export type Client = any;
    }
    namespace AstalNotifd {
        export type Notification = any;
    }
    const Gtk: any;
    const Gdk: any;
    const GLib: any;
}
