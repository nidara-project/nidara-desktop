/**
 * Nidara — shared dock core.
 *
 * Holds all the dock logic that is identical between the horizontal (bottom) and
 * vertical (left/right) docks: pinned/running grouping, reorder & drag, the
 * spring animation tick, AppGrid panel, fullscreen handling, auto-hide, and the
 * wiring of Hyprland/AppService/Status. Everything axis-specific is delegated to
 * an `AxisAdapter` (see DockAxis.ts). DockHorizontal/DockVertical are thin
 * wrappers that pass the matching adapter.
 */

import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import { DOCK_CONSTANTS, syncConstants, springStep, slideSpringStep } from "./DockPhysics"
import type { SpringChannel } from "./DockPhysics"
import appService from "../../core/AppService"
import trashService from "../../core/TrashService"
import { DockItem, Separator, dismissActiveDockMenu } from "./DockItem"
import {
    dragBus, pointerBus, savePinned, pinnedState, dockSettings, onDockSettingsChanged,
    menuState, onMenuCountChanged, dockSideState, onPinnedChanged,
} from "./state"
import status from "../../core/Status"
import hs from "../../core/HyprlandState"
import Theme from "../../core/ThemeManager"
import { t } from "../../core/i18n"
import shellActions from "../../core/ShellActions"
import { iconAssetPath } from "../../core/Icons"
import AppGridPanel from "../app-grid/AppGrid"
import { safeDisconnect } from "../../core/signals"
import type { AxisAdapter, RevealState } from "./DockAxis"

