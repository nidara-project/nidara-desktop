import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import GLib from "gi://GLib"
import { barItem, barOpen, isBarCustomAnchor, setBarItemKey } from "./capsule"
import compositor, { type CompositorWindow, type CompositorWorkspace } from "../../core/CompositorState"
import appService from "../../core/AppService"
import { t } from "../../core/i18n"
import { GAME_WORKSPACE } from "../../core/game-session-logic"
import status from "../../core/Status"
import shellActions from "../../core/ShellActions"
import buildWindowMenu from "./WindowMenu"
import { BAR_TEXT_PAD } from "../../common/widget-kit"

// openMenu: opens arbitrary content in the bar's shared expansion capsule,
// anchored under the given widget. Injected by Bar (same pattern as Tray).
type OpenMenu = (anchor: Gtk.Widget, build: (onClose: () => void) => Gtk.Widget, align?: "center" | "start") => void

// Bar-left item (the left group, beside the system menu) naming the focused window's APP, as
// the app grid names it — never the window's title, which every window carries in its own
// title bar. Clicking it (any button) opens the window-options menu (WindowMenu.ts).
export interface AppTitleHandle {
  widget: Gtk.Widget
  /** Re-derive the label's cap after a resolution change. */
  setMonitorWidth: (px: number) => void
  /** Dynamically constrain the label's maximum allocated width in pixels so it never collides with the island. */
  /** `immediate` skips the ~180ms approach: for when something else is about to
   *  take the space in the same frame (the bar's overflow unfolding in line). */
  setMaxWidth: (px: number, immediate?: boolean) => void
}

const PAD_PX = 2 * BAR_TEXT_PAD // margin_start + margin_end

/**
 * What the capsule says. A window: its app's name (`appNameForWindow`). No window: the
 * desktop you are on, by number — the one place on the bar that spells it out (the dots
 * only show it). Game mode's workspace has a name, not a number.
 */
export function appTitleText(client: CompositorWindow | null, ws: CompositorWorkspace | null): string {
  if (client) return appService.appNameForWindow(client)
  if (ws?.name === GAME_WORKSPACE) return t("settings.gaming.title")
  return ws && ws.id > 0 ? `${t("overview.workspace")} ${ws.id}` : t("overview.workspace")
}

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
    margin_start: BAR_TEXT_PAD,
    margin_end: BAR_TEXT_PAD,
  })

  const updateLabel = () => {
    const maxTextPx = Math.max(20, currentBudgetPx - PAD_PX)
    const fitted = fitTextToPixels(appName, rawTitle, maxTextPx)
    if (appName.label !== fitted) appName.label = fitted
  }

  // Open while the window menu it anchors is down (the item IS the anchor).
  const capsule: Gtk.Widget = barItem({ child: appName, ...barOpen(() => isBarCustomAnchor(capsule)) })

  // No tooltip: it used to carry the window's whole title, because the label showed a
  // title cut to fit. The label is now the app's name and the title is in the window's
  // own title bar, so a tooltip would only repeat one or the other.

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
      const label = appTitleText(compositor.focusedClient, compositor.focusedWorkspace) || "—"
      if (label !== rawTitle) {
        rawTitle = label
        updateLabel()
      }
    }

    // "changed" alone: it fires when focus, the workspace or a window's class moves.
    // A window's TITLE is not what this says any more, so "title-changed" (a terminal
    // running a command, a browser tab) is no reason to look again. The registry is:
    // an app installed while its window is up gets its entry's name when it lands.
    compositor.connect("changed", sync)
    appService.connect(sync)
    sync()
    return GLib.SOURCE_REMOVE
  })

  if (openMenu) {
    let menuOpen = false
    // The open path, shared by the click gesture and the IPC hook.
    const openWindowMenu = () => {
      if (status.cc_edit_mode) return   // same guard as the other bar capsules
      // Every row acts on a window; with none, there is no menu to open. (The desktop's
      // mode is in the overview the dots open — #513 — not here.)
      if (!compositor.focusedClient) return
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
    setBarItemKey(capsule, openWindowMenu)
  }

  return {
    widget: capsule,
    setMonitorWidth: (px) => { startBudgetAnimation(Math.max(100, (px / 2) - 200)) },
    setMaxWidth: (px, immediate = false) => {
      if (!immediate) { startBudgetAnimation(px); return }
      if (animTickId !== null) { capsule.remove_tick_callback(animTickId); animTickId = null }
      targetBudgetPx = currentBudgetPx = px
      updateLabel()
    },
  }
}

export default AppTitle
