// CRYSTAL UI - gi module declarations
// These satisfy imports like "gi://..."

declare module "gi://AstalHyprland" { const v: any; export default v; }
declare module "gi://AstalApps" { const v: any; export default v; }
declare module "gi://AstalNotifd" { const v: any; export default v; }
declare module "gi://AstalMpris" { const v: any; export default v; }
declare module "gi://AstalNetwork" { const v: any; export default v; }
declare module "gi://AstalBluetooth" { const v: any; export default v; }
declare module "gi://AstalTray" { const v: any; export default v; }
declare module "gi://AstalWp" { const v: any; export default v; }
declare module "gi://AstalBattery" { const v: any; export default v; }
declare module "gi://AstalAuth" { const v: any; export default v; }
declare module "gi://GLib" { const v: any; export default v; }
declare module "gi://GObject" { const v: any; export default v; }
declare module "gi://Gio" { const v: any; export default v; }
declare module "gi://cairo" { const v: any; export default v; }
declare module "gi://GdkPixbuf" { const v: any; export default v; }
declare module "gi://Gtk4LayerShell" { const v: any; export default v; }

declare module "ags/gtk4" {
    export const Astal: any;
    export const App: any;
    export const Gtk: any;
    export const Gdk: any;
}

declare module "ags" {
    export const For: any;
    export const With: any;
    export const createBinding: any;
}

declare module "ags/gtk4/jsx-runtime" {
    export const astal: any;
    export const Fragment: any;
    export const jsx: any;
    export const jsxs: any;
}

declare module "ags/time" { export const createPoll: any; }
declare module "ags/process" { export const execAsync: any; }
declare module "ags/gtk4/app" { const v: any; export default v; }