export default function DockCore(gdkmonitor: any, axis: AxisAdapter) {
    dockSideState.update(dockSettings.position, 0)

    const norm = (s: string) => (s || "").toLowerCase().replace(".desktop", "")

    const appMatch = (k: string, lid: string) =>
        k === lid || (
            !k.startsWith("steam_app_") && !lid.startsWith("steam_app_") &&
            (k.includes(lid) || lid.includes(k))
        )

    // Stable size (main axis) of the resting dock — used to seed centering and the
    // drag-lock origin. Identical math for both axes (slots accumulate the same).
    const calculateStableMain = (effectivePinned: string[]) => {
        const groupedClients: { [key: string]: any } = {}
        hs.clients.forEach(c => {
            if (!c.class) return
            if (c.class.toLowerCase().includes("ags")) return
            let key = c.class.toLowerCase()
            if (["org.gnome.nautilus", "nautilus", "thunar", "dolphin", "pcmanfm", "nemo", "nemo-desktop"].includes(key)) {
                key = "home-shortcut"
            }
            groupedClients[key] = true
        })

        const runningUnpinnedCount = Object.keys(groupedClients).filter(c =>
            c !== "home-shortcut" &&
            c !== "launcher" &&
            c !== "trash" &&
            c !== "special:trash" &&
            !effectivePinned.some(p => norm(p) === c)
        ).length

        const apps = 3 + effectivePinned.length + runningUnpinnedCount
        const separators = 1 + (runningUnpinnedCount > 0 ? 1 : 0)
        return (apps * DOCK_CONSTANTS.APP_SLOT) + (separators * DOCK_CONSTANTS.SEPARATOR_SLOT)
    }

    const initialPinned = [...pinnedState.list]
    let totalStaticMain = calculateStableMain(initialPinned)
    const widgetCache = new Map<string, Gtk.Widget>()
    let lastIconTheme = Theme.iconTheme
    let firstRender = true
    let orderedIds: string[] = []
    let smoothedBarMain = totalStaticMain
    let currentTotalItems = 0

    let previewIdx = -1
    let lastDraggingId = ""
    let lockedStaticMain = 0
    let lockedStart = 0
    let isDndEnding = false
    let cursorInDock = false
    let lastMousePos = -1000

    // Declared early so revealState() never hits a TDZ; assigned in their sections.
    let appGridPanelOpen = false
    let fullscreenMode = false

    const unpinnedOpenOrder = new Map<string, number>()
    let unpinnedSeq = 0

    const getLaunch = (lid: string) => {
        return () => {
            // Origin-aware command (gtk-launch / flatpak run) — see AppService.getLaunchCommand.
            const cmd = appService.getLaunchCommand(lid)
            execAsync(["uwsm", "app", "--", "sh", "-c", `cd "$HOME" && exec ${cmd}`])
                .catch(() => { try { appService.getAppInfo(lid)?.launch?.([], null) } catch (_) {} })
        }
    }

    const onPin = (sourceId: string) => {
        const nid = norm(sourceId)
        pinnedState.list = pinnedState.list.filter(p => norm(p) !== nid)
        pinnedState.list.unshift(sourceId)
        savePinned(); update()
    }
    const onUnpin = (sourceId: string) => {
        const nid = norm(sourceId)
        pinnedState.list = pinnedState.list.filter(p => norm(p) !== nid)
        savePinned(); update()
    }
    const onReorder = (sourceId: string) => {
        const draggingId = dragBus.draggingId || sourceId
        const nsid = norm(draggingId)
        if (!nsid || nsid === "void") return

        let finalIdx = previewIdx
        if (finalIdx === -1) {
            const rel = lastMousePos - lockedStart
            finalIdx = Math.floor(rel / DOCK_CONSTANTS.APP_SLOT)
        }

        const wasPinned = pinnedState.list.some(p => norm(p) === nsid)
        const pinnedCount = pinnedState.list.filter(p => norm(p) !== nsid).length
        const pinnedBoundary = 2 + pinnedCount

        if (finalIdx === currentTotalItems - 1) { onUnpin(draggingId); return }
        if (finalIdx === 1) { onPin(draggingId); return }

        if (finalIdx <= pinnedBoundary) {
            pinnedState.list = pinnedState.list.filter(p => norm(p) !== nsid)
            let insertIdx = finalIdx - 2
            if (insertIdx < 0) insertIdx = 0
            if (insertIdx > pinnedState.list.length) insertIdx = pinnedState.list.length
            pinnedState.list.splice(insertIdx, 0, draggingId)
            savePinned()
        } else {
            if (wasPinned) {
                pinnedState.list = pinnedState.list.filter(p => norm(p) !== nsid)
                savePinned()
            }
            const sortedUnpinned = [...unpinnedOpenOrder.entries()]
                .sort((a, b) => a[1] - b[1])
                .map(([k]) => k)
                .filter(k => k !== nsid)
            let toIdx = Math.max(0, Math.min(finalIdx - (pinnedBoundary + 1), sortedUnpinned.length))
            sortedUnpinned.splice(toIdx, 0, nsid)
            sortedUnpinned.forEach((k, i) => unpinnedOpenOrder.set(k, i))
            unpinnedSeq = sortedUnpinned.length
        }

        previewIdx = -1
        lastDraggingId = ""
        isDndEnding = true
        update()
        GLib.timeout_add(GLib.PRIORITY_HIGH, 600, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
    }

    const WIN_W = axis.WIN_W
    const WIN_H = axis.WIN_H

    const win = new Gtk.Window({
        name: "nidara-dock",
        css_classes: ["nidara-dock-window", "nd-ignore"],
        application: app,
        focusable: false,
        can_focus: false,
        can_target: true,
        resizable: false,
        default_height: WIN_H,
    })
    ;(win as any).gdkmonitor = gdkmonitor

    const windowOverlay = new Gtk.Overlay({ hexpand: true, vexpand: true })
    win.set_child(windowOverlay)

    // Axis builds its own bar/da/shim/layout (orientation, draw func, anchors differ).
    const { bar, da, shim, layout } = axis.build(totalStaticMain)

    const barDismissClick = new Gtk.GestureClick({ button: 0 })
    barDismissClick.connect("pressed", () => { dismissActiveDockMenu() })
    bar.add_controller(barDismissClick)

    // Single theme→redraw handler for the background drawing area (the axis does
    // NOT connect its own; see DockAxis). Disconnected on destroy — the dock is
    // rebuilt in-process on position/autoHide/monitor-geometry changes.
    const themeConn = Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })

    shim.append(bar)
    layout.set_child(da)
    layout.add_overlay(shim)
    windowOverlay.set_child(layout)

    const animRegistry = new Map<string, import("./state").AnimState>()
    let tickId: number | null = null

    let isRevealed    = !dockSettings.autoHide
    let slideTarget   = dockSettings.autoHide ? axis.hideDistance : 0
    let slideCurrent  = slideTarget
    let slideVelocity = 0
    const SLIDE_STIFFNESS = 500
    const SLIDE_DAMPING = 52

    let dndActive = false
    let isSettlingIn = dockSettings.autoHide

    let layerShellReady = false

    const revealState = (): RevealState => ({
        isRevealed, slideCurrent, slideTarget, fullscreenMode, appGridPanelOpen,
        menuOpenCount: menuState.openCount,
    })

    const setRevealed = (reveal: boolean) => {
        if (isRevealed === reveal) return
        if (!reveal && dndActive) return
        isRevealed = reveal
        slideTarget = reveal ? 0 : axis.hideDistance
        if (layerShellReady) {
            axis.setExclusiveZone(win, reveal ? DOCK_CONSTANTS.EXCLUSIVE_ZONE : 0)
        }
        runUnifiedTick(true)
    }

    const runUnifiedTick = (seedFrame = false) => {
        if (tickId !== null) return
        tickId = bar.add_tick_callback((_, _clock) => {
            if (menuState.openCount > 0) return true

            if (orderedIds.length === 0) {
                tickId = null
                return false
            }

            const dt = 1 / 60
            let active = false

            // Step 1: advance all icon springs
            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return

                const scaleChannel: SpringChannel = { target: state.targetScale, current: state.currentScale, velocity: state.velocityScale }
                const widthChannel: SpringChannel = { target: state.targetWidth, current: state.currentWidth, velocity: state.velocityWidth }
                const marginChannel: SpringChannel = { target: state.targetMargin, current: state.currentMargin, velocity: state.velocityMargin }

                const a1 = springStep(scaleChannel, dt)
                const a2 = springStep(widthChannel, dt)
                const a3 = springStep(marginChannel, dt)

                state.currentScale = scaleChannel.current; state.velocityScale = scaleChannel.velocity
                state.currentWidth = widthChannel.current; state.velocityWidth = widthChannel.velocity
                state.currentMargin = marginChannel.current; state.velocityMargin = marginChannel.velocity

                let a4 = false
                if (state.currentSlideX !== 0 || state.targetSlideX !== 0) {
                    const slideXCh: SpringChannel = { target: state.targetSlideX, current: state.currentSlideX, velocity: state.velocitySlideX }
                    a4 = slideSpringStep(slideXCh, dt)
                    state.currentSlideX = slideXCh.current; state.velocitySlideX = slideXCh.velocity
                }

                let a5 = false
                if (state.currentHeight !== state.targetHeight) {
                    const heightCh: SpringChannel = { target: state.targetHeight, current: state.currentHeight, velocity: state.velocityHeight }
                    a5 = springStep(heightCh, dt)
                    state.currentHeight = heightCh.current; state.velocityHeight = heightCh.velocity
                }

                if (a1 || a2 || a3 || a4 || a5) active = true
            })

            // Step 2: apply per-icon layout (axis-specific)
            let totalBarMain = 0
            let currentFloat = 0
            let lastRounded = 0

            axis.beginLayoutPass()
            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return
                const gtkRev = widgetCache.get(id) as any
                if (!state.widget && !gtkRev) return

                if (state.isSeparator) {
                    totalBarMain += state.currentWidth
                    currentFloat += state.currentWidth
                    const newRounded = Math.round(currentFloat)
                    const slot = newRounded - lastRounded
                    lastRounded = newRounded
                    axis.applySeparatorLayout({
                        stateWidget: state.widget, gtkRev,
                        slotMain: slot, curHeight: state.currentHeight,
                    })
                } else {
                    const exactMargin = state.currentMargin
                    const exactIconSize = DOCK_CONSTANTS.ICON_SIZE * state.currentScale
                    const exactSlot = exactIconSize + (exactMargin * 2)
                    totalBarMain += exactSlot
                    currentFloat += exactSlot
                    const newRounded = Math.round(currentFloat)
                    const slot = newRounded - lastRounded
                    lastRounded = newRounded

                    const tps = Math.round(exactIconSize)
                    const remaining = slot - tps
                    const marginLo = Math.floor(remaining / 2)
                    const marginHi = Math.ceil(remaining / 2)
                    const slide = Math.round(state.currentSlideX)

                    axis.applyIconLayout({
                        stateWidget: state.widget, gtkRev,
                        slotMain: slot, tps, marginLo, marginHi, slide,
                        translate: state.currentTranslateY, scale: state.currentScale,
                    })
                }
            })

            // Step 3: bar size + centering + input region
            const roundedTotal = Math.round(totalBarMain)
            axis.centerBar(roundedTotal)
            if (active || smoothedBarMain !== roundedTotal) {
                smoothedBarMain = roundedTotal
                totalStaticMain = roundedTotal
                axis.updateSize(smoothedBarMain)
                axis.buildInputRegion(win, smoothedBarMain, revealState())
                active = true
            }

            // Step 4: auto-hide slide spring
            const slideDelta = slideTarget - slideCurrent
            const slideAbsDelta = Math.abs(slideDelta)
            const slideAbsVel = Math.abs(slideVelocity)
            if (slideAbsDelta > 0.2 || slideAbsVel > 0.2) {
                const slideForce = SLIDE_STIFFNESS * slideDelta - SLIDE_DAMPING * slideVelocity
                slideVelocity += slideForce * dt
                slideCurrent += slideVelocity * dt
                if (layerShellReady) axis.applySlide(win, Math.round(slideCurrent))
                if (axis.vertical) da.queue_draw()
                axis.buildInputRegion(win, smoothedBarMain, revealState())
                active = true
            } else if (slideCurrent !== slideTarget) {
                slideCurrent = slideTarget
                slideVelocity = 0
                if (layerShellReady) axis.applySlide(win, Math.round(slideTarget))
                if (axis.vertical) da.queue_draw()
                axis.buildInputRegion(win, smoothedBarMain, revealState())
            }

            if (!active) {
                tickId = null
                return false
            }
            return true
        })
        if (seedFrame && da) da.queue_draw()
    }

    const updateAllTargets = (mousePos: number, seedFrame = true) => {
        if (menuState.openCount > 0) return

        lastMousePos = mousePos
        const draggingId = dragBus.draggingId

        if (draggingId && previewIdx !== -1) {
            const rel = mousePos - lockedStart
            const slotSize = DOCK_CONSTANTS.APP_SLOT
            let targetIdx = Math.floor(rel / slotSize)

            if (previewIdx !== -1) {
                const currentSlotCenter = previewIdx * slotSize + slotSize / 2
                const distToCenter = rel - currentSlotCenter
                if (Math.abs(distToCenter) < slotSize * 0.50) targetIdx = previewIdx
            }

            const total = currentTotalItems || 10
            if (targetIdx < 0) targetIdx = 0
            if (targetIdx > total) targetIdx = total

            if (targetIdx !== previewIdx) {
                previewIdx = targetIdx
                update(true)
            }

            if (targetIdx < 0 || targetIdx > total) dragBus.clearHover()
        }

        animRegistry.forEach((state) => axis.computeTargets(mousePos, state))
        runUnifiedTick(seedFrame)
    }

    const motion = new Gtk.EventControllerMotion()
    win.add_controller(motion)
    motion.connect("enter", () => {
        cursorInDock = true
        clearLeaveTimeout()
        if (dockSettings.autoHide && !isRevealed && !isSettlingIn) {
            setRevealed(true)
            axis.buildInputRegion(win, smoothedBarMain, revealState())
        }
    })
    motion.connect("motion", (_controller, x, y) => {
        if (appGridPanelOpen) return
        if (fullscreenMode) return
        if (dockSettings.autoHide && !isRevealed && !isSettlingIn) {
            setRevealed(true)
            axis.buildInputRegion(win, smoothedBarMain, revealState())
        }

        clearLeaveTimeout()

        if (dragBus.draggingId || isDndEnding) {
            updateAllTargets(axis.mainCoord(x, y))
            return
        }

        if (axis.beyondPill(x, y)) {
            updateAllTargets(-1000)
            return
        }
        updateAllTargets(axis.mainCoord(x, y))
    })

    let leaveTimeout: number | null = null
    const clearLeaveTimeout = () => {
        if (leaveTimeout) { GLib.source_remove(leaveTimeout); leaveTimeout = null }
    }

    motion.connect("leave", () => {
        cursorInDock = false
        if (appGridPanelOpen) return
        if (dragBus.draggingId || isDndEnding) return

        clearLeaveTimeout()
        const magnDelay = 50
        const hideDelay = dockSettings.autoHide ? Math.max(magnDelay, dockSettings.hideDelay) : magnDelay
        leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, magnDelay, () => {
            leaveTimeout = null
            if (isDndEnding || dragBus.draggingId || appGridPanelOpen) return GLib.SOURCE_REMOVE
            updateAllTargets(-1000)
            if (dockSettings.autoHide) {
                if (hideDelay > magnDelay) {
                    leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hideDelay - magnDelay, () => {
                        leaveTimeout = null
                        if (isDndEnding || dragBus.draggingId || menuState.openCount > 0 || appGridPanelOpen) return GLib.SOURCE_REMOVE
                        setRevealed(false)
                        axis.buildInputRegion(win, smoothedBarMain, revealState())
                        return GLib.SOURCE_REMOVE
                    })
                } else {
                    if (menuState.openCount === 0 && !appGridPanelOpen) {
                        setRevealed(false)
                        axis.buildInputRegion(win, smoothedBarMain, revealState())
                    }
                }
            }
            return GLib.SOURCE_REMOVE
        })
    })

    let updateLock = false
    let needsUpdate = false

    const update = (skipTargets = false) => {
        if (updateLock) {
            needsUpdate = true
            return bar
        }
        updateLock = true
        try {
            const currentIconTheme = Theme.iconTheme
            if (currentIconTheme !== lastIconTheme) {
                widgetCache.clear()
                lastIconTheme = currentIconTheme
            }
            if (!tickId && menuState.openCount === 0) runUnifiedTick()

            if (menuState.openCount > 0 || status.isAnyOverlayOpen) {
                needsUpdate = true
                return bar
            }

            needsUpdate = false
            const groupedClients: { [key: string]: { addresses: string[], displayClass: string, title: string } } = {}
            const sortedClients = [...hs.clients].sort((a, b) => a.address.localeCompare(b.address))
            sortedClients.forEach(c => {
                const rawClass = c.class || ""
                const key = appService.resolveHyprlandClass(rawClass)
                if (!key) return
                if (!groupedClients[key]) {
                    groupedClients[key] = { addresses: [], displayClass: rawClass, title: c.title }
                }
                groupedClients[key].addresses.push(c.address)
            })

            const currentGroupKeys = new Set(Object.keys(groupedClients))
            unpinnedOpenOrder.forEach((_, k) => { if (!currentGroupKeys.has(k)) unpinnedOpenOrder.delete(k) })
            currentGroupKeys.forEach(k => { if (!unpinnedOpenOrder.has(k)) unpinnedOpenOrder.set(k, unpinnedSeq++) })

            const draggingId = dragBus.draggingId

            let effectivePinnedList = [...pinnedState.list]
            let runningUnpinnedKeys: string[] = []

            const groupedKeys = Object.keys(groupedClients)
            const nsid = draggingId ? norm(draggingId) : ""

            if (draggingId && previewIdx !== -1) {
                if (draggingId !== lastDraggingId) {
                    lastDraggingId = draggingId
                    const currentPos = pinnedState.list.findIndex(p => norm(p) === nsid)
                    previewIdx = currentPos !== -1 ? currentPos + 2 : (2 + pinnedState.list.length + groupedKeys.length)
                }

                effectivePinnedList = effectivePinnedList.filter(p => norm(p) !== nsid)
                runningUnpinnedKeys = groupedKeys.filter(k => k !== nsid && k !== "home-shortcut" && !pinnedState.list.some(p => { const lid = norm(p); return appMatch(k, lid) }))
                    .sort((a, b) => (unpinnedOpenOrder.get(a) ?? Infinity) - (unpinnedOpenOrder.get(b) ?? Infinity))

                const pinnedBoundary = 2 + effectivePinnedList.length

                if (previewIdx !== -1) {
                    if (previewIdx <= pinnedBoundary) {
                        let insertPos = previewIdx - 2
                        if (insertPos < 0) insertPos = 0
                        if (insertPos > effectivePinnedList.length) insertPos = effectivePinnedList.length
                        effectivePinnedList.splice(insertPos, 0, draggingId)
                    } else {
                        let insertPos = previewIdx - (pinnedBoundary + 1)
                        if (insertPos < 0) insertPos = 0
                        if (insertPos > runningUnpinnedKeys.length) insertPos = runningUnpinnedKeys.length
                        runningUnpinnedKeys.splice(insertPos, 0, nsid)
                    }
                }
            } else {
                lastDraggingId = ""
                runningUnpinnedKeys = groupedKeys.filter(k => k !== "home-shortcut" && !pinnedState.list.some(p => { const lid = norm(p); return appMatch(k, lid) }))
                    .sort((a, b) => (unpinnedOpenOrder.get(a) ?? Infinity) - (unpinnedOpenOrder.get(b) ?? Infinity))
            }

            type ItemConfig = { id: string, width: number, syncData?: any, isPinned: boolean, factory: (vc: number) => Gtk.Widget, isSeparator?: boolean }
            const configs: ItemConfig[] = []
            const currentIds = new Set<string>()

            const getOrCreateItem = (id: string, factory: () => Gtk.Widget) => {
                currentIds.add(id)
                if (widgetCache.has(id)) return widgetCache.get(id)!
                const widget = factory()
                const revealer = new (Gtk as any).Revealer({
                    css_classes: ["cd-revealer"],
                    transition_type: Gtk.RevealerTransitionType.SLIDE_UP,
                    transition_duration: 300,
                    child: widget,
                    reveal_child: firstRender
                })
                revealer.set_overflow(Gtk.Overflow.VISIBLE)
                if (!firstRender) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { revealer.reveal_child = true; return GLib.SOURCE_REMOVE })
                widgetCache.set(id, revealer)
                return revealer
            }

            if (firstRender) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { firstRender = false; return GLib.SOURCE_REMOVE })
            }

            widgetCache.forEach(w => {
                const inner = (w as any).get_child()
                if (inner && (inner as any).popdown) (inner as any).popdown()
            })

            const findApp = (searchId: string) => appService.getResolvedApp(searchId)

            const userName = GLib.get_user_name()
            const prettyName = userName.charAt(0).toUpperCase() + userName.slice(1)

            const homeItem = {
                name: prettyName,
                // Theme-first (resolveIconChain): standard names the active theme
                // ships win; "finder" is only an exotic last resort.
                icon_name: ["system-file-manager", "user-home", "folder-home", "folder", "finder"],
                launch: () => execAsync("xdg-open " + GLib.get_home_dir()).catch(e => { print(e) })
            }
            const homeAddrs = groupedClients["home-shortcut"]?.addresses || []
            configs.push({
                id: "home-shortcut", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: homeAddrs, clientTitle: undefined, appItem: homeItem as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({
                        appId: "home-shortcut", appItem: homeItem as any, updateDock: update,
                        register: (id, s) => animRegistry.set(id, s), addresses: homeAddrs,
                        clientTitle: undefined, onPin, onUnpin, onReorder, isPinned: true, cleanId: "home-shortcut"
                    }, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })
            delete groupedClients["home-shortcut"]

            const launcherItem = {
                name: t("dock.special.launcher.name"),
                // Theme-first: full-color themed grid beats the flat symbolic;
                // our shipped asset only when the theme has neither. ("crys-grid"
                // was a dead name — no such icon exists anywhere.)
                icon_name: ["view-app-grid", "org.gnome.Shell.Apps", "view-app-grid-symbolic",
                    "org.gnome.Shell.Apps-symbolic", iconAssetPath("grid")],
                launch: () => { shellActions.toggleAppGrid?.() }
            }
            configs.push({
                id: "launcher", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: launcherItem as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({
                        appId: "launcher", appItem: launcherItem as any, updateDock: update,
                        register: (id, s) => animRegistry.set(id, s), addresses: [],
                        clientTitle: undefined, onPin, onUnpin, onReorder, isPinned: true, cleanId: "launcher"
                    }, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            effectivePinnedList.filter(id => !!id && !id.startsWith("special:") && id !== "trash" && id !== "launcher").forEach(id => {
                const lid = id.toLowerCase().replace(".desktop", "")
                const originalId = id.replace(".desktop", "")
                let appItem = findApp(id)
                const targetKey = lid
                const groupKey = Object.keys(groupedClients).find(k => appMatch(k, targetKey))
                let addrs: string[] = []
                let clientTitle = undefined

                if (groupKey && groupedClients[groupKey]) {
                    const group = groupedClients[groupKey]
                    addrs = group.addresses
                    clientTitle = group.title
                    delete groupedClients[groupKey]
                    if (!appItem) {
                        appItem = { name: clientTitle || group.displayClass, icon_name: originalId || group.displayClass || lid, launch: getLaunch(lid) } as any
                    }
                    if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                        if (typeof appItem.icon_name === "string") appItem.icon_name = appItem.icon_name.replace(/-default$/i, "-Default")
                    }
                }

                if (appItem) {
                    if (lid.startsWith("chrome-") && lid.endsWith("-default")) {
                        // @ts-ignore
                        appItem.icon_name = originalId.replace(/-default$/i, "-Default")
                    }
                    if (lid === "nidara-settings") {
                        appItem.launch = () => { shellActions.openSettings?.() }
                    } else {
                        appItem.launch = getLaunch(lid)
                    }
                    configs.push({
                        id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                        syncData: { addrs, clientTitle, appItem: appItem! },
                        isPinned: true,
                        factory: (vc) => {
                            const w = DockItem({
                                appId: lid, appItem: appItem!, updateDock: update,
                                register: (id, s) => animRegistry.set(id, s), addresses: addrs,
                                clientTitle, onPin, onUnpin, onReorder, isPinned: true, cleanId: lid
                            }, bar)
                            if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                            return w
                        }
                    })
                } else {
                    const info = appService.getAppInfo(lid)
                    const displayName = info?.get_name() || lid
                    let icon = info?.get_id() || originalId
                    if (lid.startsWith("chrome-") && lid.endsWith("-default") && typeof icon === "string") {
                        icon = icon.replace(/-default$/i, "-Default")
                    }
                    const ghostLaunch = lid === "nidara-settings"
                        ? () => { shellActions.openSettings?.() }
                        : getLaunch(lid)
                    const ghost = { name: displayName, icon_name: icon, launch: ghostLaunch } as any
                    configs.push({
                        id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                        syncData: { addrs: [], clientTitle: undefined, appItem: ghost },
                        isPinned: true,
                        factory: (vc) => {
                            const w = DockItem({
                                appId: lid, appItem: ghost, updateDock: update,
                                register: (id, s) => animRegistry.set(id, s), addresses: [],
                                clientTitle: undefined, onPin, onUnpin, onReorder, isPinned: true, cleanId: lid
                            }, bar)
                            if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                            return w
                        }
                    })
                }
            })

            if (runningUnpinnedKeys.length > 0) {
                const separatorId = "sep-running"
                configs.push({
                    id: separatorId, width: DOCK_CONSTANTS.SEPARATOR_SLOT,
                    syncData: { addrs: [], clientTitle: undefined, appItem: undefined },
                    isPinned: true, isSeparator: true,
                    factory: (vc) => {
                        const w = Separator(separatorId, update, (id, s) => animRegistry.set(id, s), onReorder)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            }

            runningUnpinnedKeys.forEach(k => {
                const group = groupedClients[k]
                const lid = k.toLowerCase().replace(".desktop", "")
                let appItem = findApp(lid) || findApp(group?.displayClass || "")
                if (!appItem) {
                    appItem = { name: group?.title || group?.displayClass || k, icon_name: lid, launch: getLaunch(lid) } as any
                }
                if (lid === "nidara-settings") appItem.launch = () => { shellActions.openSettings?.() }

                configs.push({
                    id: lid, width: DOCK_CONSTANTS.APP_SLOT,
                    syncData: { addrs: group?.addresses || [], clientTitle: group?.title, appItem: appItem! },
                    isPinned: false,
                    factory: (vc) => {
                        const w = DockItem({
                            appId: lid, appItem: appItem!, updateDock: update,
                            register: (id, s) => animRegistry.set(id, s), addresses: group?.addresses || [],
                            clientTitle: group?.title, onPin, onUnpin, onReorder, isPinned: false, cleanId: lid
                        }, bar)
                        if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                        return w
                    }
                })
            })

            configs.push({
                id: "sep-trash", width: DOCK_CONSTANTS.SEPARATOR_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: undefined },
                isPinned: true, isSeparator: true,
                factory: (vc) => {
                    const w = Separator("sep-trash", update, (id, s) => animRegistry.set(id, s), onReorder)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            const trash = {
                name: t("dock.special.trash.name"),
                // Initial chain only — once created, DockItem keeps the icon in sync
                // with trash contents via TrashService (full ↔ empty, in place).
                // Theme-first; our shipped asset only when the theme has no trash at all.
                icon_name: trashService.isEmpty
                    ? ["user-trash", "trashcan-empty", "trash", iconAssetPath("trash")]
                    : ["user-trash-full", "trashcan-full", "user-trash", "trash", iconAssetPath("trash")],
                launch: () => execAsync("nautilus trash:///").catch(print)
            }
            configs.push({
                id: "special:trash", width: DOCK_CONSTANTS.APP_SLOT,
                syncData: { addrs: [], clientTitle: undefined, appItem: trash as any },
                isPinned: true,
                factory: (vc) => {
                    const w = DockItem({
                        appId: "special:trash", appItem: trash as any, updateDock: update,
                        register: (id, s) => animRegistry.set(id, s), addresses: [],
                        clientTitle: undefined, onPin: () => {}, onUnpin: () => {}, onReorder: () => {},
                        isPinned: true, cleanId: "special:trash"
                    }, bar)
                    if ((w as any).setVirtualCenter) (w as any).setVirtualCenter(vc)
                    return w
                }
            })

            const processed = new Set<string>()
            const validConfigs = configs.filter(c => {
                if (processed.has(c.id)) return false
                processed.add(c.id); return true
            })

            const _slideOldPos = new Map<string, number>()
            const _slideOldSet = new Set(orderedIds)
            let _slideAccOld = 0
            orderedIds.forEach(id => {
                _slideOldPos.set(id, _slideAccOld)
                const s = animRegistry.get(id)
                _slideAccOld += s ? (s.currentWidth + s.currentMargin * 2) : DOCK_CONSTANTS.APP_SLOT
            })

            orderedIds = validConfigs.map(c => c.id)
            currentTotalItems = validConfigs.length

            totalStaticMain = validConfigs.reduce((sum, c) => sum + (c.width || DOCK_CONSTANTS.APP_SLOT), 0)

            const axisStart = axis.mainStart(totalStaticMain)
            let runningAxis = axisStart

            const finalItems = validConfigs.map((c) => {
                const slotWidth = c.width || DOCK_CONSTANTS.APP_SLOT
                const myCenter = runningAxis + (slotWidth / 2)
                runningAxis += slotWidth

                const widget = getOrCreateItem(c.id, () => c.factory(myCenter))
                const state = animRegistry.get(c.id)
                if (state) state.staticCenter = myCenter

                const inner = (widget as any).get_child ? (widget as any).get_child() : widget
                if (inner && (inner as any).setVirtualCenter) (inner as any).setVirtualCenter(myCenter)
                if (inner && (inner as any).syncState && (c as any).syncData) {
                    const d = (c as any).syncData
                    ;(inner as any).syncState(d.addrs, d.clientTitle, d.appItem, c.isPinned)
                }
                return widget
            })

            for (const [id] of widgetCache) {
                if (!currentIds.has(id)) {
                    widgetCache.delete(id)
                    animRegistry.delete(id)
                }
            }

            let _slideAccNew = 0
            orderedIds.forEach(id => {
                const s = animRegistry.get(id)
                const newX = _slideAccNew
                _slideAccNew += s ? (s.currentWidth + s.currentMargin * 2) : DOCK_CONSTANTS.APP_SLOT
                if (!s || !_slideOldSet.has(id)) return
                const oldX = _slideOldPos.get(id)
                if (oldX === undefined) return
                const disp = oldX - newX
                if (Math.abs(disp) > 1) {
                    s.currentSlideX = (s.currentSlideX || 0) + disp
                    s.velocitySlideX = 0
                    s.targetSlideX = 0
                    if (!tickId) runUnifiedTick()
                }
            })

            let currentChild = bar.get_first_child()
            let prevSibling: Gtk.Widget | null = null
            finalItems.forEach(item => {
                if (currentChild !== item) {
                    if (item.get_parent() === bar) {
                        (bar as any).reorder_child_after(item, prevSibling)
                    } else {
                        if (item.get_parent()) item.unparent()
                        bar.insert_child_after(item, prevSibling)
                    }
                }
                prevSibling = item
                currentChild = item ? (item as any).get_next_sibling() : null
            })

            const finalSet = new Set(finalItems)
            let c = bar.get_first_child()
            while (c) {
                const next = c.get_next_sibling()
                if (!finalSet.has(c)) bar.remove(c)
                c = next
            }

            // Pre-apply rest/target layout so the first frame starts correct.
            let totalCurrentMain = 0
            orderedIds.forEach((id) => {
                const state = animRegistry.get(id)
                if (!state) return
                axis.computeTargets(lastMousePos, state)

                if (firstRender || !tickId) {
                    state.currentScale = state.targetScale
                    state.currentWidth = state.targetWidth
                    state.currentMargin = state.targetMargin
                    if (!state.isSeparator) axis.preSizeRestItem(widgetCache.get(id))
                }
                totalCurrentMain += state.currentWidth + (state.currentMargin * 2)
            })

            if (firstRender || !tickId) {
                smoothedBarMain = totalCurrentMain
                axis.centerBar(smoothedBarMain)
                axis.updateSize(smoothedBarMain)
                firstRender = false
            }

            if (!tickId) runUnifiedTick()
            if (!skipTargets) updateAllTargets(lastMousePos, false)
            axis.updateSize(smoothedBarMain)
            if (layerShellReady && !dockSettings.autoHide) {
                axis.setExclusiveZone(win, DOCK_CONSTANTS.EXCLUSIVE_ZONE)
            }
            return bar
        } catch (e) {
            console.error("[Dock] Update error:", e)
            return bar
        } finally {
            updateLock = false
            if (needsUpdate) {
                needsUpdate = false
                GLib.timeout_add(GLib.PRIORITY_LOW, 100, () => { update(); return GLib.SOURCE_REMOVE })
            }
        }
    }

    win.set_default_size(WIN_W, WIN_H)
    let layerInit = false
    try {
        Gtk4LayerShell.init_for_window(win)
        layerInit = true
    } catch (e) {
        console.warn("Gtk4LayerShell init failed (not on Wayland?): " + e)
    }
    win.set_size_request(WIN_W, WIN_H)
    win.set_decorated(false)

    try {
        // @ts-ignore
        win.app_paintable = true
        // @ts-ignore
        win.input_shape_combine_region?.(null)
    } catch (e) {}

    if (layerInit) {
        try {
            Gtk4LayerShell.set_namespace(win, "nidara-dock")
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)

            axis.setupAnchors(win)

            layerShellReady = true
            axis.setExclusiveZone(win, dockSettings.autoHide ? 0 : DOCK_CONSTANTS.EXCLUSIVE_ZONE)

            if (dockSettings.autoHide) {
                axis.applySlide(win, Math.round(slideCurrent))
            }

            win.connect("realize", () => {
                let total = totalStaticMain
                if (orderedIds.length > 0) {
                    total = 0
                    orderedIds.forEach(id => {
                        const s = animRegistry.get(id)
                        if (s) total += s.currentWidth + (s.currentMargin * 2)
                    })
                }
                axis.buildInputRegion(win, total, revealState())
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    isSettlingIn = false
                    return GLib.SOURCE_REMOVE
                })
                // Startup race: the dock can map before the bar's top exclusive zone is
                // honored, so it loads at y=0 until a later re-commit. The bar zone is
                // registered before the dock (Bar created before Dock in app.ts), so
                // force a fresh layer-surface configure as early as possible — here, at
                // realize, BEFORE first map — so the dock appears already at its correct
                // y=BAR_HEIGHT position rather than visibly dropping later. One delayed
                // retry covers the case the zone wasn't yet committed at first map.
                // No-op on the horizontal axis. See axis.forceReflow.
                if (layerShellReady) axis.forceReflow(win)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    if (layerShellReady) axis.forceReflow(win)
                    return GLib.SOURCE_REMOVE
                })
            })
        } catch (e) { console.error(e) }
    }

    let updateTimer: number | null = null
    const throttledUpdate = () => {
        if (updateTimer) GLib.source_remove(updateTimer)
        updateTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            update(); updateTimer = null; return GLib.SOURCE_REMOVE
        })
    }

    const DOCK_PERMANENT_IDS = new Set(["home-shortcut", "launcher", "trash", "nidara-settings"])

    const pruneOrphanedPins = () => {
        const before = pinnedState.list.length
        pinnedState.list = pinnedState.list.filter(id => {
            if (!id || id.startsWith("special:")) return true
            if (DOCK_PERMANENT_IDS.has(id.toLowerCase())) return true
            const found = !!appService.getAppInfo(id)
            if (!found) console.log(`[Dock] Pruning orphaned pin: "${id}" (not found in AppService)`)
            return found
        })
        if (pinnedState.list.length < before) savePinned()
    }

    const cConn = hs.connect("changed", throttledUpdate)
    const aConn = appService.connect(throttledUpdate)
    const appStructConn = appService.connectStructural(pruneOrphanedPins)
    const pinnedConn = onPinnedChanged(throttledUpdate)

    const overlayRecovery = () => { if (!status.isAnyOverlayOpen && needsUpdate) throttledUpdate() }
    const statusConns = [
        status.connect("notify::cc-open", overlayRecovery),
        status.connect("notify::nc-open", overlayRecovery),
        status.connect("notify::prism-open", overlayRecovery),
        status.connect("notify::system-menu-open", overlayRecovery),
        status.connect("notify::overview-open", overlayRecovery),
    ]

    const pConn = pointerBus.onButtonReleased(() => {
        isDndEnding = true
        GLib.timeout_add(GLib.PRIORITY_HIGH, 700, () => { isDndEnding = false; return GLib.SOURCE_REMOVE })
    })

    const mConn = onMenuCountChanged((count) => {
        if (count !== 0) return
        updateAllTargets(-1000)
        runUnifiedTick(true)
        if (dockSettings.autoHide && isRevealed) {
            clearLeaveTimeout()
            leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, dockSettings.hideDelay, () => {
                leaveTimeout = null
                if (menuState.openCount > 0 || isDndEnding || dragBus.draggingId) return GLib.SOURCE_REMOVE
                setRevealed(false)
                axis.buildInputRegion(win, smoothedBarMain, revealState())
                return GLib.SOURCE_REMOVE
            })
        }
    })

    // Drag-end cleanup timers are tracked so a new drag started inside their
    // window (200–400ms) can cancel them — otherwise a leftover timer flips
    // dndActive/isDndEnding mid-drag ("drag sometimes doesn't magnify").
    let pendingDragTimers: number[] = []
    const addDragTimer = (priority: number, ms: number, fn: () => void) => {
        const id = GLib.timeout_add(priority, ms, () => {
            pendingDragTimers = pendingDragTimers.filter(t => t !== id)
            fn()
            return GLib.SOURCE_REMOVE
        })
        pendingDragTimers.push(id)
    }
    const clearPendingDragTimers = () => {
        for (const id of pendingDragTimers) { try { GLib.source_remove(id) } catch (e) {} }
        pendingDragTimers = []
    }

    const dConn = dragBus.subscribe((draggingId) => {
        if (draggingId) {
            clearPendingDragTimers()
            isDndEnding = false
            dndActive = true

            const nsid = norm(draggingId)
            let virtualPinned = [...pinnedState.list]
            if (!virtualPinned.some(p => norm(p) === nsid)) virtualPinned.push(draggingId)
            lockedStaticMain = calculateStableMain(virtualPinned)
            lockedStart = axis.mainStart(lockedStaticMain)

            const currentIdx = pinnedState.list.findIndex(p => norm(p) === nsid)
            if (currentIdx !== -1) previewIdx = currentIdx + 2
            else previewIdx = 2 + pinnedState.list.length
            throttledUpdate()
        } else {
            if (previewIdx >= 0 && lastDraggingId && lastMousePos >= 0) {
                onReorder(lastDraggingId)
            } else {
                previewIdx = -1
                isDndEnding = true
                update()
                addDragTimer(GLib.PRIORITY_HIGH, 400, () => { isDndEnding = false })
            }

            addDragTimer(GLib.PRIORITY_HIGH, 200, () => { dndActive = false })

            addDragTimer(GLib.PRIORITY_DEFAULT, 300, () => {
                if (!dragBus.draggingId) {
                    lastDraggingId = ""
                    previewIdx = -1
                    if (lastMousePos < 0) updateAllTargets(-1000)
                    update()
                }
            })
        }
    })

    const sConn = onDockSettingsChanged(() => {
        syncConstants()
        // Snap all spring states to the new DOCK_CONSTANTS immediately — no widget
        // destruction, no flash. The tick applies the new dimensions next frame.
        animRegistry.forEach((state) => {
            if (state.isSeparator) {
                state.targetWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.currentWidth = DOCK_CONSTANTS.SEPARATOR_SLOT; state.velocityWidth = 0
                state.targetHeight = DOCK_CONSTANTS.SEPARATOR_HEIGHT; state.currentHeight = DOCK_CONSTANTS.SEPARATOR_HEIGHT; state.velocityHeight = 0
            } else {
                state.targetScale = 1.0; state.currentScale = 1.0; state.velocityScale = 0
                state.targetWidth = DOCK_CONSTANTS.ICON_SIZE; state.currentWidth = DOCK_CONSTANTS.ICON_SIZE; state.velocityWidth = 0
                state.targetMargin = DOCK_CONSTANTS.ICON_MARGIN; state.currentMargin = DOCK_CONSTANTS.ICON_MARGIN; state.velocityMargin = 0
                state.targetHeight = DOCK_CONSTANTS.PILL_HEIGHT; state.currentHeight = DOCK_CONSTANTS.PILL_HEIGHT; state.velocityHeight = 0
            }
        })
        if (!isRevealed) { slideTarget = axis.hideDistance; slideCurrent = axis.hideDistance }
        win.set_size_request(WIN_W, WIN_H)
        axis.onSettingsResize()
        if (layerShellReady) {
            axis.applySlide(win, Math.round(slideCurrent))
            const zone = dockSettings.autoHide ? (isRevealed ? DOCK_CONSTANTS.EXCLUSIVE_ZONE : 0) : DOCK_CONSTANTS.EXCLUSIVE_ZONE
            axis.setExclusiveZone(win, zone)
            // applySlide just moved the surface to the new gap-derived position, but the tick
            // short-circuits (return false) when nothing is animating — and a gap change leaves
            // both the bar-size and slide-delta conditions false, so it would NEVER rebuild the
            // input region. The region would stay frozen at the OLD position while the surface
            // moved, drifting the autohide edge-trigger off the screen wall (worse the more the
            // gap changes). Rebuild it here explicitly instead of relying on the tick.
            axis.buildInputRegion(win, smoothedBarMain, revealState())
        }
        update()
    })

    win.connect("destroy", () => {
        if (tickId) { bar.remove_tick_callback(tickId); tickId = null }
        if (updateTimer) { GLib.source_remove(updateTimer); updateTimer = null }
        if (leaveTimeout) { GLib.source_remove(leaveTimeout); leaveTimeout = null }
        clearPendingDragTimers()
        if (cConn) safeDisconnect(hs, cConn)
        safeDisconnect(Theme, themeConn)
        for (const id of statusConns) safeDisconnect(status, id)
        try { if (aConn) aConn() } catch (e) {}
        try { if (pConn) pConn() } catch (e) {}
        try { if (dConn) dConn() } catch (e) {}
        try { if (sConn) sConn() } catch (e) {}
        try { if (mConn) mConn() } catch (e) {}
        try { appStructConn() } catch (e) {}
        try { pinnedConn() } catch (e) {}
    })

    ;(win as any).setLauncherMode = (active: boolean) => {
        if (!layerShellReady) return
        if (active) {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
            if (dockSettings.autoHide && !isRevealed) {
                isRevealed = true
                slideTarget = 0
                runUnifiedTick(true)
            }
        } else {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            axis.buildInputRegion(win, smoothedBarMain, revealState())
            if (dockSettings.autoHide && !cursorInDock) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    if (!cursorInDock && menuState.openCount === 0) {
                        setRevealed(false)
                        axis.buildInputRegion(win, smoothedBarMain, revealState())
                    }
                    return GLib.SOURCE_REMOVE
                })
            }
        }
    }

    // ── Embedded AppGrid panel ────────────────────────────────────────────────
    const appGrid = AppGridPanel(gdkmonitor, () => closeAppGridPanel())

    appGrid.setKeyboardModeCallback(
        () => { if (layerShellReady) Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE) },
        () => { if (layerShellReady) Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND) }
    )

    appGrid.widget.visible = false
    appGrid.widget.halign  = Gtk.Align.CENTER
    appGrid.widget.valign  = Gtk.Align.CENTER
    windowOverlay.add_overlay(appGrid.widget)

    const openAppGridPanel = () => {
        if (appGridPanelOpen) return
        clearLeaveTimeout()
        appGridPanelOpen = true
        win.set_focusable(true)
        win.set_focus_visible(true)
        if (layerShellReady) {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.EXCLUSIVE)
        }
        appGrid.setVisible(true)
        appGrid.onShow()
        // Send the icons back to rest: the panel opens with the cursor still over the
        // launching icon (magnified), and motion is ignored while the panel is open, so
        // they'd otherwise stay frozen mid-bulge. Same as launching any app.
        updateAllTargets(-1000)
        const surface = win.get_native()?.get_surface()
        if (surface) surface.set_input_region(null)
        if (!isRevealed) {
            setRevealed(true)
            runUnifiedTick(true)
        }
    }

    const closeAppGridPanel = () => {
        if (!appGridPanelOpen) return
        appGridPanelOpen = false
        appGrid.setVisible(false)
        appGrid.setActive(false)
        win.set_focus(null)
        win.set_focusable(false)
        win.set_focus_visible(false)
        if (layerShellReady) {
            Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
            Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
            axis.setExclusiveZone(win, (isRevealed && !dockSettings.autoHide) ? DOCK_CONSTANTS.EXCLUSIVE_ZONE : 0)
        }
        if (fullscreenMode && !cursorInDock) {
            setRevealed(false)
        } else if (dockSettings.autoHide && !cursorInDock) {
            setRevealed(false)
        }
        axis.buildInputRegion(win, smoothedBarMain, revealState())
    }

    ;(win as any).toggleAppGridPanel = () => {
        if (appGridPanelOpen) closeAppGridPanel()
        else openAppGridPanel()
    }
    // Read-only mirror of the panel state for dumpState (the app grid lives in the
    // dock, not Status.ts, so this is how IPC observes whether it's open).
    ;(win as any).isAppGridPanelOpen = () => appGridPanelOpen

    const bgClickGesture = new Gtk.GestureClick()
    bgClickGesture.set_propagation_phase(Gtk.PropagationPhase.BUBBLE)
    bgClickGesture.connect("released", (_gesture: any, _n: number, x: number, y: number) => {
        if (!appGridPanelOpen) return
        const a = appGrid.widget.get_allocation()
        const inSquircle  = x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height
        const inDockStrip = axis.inDockStrip(x, y)
        if (!inSquircle && !inDockStrip) closeAppGridPanel()
    })
    windowOverlay.add_controller(bgClickGesture)

    const appGridKeyCtrl = new Gtk.EventControllerKey()
    appGridKeyCtrl.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    appGridKeyCtrl.connect("key-pressed", (_c: any, keyval: number) => {
        if (!appGridPanelOpen) return false
        return appGrid.handleKey(keyval)
    })
    win.add_controller(appGridKeyCtrl)

    // ── Fullscreen detection ──────────────────────────────────────────────────
    let trackedClient: any = null
    let trackedClientConn: number | null = null

    const setFullscreenMode = (active: boolean) => {
        if (fullscreenMode === active) return
        fullscreenMode = active
        if (active && !appGridPanelOpen) {
            if (isRevealed) setRevealed(false)
            axis.buildInputRegion(win, smoothedBarMain, revealState())
        } else if (!active) {
            if (!dockSettings.autoHide || cursorInDock) {
                setRevealed(true)
                runUnifiedTick(true)
            }
            axis.buildInputRegion(win, smoothedBarMain, revealState())
        }
    }

    const checkFullscreen = () => {
        const client = hs.focusedClient ?? null
        if (client !== trackedClient) {
            if (trackedClient && trackedClientConn !== null) {
                safeDisconnect(trackedClient, trackedClientConn)
                trackedClientConn = null
            }
            trackedClient = client
            if (client) {
                trackedClientConn = client.connect("notify::fullscreen", () =>
                    setFullscreenMode(client.fullscreen ?? false))
            }
        }
        setFullscreenMode(client ? (client.fullscreen ?? false) : false)
    }

    hs.connect("changed", checkFullscreen)
    checkFullscreen()

    update()

    win.present()

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        win.set_focus_visible(false)
        win.set_focus(null)
        return GLib.SOURCE_REMOVE
    })

    return win
}
