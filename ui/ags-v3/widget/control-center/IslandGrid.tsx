import { Gtk, Gdk } from "ags/gtk4"
import AstalBluetooth from "gi://AstalBluetooth"
import AstalNetwork from "gi://AstalNetwork"
import AstalNotifd from "gi://AstalNotifd"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import BaseIsland from "./BaseIsland"
import { WifiWidget, RoundToggle, FocusWidget } from "./Toggles"
import { SliderWidget } from "./Sliders"
import { MediaIslandContent } from "./MediaIsland"
import status from "../../core/Status"

import { AtomicWidget, WidgetSize } from "./Types"

/**
 * Grid Constants (The "Source of Truth" for spacing and sizing) 📐
 */
export const UNIT = 80
export const GAP = 12

export const SIZE_MAP: Record<WidgetSize, { w: number, h: number }> = {
    [WidgetSize.SINGLE]: { w: 1, h: 1 },
    [WidgetSize.WIDE]: { w: 2, h: 1 },
    [WidgetSize.TALL]: { w: 1, h: 2 },
    [WidgetSize.SQUARE]: { w: 2, h: 2 },
    [WidgetSize.FULL_WIDTH]: { w: 4, h: 1 }
}

export const LAYOUT_CONFIG = [
    { id: "media", x: 0, y: 0 },
    { id: "focus", x: 0, y: 2 },
    { id: "wifi", x: 2, y: 0 },
    { id: "airdrop", x: 2, y: 1 },
    { id: "bt", x: 3, y: 1 },
    { id: "dark_mode", x: 2, y: 2 },
    { id: "calculator", x: 3, y: 2 },
    { id: "brightness", x: 0, y: 3 },
    { id: "volume", x: 0, y: 4 },
    { id: "timer", x: 0, y: 5 },
    { id: "camera", x: 1, y: 5 },
]

export function getWidgetById(id: string): AtomicWidget | null {
    try {
        const btSvc = AstalBluetooth.get_default()
        const registry: Record<string, () => AtomicWidget> = {
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
            dark_mode: () => RoundToggle("dark-mode", "Appearance", "night-light-symbolic", true, () => { }),
            calculator: () => RoundToggle("calc", "Calculator", "accessories-calculator-symbolic", false, () => { execAsync("gnome-calculator").catch(() => { }) }),
            timer: () => RoundToggle("timer", "Timer", "alarm-symbolic", false, () => { }),
            camera: () => RoundToggle("camera", "Camera", "camera-photo-symbolic", false, () => { })
        }
        const factory = registry[id]
        return factory ? factory() : null
    } catch (e) {
        console.error(`[IslandGrid] Failed to resolve widget ${id}:`, e)
        return null
    }
}

/**
 * Backward compatibility: Single-window CC mode (Optional)
 */
export default function IslandGrid() {
    const container = new Gtk.Fixed({
        name: "island-grid-root",
        css_classes: ["island-grid-container"],
        width_request: 356,
        height_request: 540,
        halign: Gtk.Align.END
    })

    const pixelX = (gx: number) => gx * (UNIT + GAP)
    const pixelY = (gy: number) => gy * (UNIT + GAP)

    LAYOUT_CONFIG.forEach(item => {
        const def = getWidgetById(item.id)
        if (def) {
            const { w, h } = SIZE_MAP[def.size]
            const width = w * UNIT + (w - 1) * GAP
            const height = h * UNIT + (h - 1) * GAP

            const widget = BaseIsland({
                name: def.id,
                child: def.child,
                width,
                height,
                size: def.size
            })
            container.put(widget, pixelX(item.x), pixelY(item.y))
        }
    })

    return container
}
