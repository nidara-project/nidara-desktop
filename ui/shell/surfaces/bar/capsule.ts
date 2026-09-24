import status from "../../core/Status"

// Shared bar-capsule edge: a faint white inner border at rest. On hover the
// capsules pass hoverBorderAccent, which repaints this border with the current
// accent at full opacity. Used by Bar, Workspaces and AppTitle.
export const CAPSULE_BORDER = { r: 1, g: 1, b: 1, a: 0.2 }

// Whether a panel that drops from the bar is open — its own expansion panel (a
// widget's, a tray menu), or the CC / NC / system menu, which all sit under the
// bar's right and left ends. The bar's tooltips stay away while one is: the dock's
// rule (no tooltip while its menu is open), because a bubble dropping from a bar
// capsule lands on exactly the panel that capsule just opened.
export const barPanelOpen = () =>
    status.bar_expanded_id !== "" || status.cc_open || status.nc_open || status.system_menu_open
