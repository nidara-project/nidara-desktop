
import AstalHyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

const hypr = AstalHyprland.get_default()

function log() {
    const m = hypr.get_monitors()[0]
    const fw = hypr.focused_workspace?.id
    console.log(`[Diagnostic] Focus: WS ${fw} | Monitor: ${m.width}x${m.height} | Res: ${m.reserved_top},${m.reserved_bottom},${m.reserved_left},${m.reserved_right}`)
}

log()
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    log()
    return true
})
