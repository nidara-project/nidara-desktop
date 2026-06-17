/**
 * Nidara UI — GTK4 primitive widget library for Nidara
 *
 * All components use pure GTK4 primitives + Nidara CSS tokens.
 * No Adwaita. No resets needed.
 *
 * Usage: import { NidaraSelect, NidaraOverlayManager } from "../../lib/nidara-kit"
 */

// Overlay manager — for future floating UI (tooltips, context menus, etc.)
export { NidaraOverlayManager } from "./overlay-manager"

// NidaraSelect — dropdown, no manager needed (uses Gtk.Popover)
export type { SelectOption, NidaraSelectResult } from "./select"
export { NidaraSelect } from "./select"

// NidaraClamp — max-width centering container (replaces Adw.Clamp)
export { NidaraClamp } from "./clamp"

// NidaraSplitView — sidebar+content with auto-collapse (replaces Adw.OverlaySplitView + Adw.Breakpoint)
export type { NidaraSplitViewResult } from "./split-view"
export { NidaraSplitView } from "./split-view"

// NidaraButton — unified button component (replaces suggested-action / destructive-action / pill)
export type { NidaraButtonVariant, NidaraButtonOpts } from "./button"
export { NidaraButton } from "./button"

// NidaraFontButton — pill font picker (replaces Gtk.FontButton)
export type { NidaraFontButtonOpts } from "./fontbutton"
export { NidaraFontButton } from "./fontbutton"

// NidaraRow / NidaraList — universal list row + boxed list card (the one place
// a row/list is built; used by Settings, Control Center and any future surface)
export { NidaraRow } from "./row"
export type { NidaraRowResult } from "./row"
export { NidaraList } from "./list"
export type { NidaraListResult } from "./list"

// NidaraSidebar — universal navigation list (icon+label rows, single-select)
export { NidaraSidebar } from "./sidebar"
export type { NidaraSidebarItem, NidaraSidebarResult } from "./sidebar"

// NidaraWindow — settings-style window shell (glass + split + reparenting header)
export { NidaraWindow } from "./window"
export type { NidaraWindowOpts, NidaraWindowResult } from "./window"

// showNidaraAlert — modal confirmation dialog (replaces Adw.AlertDialog)
export type { AlertResponse, AlertHandle } from "./alert-dialog"
export { showNidaraAlert } from "./alert-dialog"
