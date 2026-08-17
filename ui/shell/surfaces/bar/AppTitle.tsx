import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import GLib from "gi://GLib"
import { getWordmark } from "../../utils"
import SquircleContainer from "../../common/SquircleContainer"
import { CAPSULE_BORDER } from "./capsule"
import hs from "../../core/HyprlandState"
import status from "../../core/Status"
import shellActions from "../../core/ShellActions"
import buildWindowMenu from "./WindowMenu"

// openMenu: opens arbitrary content in the bar's shared expansion capsule,
// anchored under the given widget. Injected by Bar (same pattern as Tray).
type OpenMenu = (anchor: Gtk.Widget, build: (onClose: () => void) => Gtk.Widget, align?: "center" | "start") => void

// Bar-left capsule showing the focused window's app name (wordmark), kept in
// sync with Hyprland's focused client and its title changes. Clicking it (any
// button) opens the window-options menu (WindowMenu.ts).
/** The capsule, plus the one number it derives from the monitor. */
export interface AppTitleHandle {
  widget: Gtk.Widget
  /** Re-derive the label's cap after a resolution change. The width arrives as a
   *  CONSTRUCTION argument, which made this the one flavour of the stale-geometry
   *  bug a live `monGeo` does not fix on its own (user-caught 2026-08-10: the
   *  panel opened in the wrong place after switching to 1080p). The chain is
   *  monitor width → max label chars → the capsule's measured width → where the
   *  bar centres the expansion panel under it, so a stale cap moves a panel that
   *  never reads the monitor at all. */
  setMonitorWidth: (px: number) => void
}

export function AppTitle(monitorWidth: number, openMenu?: OpenMenu): AppTitleHandle {
  // Max label width = half monitor - center capsule est. (100px) - icon capsule + gap overhead (~100px)
  const maxCharsFor = (w: number) => Math.max(15, Math.floor((w / 2 - 200) / 8))
  const appName = new Gtk.Label({
    label: "—",
    css_classes: ["bar-app-name"],
    ellipsize: Pango.EllipsizeMode.END,
    max_width_chars: maxCharsFor(monitorWidth),
    margin_start: 16,
    margin_end: 16,
  })

  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    const sync = () => {
      const label = getWordmark(hs.focusedClient, hs.focusedWorkspace)
      if (label && label !== appName.label) appName.label = label
    }

    // TWO signals, because a rename is not a structural change. "changed" fires
    // when the focused window/workspace actually changes; HyprlandState's
    // signature deliberately ignores titles, so a window that merely renames
    // itself — a terminal running a command, a YouTube tab — arrives on
    // "title-changed" instead. That used to be a per-client `notify::title`
    // handler on the AstalHyprland GObject, rewired on every focus change; the
    // compositor announces it as `windowtitlev2` and HyprlandState forwards it,
    // so there is nothing to rewire and nothing to disconnect.
    hs.connect("changed", sync)
    hs.connect("title-changed", sync)
    sync()
    return GLib.SOURCE_REMOVE
  })

  const capsule = SquircleContainer({ child: appName, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })

  if (openMenu) {
    let menuOpen = false
    // The open path, shared by the click gesture and the IPC hook.
    const openWindowMenu = () => {
      if (status.cc_edit_mode) return   // same guard as the other bar capsules
      menuOpen = true
      // Left-align the menu with the capsule's left edge: it sits near the left
      // screen edge, so a centered panel would spill off the left.
      openMenu(capsule, (onClose) => buildWindowMenu(() => { menuOpen = false; onClose() }), "start")
    }
    const gesture = new Gtk.GestureClick()
    gesture.set_button(0)   // 0 = any button: left and right click both open
    gesture.connect("released", () => {
      if (status.cc_edit_mode) return
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

  return {
    widget: capsule,
    setMonitorWidth: (px) => { appName.max_width_chars = maxCharsFor(px) },
  }
}

export default AppTitle
