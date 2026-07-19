import { Gtk } from "ags/gtk4"
import SquircleContainer from "../../common/SquircleContainer"
import { PANEL_W } from "../../common/widget-kit"
import { makeBatteryGlyph, batteryFrac } from "../../common/BatteryGlyph"
import { t } from "../../core/i18n"
import { safeDisconnect } from "../../core/signals"
import AstalBattery from "gi://AstalBattery"

// The battery-critical expanded surface — the island's auto-expand prototype
// (opened by the battery activity taking the compact's front, see
// IslandActivities.tsx; closes on outside click / plugging in, when the
// engine drops the dead activity's mode). Deliberately a plain statement, not
// a control panel: there is exactly one remedy and it isn't on screen.
//
// Glass recipe exported for ActivityIsland's MorphRevealer, same contract as
// PLAYER_GLASS / WO_GLASS.
export const BATTERY_GLASS = { radius: 32, n: 3.2, border: { r: 1, g: 1, b: 1, a: 0.1 } }

export default function BatteryIsland(): Gtk.Widget {
    const bat = AstalBattery.get_default()

    const glyph = makeBatteryGlyph(26)
    const title = new Gtk.Label({
        label: t("island.battery.critical"),
        css_classes: ["island-battery-title"],
        halign: Gtk.Align.CENTER,
    })
    const sub = new Gtk.Label({
        css_classes: ["island-battery-sub"],
        halign: Gtk.Align.CENTER,
    })
    const sync = () => {
        sub.label = `${Math.round(batteryFrac() * 100)}% · ${t("island.battery.hint")}`
        glyph.queue_draw()
    }
    sync()
    if (bat) {
        const id = bat.connect("notify", sync)
        glyph.connect("unrealize", () => safeDisconnect(bat, id))
    }

    const inner = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        margin_top: 18, margin_bottom: 18, margin_start: 22, margin_end: 22,
        width_request: PANEL_W.lg,
    })
    inner.append(glyph)
    inner.append(title)
    inner.append(sub)

    const squircle = SquircleContainer({
        child: inner,
        n: BATTERY_GLASS.n,
        radius: BATTERY_GLASS.radius,
        useShellOpacity: true,
        gloss: true,
        borderColor: BATTERY_GLASS.border,
    })
    const windowContent = new Gtk.Box({
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true,
    })
    windowContent.append(squircle)

    // Morph handles (see common/MorphRevealer.ts).
    ;(windowContent as any).morphContent = inner
    ;(windowContent as any).morphGlass = squircle
    return windowContent
}
