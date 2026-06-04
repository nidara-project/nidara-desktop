import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import AstalHyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"
import { getWordmark } from "../../utils"
import SquircleContainer from "../common/SquircleContainer"
import { CAPSULE_BORDER } from "./capsule"
import hs from "../../core/HyprlandState"

// Bar-left capsule showing the focused window's app name (wordmark), kept in
// sync with Hyprland's focused client and its title changes.
export function AppTitle(monitorWidth: number): Gtk.Widget {
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
      const label = getWordmark(client, AstalHyprland.get_default())
      if (label && label !== appName.label) appName.label = label

      // Only rewire notify::title when the focused client actually changed
      if (client === trackedClient) return
      if (trackedClient && titleHandlerId) {
        trackedClient.disconnect(titleHandlerId)
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

  return SquircleContainer({ child: appName, gloss: true, useShellOpacity: true, borderColor: CAPSULE_BORDER, hoverBorderAccent: true, perfect: true })
}

export default AppTitle
