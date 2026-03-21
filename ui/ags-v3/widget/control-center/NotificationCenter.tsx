import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { drawSquircle } from "../common/DrawingUtils"
import SquircleContainer from "../common/SquircleContainer"
import Gio from "gi://Gio"
import appService from "../../core/AppService"
import status from "../../core/Status"

export function createIconWidget(n: AstalNotifd.Notification, size: number) {
    const entry = n.desktop_entry || n.app_name || ""
    const app = appService.getResolvedApp(entry)
    
    const img = new Gtk.Image({
        pixel_size: size,
        halign: Gtk.Align.START,
        valign: Gtk.Align.CENTER
    })

    if (app) {
        const icon = app.icon_name || app.get_icon()
        if (typeof icon === "string") {
            if (icon.startsWith("/") || icon.startsWith("file://")) {
                img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(icon.replace("file://", "")))
            } else img.icon_name = icon
        } else if (icon) img.gicon = icon
    } else {
        const fallback = appService.getIconName(n.app_icon || n.app_name)
        if (fallback?.startsWith("/") || fallback?.startsWith("file://")) {
            img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(fallback.replace("file://", "")))
        } else img.icon_name = fallback || "dialog-information-symbolic"
    }
    return img
}

function timeAgo(time: number) {
    const now = Math.floor(Date.now() / 1000)
    const diff = now - time
    if (diff < 60) return "ahora"
    if (diff < 3600) return `${Math.floor(diff / 60)}m`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`
    return `${Math.floor(diff / 86400)}d`
}

interface CapsuleProps {
    n: AstalNotifd.Notification
    groupCount?: number
    isCollapsed?: boolean
    onToggle?: () => void
    onClearGroup?: () => void
    isPopup?: boolean
}

/**
 *  NotificationCapsule: SYMMETRIC TAUTNESS (v39)
 * - Symmetry: 16px Left/Right 💎
 * - Architecture: Buttons moved to TOP row (Tahoe style).
 * - Gap: 12px Spacing 
 * - Rigidity: 80px UNIFORM
 */
export function NotificationCapsule(props: CapsuleProps) {
    const { n, groupCount = 1, isCollapsed = false, onToggle, onClearGroup, isPopup = false } = props
    const iconSize = 44

    const sanitize = (text: string) => (text || "")
        .replace(/<[^>]*>/g, "")
        .split("\n").join(" ")
        .replace(/\s+/g, " ")
        .trim()

    const cleanSummary = sanitize(n.summary)
    const cleanBody = sanitize(n.body)

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,      // Professional 12px gap 💎
        margin_start: 16, // Clean 16px Left 
        margin_end: 16,   // Clean 16px Right (Buttons)
        margin_top: 12,
        margin_bottom: 12,
        valign: Gtk.Align.CENTER,
        height_request: 56, 
        vexpand: false, hexpand: true,
        overflow: Gtk.Overflow.HIDDEN
    })

    const iconWidget = createIconWidget(n, iconSize)
    box.append(iconWidget)

    const textStack = new Gtk.Box({ 
        orientation: Gtk.Orientation.VERTICAL, 
        valign: Gtk.Align.CENTER, 
        vexpand: false, hexpand: true,
        height_request: 56,
        overflow: Gtk.Overflow.HIDDEN
    })
    
    // Header Row: [Summary] [Time] [Badge] [Actions]
    const header = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, hexpand: true })
    
    header.append(new Gtk.Label({ 
        label: cleanSummary, 
        css_classes: ["cc-atomic-label-bold"], 
        halign: Gtk.Align.START, 
        ellipsize: 3, 
        lines: 1,
        hexpand: true,
        xalign: 0
    }))
    
    if (!isPopup) {
        header.append(new Gtk.Label({ 
            label: timeAgo(n.time), 
            css_classes: ["nc-item-time"], 
            halign: Gtk.Align.END 
        }))

        if (groupCount > 1 && isCollapsed) {
            header.append(new Gtk.Label({
                label: `${groupCount}`,
                css_classes: ["nc-badge-header"],
                valign: Gtk.Align.CENTER
            }))
        }
    }
    
    // Actions Box: Top Row Integration 💎
    const actions = new Gtk.Box({ 
        orientation: Gtk.Orientation.HORIZONTAL,
        valign: Gtk.Align.CENTER, 
        spacing: 4,
        halign: Gtk.Align.END
    })

    const clearBtn = new Gtk.Button({
        child: new Gtk.Image({ icon_name: "window-close-symbolic", pixel_size: 11 }),
        css_classes: ["nc-item-clear-btn-compact"]
    })
    clearBtn.connect("clicked", () => {
        if (groupCount > 1 && isCollapsed && onClearGroup) onClearGroup()
        else n.dismiss()
    })
    actions.append(clearBtn)

    if (groupCount > 1 && onToggle) {
        const expandBtn = new Gtk.Button({
            child: new Gtk.Image({ icon_name: isCollapsed ? "pan-down-symbolic" : "pan-up-symbolic", pixel_size: 11 }),
            css_classes: ["nc-item-expand-btn-compact"]
        })
        expandBtn.connect("clicked", onToggle)
        actions.append(expandBtn)
    }
    header.append(actions)

    const bodyLabel = new Gtk.Label({ 
        label: cleanBody, 
        css_classes: ["cc-atomic-label-dim"], 
        halign: Gtk.Align.START, 
        ellipsize: 3, 
        lines: 2,
        wrap: true,
        xalign: 0,
        hexpand: true,
        max_width_chars: 40 // 💎 LIMIT
    })

    textStack.append(header)
    if (n.body) textStack.append(bodyLabel)
    box.append(textStack)

    const container = SquircleContainer({
        child: box,
        radius: 40,
        n: 3.2,
        alpha: 0.15,
        gloss: true,
        shape: 2, // CAPSULE
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
        css_classes: ["nc-capsule-item"],
        padding: undefined, // 🚫 NO SABOTAGE
        vexpand: false, hexpand: false
    })

    container.height_request = 80 
    return container
}

export default function NotificationCenter() {
    const notifd = AstalNotifd.get_default()

    const overlay = new Gtk.Overlay({
        css_classes: ["nc-window-root", "nc-overlay"],
        hexpand: true,
        vexpand: true
    })

    const catcher = new Gtk.Box({ hexpand: true, vexpand: true })
    overlay.set_child(catcher)
    const clickGesture = new Gtk.GestureClick()
    clickGesture.connect("pressed", () => {
        status.nc_open = false
    })
    catcher.add_controller(clickGesture)

    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12, 
        css_classes: ["notification-center-panel"],
        vexpand: true,
        hexpand: true
    })

    const ncContainer = new Gtk.Box({
        css_classes: ["cc-islands-container"],
        hexpand: true,
        vexpand: true
    })
    ncContainer.append(contentBox)

    ncContainer.halign = Gtk.Align.FILL
    ncContainer.valign = Gtk.Align.FILL
    ncContainer.margin_top = 8
    ncContainer.margin_end = 8
    ncContainer.margin_bottom = 8
    ncContainer.margin_start = 8
    ncContainer.hexpand = true
    ncContainer.vexpand = true

    overlay.add_overlay(ncContainer)

    const calendar = new Gtk.Calendar({
        hexpand: true,
        css_classes: ["nc-calendar"]
    })

    const calendarIsland = SquircleContainer({
        child: calendar,
        radius: 32,
        n: 3.2,
        gloss: true,
        alpha: 0.15,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
        css_classes: ["cc-island", "nc-calendar-island"],
        onClick: () => {
            GLib.spawn_command_line_async("gnome-calendar")
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                GLib.spawn_command_line_async("hyprctl dispatch focuswindow class:gnome-calendar || hyprctl dispatch focuswindow class:org.gnome.Calendar")
                return GLib.SOURCE_REMOVE
            })
            status.nc_open = false
        }
    })
    contentBox.append(calendarIsland)

    const notifContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 16,
        margin_start: 16,
        margin_end: 16,
        margin_bottom: 16,
        vexpand: true
    })

    const header = new Gtk.Box({ spacing: 12, css_classes: ["nc-header"] })
    header.append(new Gtk.Label({ label: "Notificaciones", css_classes: ["nc-title"], hexpand: true, halign: Gtk.Align.START }))
    const clear = new Gtk.Button({ label: "Borrar", css_classes: ["nc-clear-btn"] })
    header.append(clear)
    notifContent.append(header)

    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vexpand: true,
        css_classes: ["nc-scroll"]
    })
    notifContent.append(scroll)

    const notifList = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ["nc-list"],
        halign: Gtk.Align.FILL,
        hexpand: true
    })
    scroll.set_child(notifList)

    const notificationsIsland = SquircleContainer({
        child: notifContent,
        radius: 32,
        n: 3.2,
        alpha: 0.15,
        gloss: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
        css_classes: ["cc-island", "nc-history-island"],
        vexpand: true
    })
    contentBox.append(notificationsIsland)

    const collapsedGroups = new Set<string>()
    let firstUpdate = true

    const updateNotifs = () => {
        while (notifList.get_first_child()) {
            notifList.get_first_child()?.unparent()
        }

        const notifications = notifd.notifications
        if (notifications.length === 0) {
            notifList.append(new Gtk.Label({
                label: "No hay notificaciones",
                css_classes: ["nc-empty"],
                halign: Gtk.Align.CENTER,
                margin_top: 32
            }))
            return
        }

        const groups = new Map<string, AstalNotifd.Notification[]>()
        notifications.forEach(n => {
            const entry = n.desktop_entry || n.app_name || ""
            const app = appService.getResolvedApp(entry)
            const id = app?.id || entry || "unknown"
            
            const list = groups.get(id) || []
            list.push(n)
            groups.set(id, list)
        })

        if (firstUpdate) {
            groups.forEach((_, id) => collapsedGroups.add(id))
            firstUpdate = false
        }

        const sortedGroupIds = Array.from(groups.keys()).sort((a, b) => {
            const newestA = Math.max(...groups.get(a)!.map(n => n.time))
            const newestB = Math.max(...groups.get(b)!.map(n => n.time))
            return newestB - newestA
        })

        sortedGroupIds.forEach(id => {
            const groupList = groups.get(id)!
            groupList.sort((a, b) => b.time - a.time)

            const groupContainer = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
                margin_bottom: 12
            })

            const isCollapsed = collapsedGroups.has(id)
            const onToggle = () => {
                if (collapsedGroups.has(id)) collapsedGroups.delete(id)
                else collapsedGroups.add(id)
                updateNotifs()
            }

            const onClearGroup = () => groupList.forEach(n => n.dismiss())

            if (isCollapsed) {
                groupContainer.append(NotificationCapsule({
                    n: groupList[0],
                    groupCount: groupList.length,
                    isCollapsed: true,
                    onToggle,
                    onClearGroup
                }))
            } else {
                groupList.forEach(n => {
                    groupContainer.append(NotificationCapsule({
                        n,
                        groupCount: groupList.length,
                        isCollapsed: false,
                        onToggle: n === groupList[0] ? onToggle : undefined
                    }))
                })
            }

            notifList.append(groupContainer)
        })
    }

    clear.connect("clicked", () => {
        notifd.notifications.forEach(n => n.dismiss())
    })

    notifd.connect("notified", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { updateNotifs(); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { updateNotifs(); return GLib.SOURCE_REMOVE }))
    
    updateNotifs()

    return overlay
}
