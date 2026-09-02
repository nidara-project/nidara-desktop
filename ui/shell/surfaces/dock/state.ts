/**
 * Nidara Dock - Shared Types and State
 * V106: Extracted for modular architecture
 */

import Gtk from "gi://Gtk?version=4.0"
import { writeFile, readFile } from "../../../lib/file"
import GLib from "gi://GLib"
import { defineConfig, loadKnown, type ConfigValidators } from "../../core/configFile"
// --- PERSISTENCE ---
// All Nidara config lives under ~/.config/nidara/ (matches ThemeManager,
// WidgetConfig, RegionConfig, CCLayoutManager, …). These two dock files used to
// be written to the bare ~/.config/ root; loadPinned() and the settings loader
// below migrate them from there on first run and remove the strays.
const CONFIG_DIR = GLib.get_user_config_dir() + "/nidara"
const PINNED_FILE = CONFIG_DIR + "/dock_pinned.json"
const SETTINGS_FILE = CONFIG_DIR + "/dock_settings.json"
const LEGACY_PINNED_FILE = GLib.get_user_config_dir() + "/dock_pinned.json"
const LEGACY_SETTINGS_FILE = GLib.get_user_config_dir() + "/dock_settings.json"

const ensureConfigDir = () => {
    if (!GLib.file_test(CONFIG_DIR, GLib.FileTest.EXISTS))
        GLib.mkdir_with_parents(CONFIG_DIR, 0o755)
}

// --- DOCK SETTINGS (Reactive, Persisted) ---

export type DockPosition = 'bottom' | 'left' | 'right'

// Bounds are the ones the Settings sliders and `describeConfig` advertise
// (config-entries.ts). They were written here as prose and had drifted: the
// comment said iconSize defaulted to 48 when it defaults to 64, and capped
// screenGap at 16 when the slider goes to 32.
export interface DockSettings {
    iconSize: number        // 32–96
    magnification: boolean
    maxIconSize: number     // 64–128 (128 = full magnification)
    showIndicators: boolean
    screenGap: number       // 4–32
    autoHide: boolean       // hide dock when mouse leaves
    hideDelay: number       // 0–2000 ms before hiding after mouse leaves
    position: DockPosition  // dock anchor position
}

const DOCK_DEFAULTS: DockSettings = {
    iconSize: 64,
    magnification: true,
    maxIconSize: 128,
    showIndicators: true,
    screenGap: 8,
    autoHide: false,
    hideDelay: 500,
    position: 'bottom',
}

const DOCK_POSITIONS: readonly DockPosition[] = ['bottom', 'left', 'right']
const inRange = (lo: number, hi: number) => (v: number) =>
    Number.isFinite(v) && v >= lo && v <= hi

const DOCK_VALIDATORS: ConfigValidators<DockSettings> = {
    position: v => DOCK_POSITIONS.includes(v),
    iconSize: inRange(32, 96),
    maxIconSize: inRange(64, 128),
    screenGap: inRange(4, 32),
    hideDelay: inRange(0, 2000),
}

/**
 * The one-time move of the settings file out of the bare `~/.config/` root.
 *
 * It runs BEFORE the store is built, because a migration is a fact about this
 * machine's history rather than part of a settings lifecycle — folding it in
 * would make every module carry a hook for a path only the dock ever used.
 *
 * ⚠️ It writes the file through `loadKnown` rather than copying it byte for
 * byte. A straight copy is what the old code effectively did, and it carries
 * retired keys across to the new path, where they sit until the user happens to
 * change a dock setting: the exact one-way ratchet `loadKnown` exists to stop.
 * We are already writing the file here, so writing the DECLARED SHAPE is free.
 */
function migrateLegacySettingsFile() {
    if (GLib.file_test(SETTINGS_FILE, GLib.FileTest.EXISTS)) return
    if (!GLib.file_test(LEGACY_SETTINGS_FILE, GLib.FileTest.EXISTS)) return
    try {
        const known = loadKnown(DOCK_DEFAULTS, JSON.parse(readFile(LEGACY_SETTINGS_FILE)), DOCK_VALIDATORS)
        ensureConfigDir()
        writeFile(SETTINGS_FILE, JSON.stringify(known, null, 2))
        GLib.unlink(LEGACY_SETTINGS_FILE)
    } catch (e) {
        console.error("[DockSettings] Legacy migration failed:", e)
    }
}
migrateLegacySettingsFile()

