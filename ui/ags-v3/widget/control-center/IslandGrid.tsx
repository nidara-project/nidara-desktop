import { Gtk, Gdk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import BaseIsland from "./BaseIsland"
import { WifiWidget, RoundToggle, FocusWidget } from "./Toggles"
import { SliderWidget } from "./Sliders"
import { MediaIslandContent } from "./MediaIsland"

import { AtomicWidget, WidgetSize } from "./Types"

/**
 * Grid Constants (The "Source of Truth" for spacing and sizing) 📐
 * All widgets follow these geometric rules.
 */
const UNIT = 80
const GAP = 12
const ROW0_Y = 52
const MARGIN_RIGHT = 16

const SIZE_MAP: Record<WidgetSize, { w: number, h: number }> = {
    [WidgetSize.SINGLE]: { w: 1, h: 1 },
    [WidgetSize.WIDE]: { w: 2, h: 1 },
    [WidgetSize.TALL]: { w: 1, h: 2 },
    [WidgetSize.SQUARE]: { w: 2, h: 2 },
    [WidgetSize.FULL_WIDTH]: { w: 4, h: 1 }
}

export default function IslandGrid(monitor: Gdk.Monitor) {
    const islands: Gtk.Window[] = []

    const pixelX = (gx: number) => MARGIN_RIGHT + gx * (UNIT + GAP)
    const pixelY = (gy: number) => ROW0_Y + gy * (UNIT + GAP)

    const createIsland = (def: AtomicWidget, gx: number, gy: number) => {
        const { w, h } = SIZE_MAP[def.size]
        const width = w * UNIT + (w - 1) * GAP
        const height = h * UNIT + (h - 1) * GAP

        const win = BaseIsland({
            name: def.id,
            child: def.child,
            monitor,
            x: pixelX(gx),
            y: pixelY(gy),
            width,
            height,
            size: def.size
        })
        return win
    }

    try {
        const btSvc = AstalBluetooth.get_default()

        // Registry of Widgets (Mini-Apps 📱)
        // This is where each widget logic is isolated.
        const registry: Record<string, (args?: any) => AtomicWidget> = {
            media: () => MediaIslandContent(),
            wifi: () => WifiWidget(),
            focus: () => FocusWidget(),
            airdrop: () => RoundToggle("airdrop", "AirDrop", "network-transmit-receive-symbolic", true, () => { }),
            bt: () => RoundToggle("bt", "BT", "bluetooth-active-symbolic", btSvc?.is_powered || false, () => {
                if (btSvc) btSvc.is_powered = !btSvc.is_powered
            }),
            brightness: () => SliderWidget("brightness", "Brightness", "display-brightness-symbolic", "Display", 70, (v) => {
                execAsync(`brightnessctl s ${Math.floor(v * 100)}%`).catch(() => { })
            }),
            volume: () => SliderWidget("volume", "Volume", "audio-volume-high-symbolic", "Sound", 50, (v) => {
                execAsync(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${v.toFixed(2)}`).catch(() => { })
            }),
            // Bottom Utility Icons
            dark_mode: () => RoundToggle("dark-mode", "Appearance", "night-light-symbolic", true, () => { }),
            calculator: () => RoundToggle("calc", "Calculator", "accessories-calculator-symbolic", false, () => { execAsync("gnome-calculator").catch(() => { }) }),
            timer: () => RoundToggle("timer", "Timer", "alarm-symbolic", false, () => { }),
            camera: () => RoundToggle("camera", "Camera", "camera-photo-symbolic", false, () => { })
        }

        /**
         *  CENTRAL LAYOUT CONTROL 
         * Dense 3-row layout to eliminate gaps.
         */
        const layoutConfig = [
            // Right Column (Media + Focus)
            { id: "media", x: 0, y: 0 }, // 2x2 (Top Right)
            { id: "focus", x: 0, y: 2 }, // 2x1 (Bottom Right - Capsule)

            // Left Column (Connectivity + Utilities)
            { id: "wifi", x: 2, y: 0 }, // 2x1 (Top Left - Capsule)
            { id: "airdrop", x: 2, y: 1 }, // 1x1 
            { id: "bt", x: 3, y: 1 }, // 1x1
            { id: "dark_mode", x: 2, y: 2 }, // 1x1 (Bottom Left)
            { id: "calculator", x: 3, y: 2 }, // 1x1 (Bottom Left)

            // Sliders (Below the 3-row block)
	    { id: "brightness", x: 0, y: 3 }, // 4x1
	    { id: "volume", x: 0, y: 4 }, // 4x1

            // Bottom Bar Utilities
            { id: "timer", x: 0, y: 5 }, // 1x1
            { id: "camera", x: 1, y: 5 }, // 1x1
        ]

        // Instantiate and position widgets
        layoutConfig.forEach(item => {
            const factory = registry[item.id]
            if (factory) {
                const widget = factory()
                const win = createIsland(widget, item.x, item.y)
                islands.push(win)
            }
        })

        const toggle = () => {
            if (islands.length === 0) return
            const isVisible = !islands[0].visible
            islands.forEach(win => win.visible = isVisible)
        }

        const set_visible = (v: boolean) => {
            islands.forEach(win => win.visible = v)
        }

        const get_visible = () => islands.length > 0 ? islands[0].visible : false

        return { toggle, set_visible, get_visible, islands, name: "island-grid" }
    } catch (e) {
        console.error("[IslandGrid] Layout Error:", e)
        return { toggle: () => { }, islands: [], get_visible: () => false, set_visible: (v) => { } } as any
    }
}
