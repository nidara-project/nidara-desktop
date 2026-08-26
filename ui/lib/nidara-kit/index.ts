/**
 * Nidara UI — GTK4 primitive widget library for Nidara
 *
 * All components use pure GTK4 primitives + Nidara CSS tokens.
 * No Adwaita. No resets needed.
 *
 * Usage: import { NidaraRow, NidaraScrolled } from "../../lib/nidara-kit"
 */

// (NidaraSelect and NidaraOverlayManager were deleted 2026-08-03. The select was an
// in-window overlay list; Settings moved to NidaraDropDown below because a real popover
// is a separate Wayland surface and therefore gets compositor blur, which an overlay
// cannot. The manager existed only to float that list, and went with it.)

// NidaraClamp — max-width centering container (replaces Adw.Clamp)
export { NidaraClamp } from "./clamp"

// NidaraScrolled — scroll view whose indicator can never take a click (replaces
// Gtk.ScrolledWindow wherever rows carry a control at their right edge)
export type { NidaraScrolledOpts, NidaraScrolledResult } from "./scrolled"
export { NidaraScrolled } from "./scrolled"

// NidaraDropDown — Gtk.DropDown whose popup list carries the same bar. The native
// dropdown stays (its popover is a real Wayland popup, so it gets compositor blur);
// what goes is GTK's scrollbar inside it. attachScrollBar/adoptGtkScrolled are the
// same machinery for any other view GTK builds for us.
export { NidaraDropDown, attachScrollBar, adoptGtkScrolled } from "./scrolled"

// NidaraSplitView — sidebar+content with auto-collapse (replaces Adw.OverlaySplitView + Adw.Breakpoint)
export type { NidaraSplitViewResult } from "./split-view"
export { NidaraSplitView } from "./split-view"

// NidaraButton — unified button component (replaces suggested-action / destructive-action / pill)
export type { NidaraButtonVariant, NidaraButtonOpts } from "./button"
export { NidaraButton } from "./button"

// NidaraCircleButton — the round glass icon button (close/remove/collapse). Moved
// here from the shell's common/IconButton.ts on 2026-08-26, with its CSS; that file
// is now a wrapper adding the shell-only tooltip and capture-click.
export type { NidaraCircleVariant, NidaraCircleButtonOpts } from "./button"
export { NidaraCircleButton } from "./button"

// NidaraFontButton — pill font picker (replaces Gtk.FontButton)
export type { NidaraFontButtonOpts } from "./fontbutton"
export { NidaraFontButton } from "./fontbutton"

// NidaraRow / NidaraList — universal list row + boxed list card (the one place
// a row/list is built; used by Settings, Control Center and any future surface)
export { NidaraRow, NidaraStackedRow, NidaraEmptyRow, ROW_H_SINGLE, ROW_H_DOUBLE } from "./row"
export type { NidaraRowResult } from "./row"
export { NidaraList } from "./list"
export type { NidaraListResult } from "./list"

// NidaraSidebar — universal navigation list (icon+label rows, single-select)
export { NidaraSidebar } from "./sidebar"
export type { NidaraSidebarItem, NidaraSidebarResult } from "./sidebar"

// NidaraWindow — THE window of this desktop: undecorated glass card, draggable
// header, one close path, its own app-id, and a sidebar + split view IF you pass
// one. The sidebar is an option, not a second component — see the note on the
// function. `app-window.ts` is the layer underneath and is deliberately not
// exported: there is one name to choose.
export { NidaraWindow, NIDARA_WINDOW_RADIUS, NIDARA_CARD_RADIUS } from "./window"
export type {
  NidaraWindowOpts, NidaraWindowResult, NidaraWindowSidebar, NidaraWindowHeaderSlots,
} from "./window"
export type { NidaraCloseMode } from "./app-window"

// makeSlider — the ONE slider (Cairo, horizontal/vertical; there is no Gtk.Scale
// anywhere in Nidara). makeHSlider is the horizontal wrapper, makeVolumeSlider binds
// one to an audio endpoint, makeVerticalFillTile is the 1×2 CC gauge tile.
export type { SliderOpts, SliderOrientation } from "./slider"
export { makeSlider, makeHSlider, makeVerticalFillTile, makeVolumeSlider } from "./slider"

// The appearance seam the slider paints through — every BUNDLE registers its own
// source once, in app.ts. Cairo cannot read CSS tokens, so the accent and the
// surface's mode have to be handed to the kit. See appearance.ts.
export type { KitAppearance } from "./appearance"
export { setKitAppearance, kitAppearance } from "./appearance"

// The COMPOSED rows — "label + subtitle + the control that edits it", which is what a
// preferences pane is made of. They take the row BUILDER as a parameter (`mkRow`,
// default `plainRow`) so that composing a row and registering it somewhere are two
// different jobs: Settings passes its own `createRow`, everyone else does not. See
// rows.ts for why that is a parameter and not a module-level seam.
export type { NidaraRowBuilder, NidaraSliderRowOpts } from "./rows"
export { NidaraToggleRow, NidaraDropDownRow, NidaraSliderRow, plainRow } from "./rows"

// bindWhileRealized — bind a subscription to a widget's REALIZED lifetime, not to a
// one-shot unrealize. Required by anything that caches widgets instead of rebuilding
// them; the composed rows re-arm their external sync through it.
export { bindWhileRealized } from "./lifetime"

// showNidaraAlert — modal confirmation dialog (replaces Adw.AlertDialog)
export type { AlertResponse, AlertHandle } from "./alert-dialog"
export { showNidaraAlert } from "./alert-dialog"

// showNidaraFormDialog — modal form dialog with floating glass styling
export type { FormResponse, FormDialogHandle, NidaraFormDialogOpts } from "./form-dialog"
export { showNidaraFormDialog } from "./form-dialog"

