/**
 * MiDistroIA Dock - Separator Component
 * V106: Extracted from Dock.tsx
 */

import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import {
    DOCK_CONSTANTS,
    getPinnedList,
    setPinnedList,
    savePinned,
    AnimState
} from "./state"

/**
 * Separator Component
 * Acts as visual divider between pinned and running apps.
 * Also serves as drop target to append items to pinned list.
 */
export function Separator(
    id: string,
    updateDock: () => void,
    register: (id: string, s: AnimState) => void,
    height = 48
): Gtk.Box {
    const baseWidth = DOCK_CONSTANTS.SEPARATOR_SLOT

    // Container for Hitbox (invisible, wide, fixed height)
    const box = new Gtk.Box({
        css_classes: ["cd-separator-container"],
        valign: Gtk.Align.END,
        halign: Gtk.Align.CENTER,
        width_request: baseWidth,
        height_request: 92,
        hexpand: false,
        margin_bottom: 0,
    })

    // Visible Line
    const line = new Gtk.Box({
        name: "cd-separator",
        css_classes: ["cd-separator"],
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
        width_request: DOCK_CONSTANTS.SEPARATOR_LINE,
        height_request: height,
        hexpand: false,
        margin_start: DOCK_CONSTANTS.SEPARATOR_OFFSET
    })

    box.append(line)

    // Animation state
    const state: AnimState = {
        targetScale: 1.0,
        currentScale: 1.0,
        targetWidth: baseWidth,
        currentWidth: baseWidth,
        targetMargin: 0,
        currentMargin: 0,
        staticCenter: 0,
        virtualCenter: 0,
        isSeparator: true
    }
    register(id, state)

        // Expose virtual center update
        ; (box as any).setVirtualCenter = (v: number) => {
            if (Math.abs(state.staticCenter - v) < 0.1) return
            state.virtualCenter = v
            state.staticCenter = v
        }

    // Drop target - dropping on separator appends to pinned list
    const target = new Gtk.DropTarget({
        actions: Gdk.DragAction.COPY | Gdk.DragAction.MOVE,
        formats: null
    })
    target.set_gtypes([GObject.TYPE_STRING])

    target.connect("enter", () => Gdk.DragAction.COPY)

    target.connect("drop", (t, val) => {
        let sourceId = ""
        if (typeof val === "string") {
            sourceId = val
        } else if (val && (val as any).get_string) {
            sourceId = (val as unknown as GObject.Value).get_string()
        }

        if (!sourceId || sourceId === "void") return false

        // Remove existing and append to end
        let pinnedList = getPinnedList().filter(p => p.toLowerCase() !== sourceId)
        pinnedList.push(sourceId)
        setPinnedList(pinnedList)
        savePinned()
        updateDock()
        return true
    })

    box.add_controller(target)
    return box
}
