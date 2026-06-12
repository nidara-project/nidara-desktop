/**
 * Crystal Shell Dock - Shared Types and State
 * V106: Extracted for modular architecture
 */

import { Gtk, Gdk } from "ags/gtk4"
import { writeFile, readFile } from "ags/file"
import GLib from "gi://GLib"
// --- PERSISTENCE ---
const PINNED_FILE = GLib.get_user_config_dir() + "/dock_pinned.json"

// --- DOCK CONFIGURATION ---
export const DOCK_CONFIG = {
    USE_ICON_PLATES: false,
    SMART_PLATES_FOR_FILES: true,
    MAX_ICON_SIZE: 160,
    MAGNIFICATION_SCALE: 2.2,
    HOME_ICON_FALLBACK: ["user-home", "system-file-manager", "folder"],
}

// --- DOCK SETTINGS (Reactive, Persisted) ---
const SETTINGS_FILE = GLib.get_user_config_dir() + "/dock_settings.json"

export type DockPosition = 'bottom' | 'left' | 'right'

export interface DockSettings {
    iconSize: number        // 32–96, default 48
    magnification: boolean  // default true
    maxIconSize: number     // 64–128, default 108
    showIndicators: boolean // default true
    screenGap: number       // 4–16, default 8
    autoHide: boolean       // hide dock when mouse leaves, default false
    hideDelay: number       // ms before hiding after mouse leaves, default 500
    position: DockPosition  // dock anchor position, default 'bottom'
}

const DOCK_DEFAULTS: DockSettings = {
    iconSize: 64,
    magnification: true,
    maxIconSize: 108,
    showIndicators: true,
    screenGap: 8,
    autoHide: false,
    hideDelay: 500,
    position: 'bottom',
}

// Load persisted settings or use defaults
let _dockSettings: DockSettings = { ...DOCK_DEFAULTS }
try {
    const raw = JSON.parse(readFile(SETTINGS_FILE)) as Partial<DockSettings>
    _dockSettings = { ...DOCK_DEFAULTS, ...raw }
} catch {
    // First run — will persist on first change
}

export const dockSettings: DockSettings = _dockSettings

// Change listeners
const _settingsListeners = new Set<(s: DockSettings) => void>()

export function onDockSettingsChanged(fn: (s: DockSettings) => void) {
    _settingsListeners.add(fn)
    return () => _settingsListeners.delete(fn)
}

export function updateDockSettings(partial: Partial<DockSettings>) {
    Object.assign(dockSettings, partial)
    // Persist
    try {
        writeFile(SETTINGS_FILE, JSON.stringify(dockSettings, null, 2))
    } catch (e) {
        console.error("[DockSettings] Failed to persist:", e)
    }
    // Notify
    _settingsListeners.forEach(fn => fn(dockSettings))
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

const _pinnedListeners = new Set<() => void>()

export function onPinnedChanged(fn: () => void) {
    _pinnedListeners.add(fn)
    return () => _pinnedListeners.delete(fn)
}

export const savePinned = () => {
    const list = pinnedState.list
    try {
        writeFile(PINNED_FILE, JSON.stringify(list, null, 2))
        _pinnedListeners.forEach(fn => fn())
    } catch (e) {
        console.error(`[Dock] Failed to persist pinned list:`, e);
    }
}

// --- ANIMATION STATE ---
export interface AnimState {
    targetScale: number
    currentScale: number
    velocityScale: number      // V600: Spring Velocity

    targetWidth: number
    currentWidth: number
    velocityWidth: number      // V600: Spring Velocity

    targetMargin: number
    currentMargin: number
    velocityMargin: number     // V600: Spring Velocity

    targetHeight: number       // V618: Dynamic separator height
    currentHeight: number
    velocityHeight: number     // V600: Spring Velocity

    targetTranslateY: number   // V600: For Bounce/Vertical Shift
    currentTranslateY: number
    velocityY: number          // V600: Spring Velocity

    // Reorder slide spring: animates icon from old position to new position after DOM reorder
    currentSlideX: number
    targetSlideX: number
    velocitySlideX: number

    virtualCenter: number
    staticCenter: number
    isSeparator: boolean
    addresses?: string[]
    clientTitle?: string
    widget: Gtk.Widget // This is a bit of a hack but needed for quick access in loop
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

// Signals any button release on a dock icon (click, long-press, drag end).
// Dock.tsx subscribes to set isDndEnding=true, blocking the spurious
// wl_pointer.leave that Hyprland sends immediately after button release.
export const pointerBus = {
    _listeners: new Set<() => void>(),
    emitButtonReleased() { this._listeners.forEach(fn => fn()) },
    onButtonReleased(fn: () => void) {
        this._listeners.add(fn)
        return () => this._listeners.delete(fn)
    }
}

// --- SHARED UI STATE ---
export const menuState = {
    openCount: 0
}

const _menuCountListeners: Array<(count: number) => void> = []
export function onMenuCountChanged(cb: (count: number) => void): () => void {
    _menuCountListeners.push(cb)
    return () => { const i = _menuCountListeners.indexOf(cb); if (i >= 0) _menuCountListeners.splice(i, 1) }
}

export function changeMenuCount(delta: number) {
    menuState.openCount += delta
    if (menuState.openCount < 0) menuState.openCount = 0
    _menuCountListeners.forEach(cb => cb(menuState.openCount))
}


// --- DOCK SIDE STATE (reactive, consumed by CC/NC/NotifPopups) ---
// Published by VerticalDock when position is left/right, reset to 0 for bottom.
export const dockSideState = {
    position: 'bottom' as DockPosition,
    width: 0,  // exclusive zone width (px) when dock is left or right, else 0
    _listeners: new Set<() => void>(),
    update(position: DockPosition, width: number) {
        this.position = position
        this.width = width
        this._listeners.forEach(fn => fn())
    },
    subscribe(fn: () => void) {
        this._listeners.add(fn)
        return () => this._listeners.delete(fn)
    },
}
