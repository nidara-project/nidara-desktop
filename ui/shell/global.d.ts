// NIDARA UI - Global Ambient Types
// No imports or exports here to maintain global script status.

namespace AstalHyprland {
    export type Hyprland = any;
    export type Client = any;
}
namespace AstalApps {
    export type Application = any;
}
namespace AstalNotifd {
    export type Notification = any;
}
namespace AstalMpris {
    export type Player = any;
    export enum PlaybackStatus {
        PLAYING,
        PAUSED,
        STOPPED
    }
}
namespace AstalNetwork {
    export type Network = any;
}
namespace AstalBluetooth {
    export type Bluetooth = any;
    export type Device = any;
}
namespace AstalTray {
    export type Item = any;
}
namespace AstalWp {
    export type Wp = any;
}
namespace AstalBattery {
    export type Device = any;
}
namespace Astal {
    export type Window = any;
    export const WindowAnchor: any;
}
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
    export type Orientation = any;
    export type Align = any;
    export type PolicyType = any;
    export const Align: any;
    export const Orientation: any;
    export const PolicyType: any;
}
namespace Gdk {
    export type Monitor = any;
    export type Cursor = any;
    export type Display = any;
}
namespace GLib {
    export const PRIORITY_DEFAULT: any;
    export const idle_add: any;
}

declare const Gtk: any;
declare const Gdk: any;
declare const GLib: any;
declare const Astal: any;
