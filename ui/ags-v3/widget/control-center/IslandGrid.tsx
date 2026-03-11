import { Gdk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import BaseIsland from "./BaseIsland"
import { WifiWidget, RoundToggle, FocusWidget } from "./Toggles"
import { SliderWidget } from "./Sliders"
import { MediaIslandContent } from "./MediaIsland"

import { AtomicWidget } from "./Types"

import { Shape } from "../common/SquircleContainer"

export default function IslandGrid(monitor: Gdk.Monitor) {
    const islands: Gtk.Window[] = []

    // Grid Setup
    const UNIT = 78
    const GAP = 12
    const ROW0_Y = 52

    const pixelX = (gx: number) => GAP + gx * (UNIT + GAP)
    const pixelY = (gy: number) => ROW0_Y + gy * (UNIT + GAP)

    const createIsland = (def: AtomicWidget) => {
        const win = BaseIsland({
            name: def.id,
            monitor,
            x: pixelX(def.grid.x),
            y: pixelY(def.grid.y),
            width: def.grid.w * UNIT + (def.grid.w - 1) * GAP,
            height: def.grid.h * UNIT + (def.grid.h - 1) * GAP,
            shape: def.shape,
            child: def.child,
            alpha: 0.15,
            gloss: true
        })
        return win
    }

    try {
        // Registry of Widgets
        const btSvc = AstalBluetooth.get_default()

        let hasBacklight = false
        try {
            const [success, out] = GLib.spawn_command_line_sync("brightnessctl -l")
            if (success && out) {
                const outStr = new TextDecoder().decode(out)
                hasBacklight = outStr.includes("backlight")
            }
        } catch (e) { }

        const widgets: AtomicWidget[] = [
            WifiWidget({ x: 2, y: 0 }),
            MediaIslandContent({ x: 0, y: 0 }),

            // Row 2
            FocusWidget({ x: 0, y: 2 }),
            RoundToggle("airdrop", "AirDrop", "network-transmit-receive-symbolic", { x: 2, y: 2 }, true, () => { }),
            RoundToggle("bt", "BT", "bluetooth-active-symbolic", { x: 3, y: 2 }, btSvc?.is_powered || false, () => {
                if (btSvc) btSvc.is_powered = !btSvc.is_powered
            }),
        ]

        let currentRow = 3
        if (hasBacklight) {
            widgets.push(SliderWidget("brightness", "Brightness", "display-brightness-symbolic", "Display", { x: 0, y: currentRow }, 70, (v) => {
                execAsync(`brightnessctl s ${Math.floor(v * 100)}%`).catch(() => { })
            }))
            currentRow++
        }

        // Row 4 (or 3 if no backlight)
        widgets.push(SliderWidget("volume", "Volume", "audio-volume-high-symbolic", "Sound", { x: 0, y: currentRow }, 50, (v) => {
            execAsync(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v.toFixed(2)}`).catch(() => { })
        }))

        widgets.forEach(w => {
            const win = createIsland(w)
            islands.push(win)
        })

        const toggle = () => {
            const isVisible = !islands[0].visible
            islands.forEach(win => win.visible = isVisible)
        }

        const set_visible = (v: boolean) => {
            islands.forEach(win => win.visible = v)
        }

        const get_visible = () => islands[0].visible

        return { toggle, set_visible, get_visible, islands, name: "island-grid" }
    } catch (e) {
        console.error("[IslandGrid] Layout Error:", e)
        return { toggle: () => { }, islands: [], get_visible: () => false, set_visible: (v) => { } } as any
    }
}
