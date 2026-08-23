import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import GLib from "gi://GLib"
import { getWordmark } from "../../utils"
import SquircleContainer, { GLASS_SHADOW } from "../../common/SquircleContainer"
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
export interface AppTitleHandle {
  widget: Gtk.Widget
  /** Re-derive the label's cap after a resolution change. */
  setMonitorWidth: (px: number) => void
  /** Dynamically constrain the label's maximum allocated width in pixels so it never collides with the island. */
  setMaxWidth: (px: number) => void
}

const PAD_PX = 32 // 16px margin_start + 16px margin_end

/**
 * Uses Pango layout to measure the exact rendered width in pixels of the text,
 * finding the maximal substring that fits inside maxPx with an ellipsis.
 */
function fitTextToPixels(widget: Gtk.Widget, text: string, maxPx: number): string {
  if (!text || maxPx <= 0) return ""
  const layout = widget.create_pango_layout(text)
  if (!layout) return text
  const [fullW] = layout.get_pixel_size()
  if (fullW <= maxPx) return text

  const ellipsis = "…"
  let low = 1
  let high = text.length
  let best = text.slice(0, 1) + ellipsis

  while (low <= high) {
    const mid = (low + high) >> 1
    const candidate = text.slice(0, mid) + ellipsis
    layout.set_text(candidate, -1)
    const [w] = layout.get_pixel_size()
    if (w <= maxPx) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

export function AppTitle(monitorWidth: number, openMenu?: OpenMenu): AppTitleHandle {
  let targetBudgetPx = Math.max(100, (monitorWidth / 2) - 200)
  let currentBudgetPx = targetBudgetPx
  let rawTitle = "—"
  let animTickId: number | null = null

  const appName = new Gtk.Label({
    label: "—",
    css_classes: ["bar-app-name"],
    margin_start: 16,
    margin_end: 16,
  })

  const updateLabel = () => {
    const maxTextPx = Math.max(20, currentBudgetPx - PAD_PX)
    const fitted = fitTextToPixels(appName, rawTitle, maxTextPx)
    if (appName.label !== fitted) appName.label = fitted
  }

  const capsule = SquircleContainer({ child: appName, gloss: true, useShellOpacity: true, chrome: true, opacityRole: "bar", shadow: GLASS_SHADOW, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })

  const startBudgetAnimation = (targetPx: number) => {
    targetBudgetPx = targetPx
    if (Math.abs(currentBudgetPx - targetBudgetPx) < 1) {
      currentBudgetPx = targetBudgetPx
      updateLabel()
      return
    }

    if (animTickId !== null) return

    let lastTimeUs = 0
    animTickId = capsule.add_tick_callback((_, clock) => {
      const now = clock.get_frame_time()
      if (lastTimeUs === 0) {
        lastTimeUs = now
        return GLib.SOURCE_CONTINUE
      }
      const dt = Math.min(0.05, (now - lastTimeUs) / 1_000_000)
      lastTimeUs = now

      const diff = targetBudgetPx - currentBudgetPx
      if (Math.abs(diff) < 1) {
        currentBudgetPx = targetBudgetPx
        updateLabel()
        animTickId = null
        return GLib.SOURCE_REMOVE
      }

      // Smooth exponential approach (~180ms settling)
      currentBudgetPx += diff * (1 - Math.exp(-16 * dt))
      updateLabel()
      return GLib.SOURCE_CONTINUE
    })
  }

  GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    const sync = () => {
      const label = getWordmark(hs.focusedClient, hs.focusedWorkspace) || "—"
      if (label !== rawTitle) {
        rawTitle = label
        updateLabel()
      }
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
    setMonitorWidth: (px) => { startBudgetAnimation(Math.max(100, (px / 2) - 200)) },
    setMaxWidth: (px) => { startBudgetAnimation(px) },
  }
}

export default AppTitle
