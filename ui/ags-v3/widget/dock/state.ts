/**
 * MiDistroIA Dock - Shared Types and State
 * V106: Extracted for modular architecture
 */

import { Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import { DOCK_CONSTANTS } from "../DockPhysics"

// --- PERSISTENCE ---
const PINNED_FILE = GLib.get_home_dir() + "/.config/dock_pinned.json"

// Shared Hyprland service
export const hypr = AstalHyprland.get_default()
export const appsService = new AstalApps.Apps()

// --- DOCK CONFIGURATION ---
export const DOCK_CONFIG = {
    USE_ICON_PLATES: false,
    SMART_PLATES_FOR_FILES: true,
    MAX_ICON_SIZE: 160,
    MAGNIFICATION_SCALE: 2.2,
    HOME_ICON_FALLBACK: ["user-home", "system-file-manager", "folder"],
}

// --- PINNED LIST MANAGEMENT ---
let pinnedList: string[] = []
try {
    const raw = JSON.parse(readFile(PINNED_FILE)) as string[]
    const oldLen = raw.length
    pinnedList = [...new Set(raw)]
        .filter(id => id && !id.startsWith("/"))
        .map(id => id.replace(/^pinned-/, "").replace(/^pinned-ghost-/, "").replace(/^running-/, ""))

    if (pinnedList.length !== oldLen) {
        writeFile(PINNED_FILE, JSON.stringify(pinnedList, null, 2))
    }
} catch {
    pinnedList = []
}

export const getPinnedList = () => pinnedList
export const setPinnedList = (list: string[]) => { pinnedList = list }

export const savePinned = () => {
    console.log(`[Dock] Saving pinned list: ${JSON.stringify(pinnedList)}`);
    writeFile(PINNED_FILE, JSON.stringify(pinnedList, null, 2))
}

export const addPinned = (id: string) => {
    if (!pinnedList.some(p => p.toLowerCase() === id.toLowerCase())) {
        pinnedList.push(id)
        savePinned()
    }
}

export const removePinned = (id: string) => {
    pinnedList = pinnedList.filter(p => p.toLowerCase() !== id.toLowerCase())
    savePinned()
}

export const movePinned = (id: string, toIndex: number) => {
    const lower = id.toLowerCase()
    pinnedList = pinnedList.filter(p => p.toLowerCase() !== lower)
    pinnedList.splice(toIndex, 0, id)
    savePinned()
}

export const isPinned = (id: string): boolean => {
    return pinnedList.some(p => p.toLowerCase() === id.toLowerCase())
}

// --- ANIMATION STATE ---
export interface AnimState {
    targetScale: number
    currentScale: number
    targetWidth: number
    currentWidth: number
    targetMargin: number
    currentMargin: number
    virtualCenter: number
    staticCenter: number
    isSeparator: boolean
    addresses?: string[]
    clientTitle?: string
}

// --- EVENT BUSES ---
export const dragBus = {
    listeners: [] as ((id: string) => void)[],
    subscribe(fn: (id: string) => void) {
        this.listeners.push(fn)
        return () => { this.listeners = this.listeners.filter(l => l !== fn) }
    },
    update(id: string) {
        this.listeners.forEach(fn => fn(id))
    }
}

export const mouseBus = {
    listeners: new Set<(x: number) => void>(),
    emit(x: number) { this.listeners.forEach(l => l(x)) },
    subscribe(l: (x: number) => void) { this.listeners.add(l); return () => this.listeners.delete(l) }
}

// Re-export physics constants for convenience
export { DOCK_CONSTANTS }
