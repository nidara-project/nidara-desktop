/**
 * MiDistroIA Dock - Shared Types and State
 * V106: Extracted for modular architecture
 */

import { Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import GLib from "gi://GLib"
import AstalHyprland from "gi://AstalHyprland"
import AstalApps from "gi://AstalApps"
import { DOCK_CONSTANTS } from "./DockPhysics"

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
export const pinnedState = {
    list: [] as string[]
}

try {
    const raw = JSON.parse(readFile(PINNED_FILE)) as string[]
    const oldLen = raw.length
    pinnedState.list = [...new Set(raw)]
        .filter(id => id && !id.startsWith("/"))
        .map(id => id.replace(/^pinned-/, "").replace(/^pinned-ghost-/, "").replace(/^running-/, ""))

    if (pinnedState.list.length !== oldLen) {
        writeFile(PINNED_FILE, JSON.stringify(pinnedState.list, null, 2))
    }
} catch {
    pinnedState.list = []
}

export const savePinned = () => {
    const list = pinnedState.list
    console.log(`[DockAudit] COMMIT: saving ${list.length} items to ${PINNED_FILE}`);
    console.log(`[DockAudit] DATA: ${JSON.stringify(list)}`);
    try {
        writeFile(PINNED_FILE, JSON.stringify(list, null, 2))
        console.log(`[DockAudit] SUCCESS.`);
    } catch (e) {
        console.error(`[DockAudit] FAILURE:`, e);
    }
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
// V499: Unified dragBus to ensure Dock and DockItem share the exact same state.
export const dragBus = {
    listeners: [] as ((draggingId: string, hoverId: string) => void)[],
    draggingId: "",
    hoverId: "",
    subscribe(fn: (draggingId: string, hoverId: string) => void) {
        this.listeners.push(fn)
        return () => { this.listeners = this.listeners.filter(l => l !== fn) }
    },
    emit() {
        this.listeners.forEach(fn => fn(this.draggingId, this.hoverId))
    },
    setDragging(id: string) {
        this.draggingId = id
        this.emit()
    },
    setHover(id: string) {
        if (!id && this.draggingId) return // Sticky
        if (this.hoverId === id) return
        this.hoverId = id
        this.emit()
    },
    clearHover() {
        this.hoverId = ""
        this.emit()
    }
}

export const mouseBus = {
    listeners: new Set<(x: number) => void>(),
    emit(x: number) { this.listeners.forEach(l => l(x)) },
    subscribe(l: (x: number) => void) { this.listeners.add(l); return () => this.listeners.delete(l) }
}

// Re-export physics constants for convenience
export { DOCK_CONSTANTS }
