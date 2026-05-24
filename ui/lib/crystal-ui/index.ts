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
