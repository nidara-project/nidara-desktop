declare module "gi://AstalGreet" { const v: any; export default v; }
declare module "gi://GLib"        { const v: any; export default v; }
declare module "gi://GObject"     { const v: any; export default v; }
declare module "gi://Gio"         { const v: any; export default v; }
declare module "gi://Adw?version=1" { const v: any; export default v; }
declare module "gi://Gtk4LayerShell" { const v: any; export default v; }
declare module "gi://GdkPixbuf"   { const v: any; export default v; }

declare module "ags/gtk4" {
  export const Gtk: any
  export const Gdk: any
  export const Astal: any
}
declare module "ags/gtk4/app"     { const v: any; export default v; }
declare module "ags/time"         { export const interval: any; export const createPoll: any }
declare module "ags/process"      { export const execAsync: any }
declare module "ags/file"         { export const readFile: any; export const writeFile: any }
