import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import AstalHyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import { getWordmark } from "../../utils"
import SquircleContainer from "../../common/SquircleContainer"
import { CAPSULE_BORDER } from "./capsule"
import hs from "../../core/HyprlandState"
import status from "../../core/Status"
import { safeDisconnect } from "../../core/signals"
import shellActions from "../../core/ShellActions"
import buildWindowMenu from "./WindowMenu"

// openMenu: opens arbitrary content in the bar's shared expansion capsule,
// anchored under the given widget. Injected by Bar (same pattern as Tray).
type OpenMenu = (anchor: Gtk.Widget, build: (onClose: () => void) => Gtk.Widget, align?: "center" | "start") => void

// Bar-left capsule showing the focused window's app name (wordmark), kept in
// sync with Hyprland's focused client and its title changes. Clicking it (any
// button) opens the window-options menu (WindowMenu.ts).
export function AppTitle(monitorWidth: number, openMenu?: OpenMenu): Gtk.Widget {
  // Max label width = half monitor - center capsule est. (100px) - icon capsule + gap overhead (~100px)
  const labelMaxChars = Math.max(15, Math.floor((monitorWidth / 2 - 200) / 8))
  const appName = new Gtk.Label({
    label: "—",
    css_classes: ["bar-app-name"],
    ellipsize: Pango.EllipsizeMode.END,
    max_width_chars: labelMaxChars,
    margin_start: 16,
    margin_end: 16,
  })

  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    let trackedClient: AstalHyprland.Client | null = null
    let titleHandlerId = 0

    const sync = () => {
      const client = hs.focusedClient
      const label = getWordmark(client, hs.focusedWorkspace)
      if (label && label !== appName.label) appName.label = label

      // Only rewire notify::title when the focused client actually changed
      if (client === trackedClient) return
      if (trackedClient && titleHandlerId) {
        safeDisconnect(trackedClient, titleHandlerId)
        titleHandlerId = 0
      }
      trackedClient = client
      if (client) {
        titleHandlerId = client.connect("notify::title", sync)
      }
    }

    hs.connect("changed", sync)
    sync()
    return GLib.SOURCE_REMOVE
  })

  const capsule = SquircleContainer({ child: appName, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })

  if (openMenu) {
    let menuOpen = false
    // The open path, shared by the click gesture and the IPC hook.
    const openWindowMenu = () => {
      if (status.cc_open) return   // same guard as the other bar capsules
      menuOpen = true
      // Left-align the menu with the capsule's left edge: it sits near the left
      // screen edge, so a centered panel would spill off the left.
      openMenu(capsule, (onClose) => buildWindowMenu(() => { menuOpen = false; onClose() }), "start")
    }
    const gesture = new Gtk.GestureClick()
    gesture.set_button(0)   // 0 = any button: left and right click both open
    gesture.connect("released", () => {
      if (status.cc_open) return
      // Light toggle: a second click while our menu is up closes it. "__custom"
      // is the bar's shared transient-expansion id; outside-click dismissal
      // resets it, so a stale menuOpen just falls through to re-open.
      if (menuOpen && status.bar_expanded_id === "__custom") {
        menuOpen = false
        status.bar_expanded_id = ""
        return
      }
      openWindowMenu()
    })
    capsule.add_controller(gesture)
    // Deterministic interaction hook for verification/automation: open the menu
    // without a synthetic click, then assert with `queryUI .nidara-menu-label`.
    // Last bar wins on multi-monitor — fine, the menu is global (focused window).
    shellActions.openWindowMenu = openWindowMenu
  }

  return capsule
}

export default AppTitle
