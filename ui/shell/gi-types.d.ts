// Bridge GI namespaces used as TYPE annotations (e.g. `Gio.File`, `GLib.DateTime`,
// `AstalHyprland.Workspace`) into the global scope with their REAL @girs types.
//
// Why this is needed: the GI default imports (`import Gio from "gi://Gio"`) provide
// the namespace as a VALUE under this @girs setup, but TypeScript doesn't treat that
// binding as a type-namespace, so `Gio.File` in a type position fails to resolve.
// We alias from the versioned modules so these stay FULLY TYPED (not `any`).
//
// If a new `Namespace.Type` is used as an annotation and tsc reports
// "Cannot find namespace" / "has no exported member", add the member here.

import type * as GioMod from "gi://Gio?version=2.0";
import type * as GLibMod from "gi://GLib?version=2.0";
import type * as GdkPixbufMod from "gi://GdkPixbuf?version=2.0";
import type * as HyprMod from "gi://AstalHyprland?version=0.1";

declare global {
  namespace Gio {
    export type File = GioMod.Gio.File;
    export type FileIcon = GioMod.Gio.FileIcon;
    export type FileMonitor = GioMod.Gio.FileMonitor;
    export type FileQueryInfoFlags = GioMod.Gio.FileQueryInfoFlags;
    export type FileType = GioMod.Gio.FileType;
    export type AppInfo = GioMod.Gio.AppInfo;
    export type Subprocess = GioMod.Gio.Subprocess;
    export type SubprocessFlags = GioMod.Gio.SubprocessFlags;
    export type Menu = GioMod.Gio.Menu;
    export type ListStore = GioMod.Gio.ListStore;
    export type ThemedIcon = GioMod.Gio.ThemedIcon;
  }

  namespace GLib {
    export type DateTime = GLibMod.GLib.DateTime;
    export type Variant = GLibMod.GLib.Variant;
    export type VariantType = GLibMod.GLib.VariantType;
  }

  namespace GdkPixbuf {
    export type Pixbuf = GdkPixbufMod.GdkPixbuf.Pixbuf;
    export type InterpType = GdkPixbufMod.GdkPixbuf.InterpType;
  }

  namespace AstalHyprland {
    export type Workspace = HyprMod.AstalHyprland.Workspace;
    export type Monitor = HyprMod.AstalHyprland.Monitor;
    export type Client = HyprMod.AstalHyprland.Client;
    export type Hyprland = HyprMod.AstalHyprland.Hyprland;
  }
}
