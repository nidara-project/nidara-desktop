// The `ags/gtk4` barrel re-exports the GI namespaces. ags is the system package
// (symlinked into node_modules from /usr/local/share/ags — NOT an npm dependency),
// so it ships no .d.ts. Re-export the real @girs types here: gives full editor
// types AND a typecheck that doesn't need the system ags present (so CI works).
declare module "ags/gtk4" {
    // Re-export the NAMED namespaces (not the default) so they work as
    // type-namespaces too (e.g. `Gtk.Box` in a type position), not just values.
    export { Gtk } from "gi://Gtk?version=4.0";
    export { Gdk } from "gi://Gdk?version=4.0";
    export { Astal } from "gi://Astal?version=4.0";
}

declare module "ags/gtk4/app" {
    const value: any;
    export default value;
}


declare module "ags/file" {
    export const writeFile: any;
    export const readFile: any;
}

declare module "ags/process" {
    export const execAsync: any;
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