const config = defineConfig<DockSettings>("dock_settings.json", DOCK_DEFAULTS, DOCK_VALIDATORS)

/** The live settings object — same identity for the life of the process, which
 *  is what the ~40 read sites throughout the dock and the bar rely on. */
export const dockSettings: Readonly<DockSettings> = config.all

/** Whole-object notification, for the three consumers that re-read several
 *  settings at once (app.ts, Bar.tsx, DockCore.tsx). */
export function onDockSettingsChanged(fn: (s: DockSettings) => void) {
    return config.subscribeAll(() => fn(dockSettings))
}

/** Per-key notification, for a consumer that cares about ONE setting — which is
 *  every Settings row. They used to share a whole-object listener, so changing
 *  the icon size re-applied all eight rows. */
export const onDockSettingChanged = config.subscribe

export function updateDockSettings(partial: Partial<DockSettings>) {
    config.update(partial)
}

// --- PINNED LIST MANAGEMENT ---
export const pinnedState = {
    list: [] as string[]
}

// Default pins for a FRESH install (no file yet). The dock already shows the
// Files/Home shortcut, the launcher and Trash as fixed items, so this is
// *additional*, and the array order IS the dock order (left→right, right of the
// launcher): Settings first, then the terminal. List only apps install.sh
// guarantees; the dock skips any id that doesn't resolve to an installed app, so
// an optional app shipped only by the ISO (e.g. a browser) is safe to add here
// too. `nidara-installer` is present on the live ISO medium but absent on an
// installed system; `pruneOrphanedPins` (in DockCore.tsx) prunes pins that do not
// resolve to an installed app, so on an installed system it safely vanishes.
// Applied in memory only — persisted the first time the user pins/unpins,
// after which it stops applying.
const DEFAULT_PINNED = ["nidara-settings", "kitty", "nidara-installer"]

const sanitizePinned = (raw: string[]) =>
    [...new Set(raw)]
        .filter(id => id && !id.startsWith("/"))
        .map(id => id.replace(/^pinned-/, "").replace(/^pinned-ghost-/, "").replace(/^running-/, ""))

function loadPinned(): string[] {
    // 1. Current location.
    try {
        const raw = JSON.parse(readFile(PINNED_FILE)) as string[]
        const clean = sanitizePinned(raw)
        if (clean.length !== raw.length) {
            ensureConfigDir()
            writeFile(PINNED_FILE, JSON.stringify(clean, null, 2))
        }
        return clean
    } catch { /* not at the current path */ }
    // 2. Legacy ~/.config/dock_pinned.json → migrate to the nidara/ path.
    try {
        const clean = sanitizePinned(JSON.parse(readFile(LEGACY_PINNED_FILE)) as string[])
        ensureConfigDir()
        writeFile(PINNED_FILE, JSON.stringify(clean, null, 2))
        try { GLib.unlink(LEGACY_PINNED_FILE) } catch {}
        return clean
    } catch { /* no legacy file */ }
    // 3. Truly fresh install → seed defaults (persisted on first pin change).
    return [...DEFAULT_PINNED]
}
pinnedState.list = loadPinned()

const _pinnedListeners = new Set<() => void>()

export function onPinnedChanged(fn: () => void) {
    _pinnedListeners.add(fn)
    return () => _pinnedListeners.delete(fn)
}

export const savePinned = () => {
    const list = pinnedState.list
    try {
        ensureConfigDir()
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
// (The old hover half — setHover/clearHover/hoverId — was dead: nothing ever
// called setHover, so hoverId was permanently "".)
export const dragBus = {
    listeners: [] as ((draggingId: string) => void)[],
    draggingId: "",
    subscribe(fn: (draggingId: string) => void) {
        this.listeners.push(fn)
        return () => { this.listeners = this.listeners.filter(l => l !== fn) }
    },
    emit() {
        this.listeners.forEach(fn => fn(this.draggingId))
    },
    setDragging(id: string) {
        this.draggingId = id
        this.emit()
    },
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
