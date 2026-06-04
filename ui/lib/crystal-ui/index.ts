/**
 * Crystal UI — GTK4 primitive widget library for Crystal Shell
 *
 * All components use pure GTK4 primitives + Crystal CSS tokens.
 * No Adwaita. No resets needed.
 *
 * Usage: import { CrystalSelect, CrystalOverlayManager } from "../../lib/crystal-ui"
 */

// Overlay manager — for future floating UI (tooltips, context menus, etc.)
export { CrystalOverlayManager } from "./overlay-manager"

// CrystalSelect — dropdown, no manager needed (uses Gtk.Popover)
export type { SelectOption, CrystalSelectResult } from "./select"
export { CrystalSelect } from "./select"

// CrystalClamp — max-width centering container (replaces Adw.Clamp)
export { CrystalClamp } from "./clamp"

// CrystalSplitView — sidebar+content with auto-collapse (replaces Adw.OverlaySplitView + Adw.Breakpoint)
export type { CrystalSplitViewResult } from "./split-view"
export { CrystalSplitView } from "./split-view"

// CrystalButton — unified button component (replaces suggested-action / destructive-action / pill)
export type { CrystalButtonVariant, CrystalButtonOpts } from "./button"
export { CrystalButton } from "./button"

// CrystalRow / CrystalList — universal list row + boxed list card (the one place
// a row/list is built; used by Settings, Control Center and any future surface)
export { CrystalRow } from "./row"
export type { CrystalRowResult } from "./row"
export { CrystalList } from "./list"
export type { CrystalListResult } from "./list"

// showCrystalAlert — modal confirmation dialog (replaces Adw.AlertDialog)
export type { AlertResponse } from "./alert-dialog"
export { showCrystalAlert } from "./alert-dialog"
