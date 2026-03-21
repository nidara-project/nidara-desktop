import { Astal, Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { drawSquircle } from "../common/DrawingUtils"
import SquircleContainer, { Shape } from "../common/SquircleContainer"
import Gio from "gi://Gio"
import appService from "../../core/AppService"
import status from "../../core/Status"

export function createIconWidget(n: AstalNotifd.Notification, size: number) {
    const entry = n.desktop_entry || n.app_name || ""
    const appRes = appService.getResolvedApp(entry)
    const img = new Gtk.Image({ pixel_size: size, halign: Gtk.Align.START, valign: Gtk.Align.CENTER })
    if (appRes) {
        const icon = appRes.icon_name || appRes.get_icon()
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

export function NotificationCapsule(props: { n: AstalNotifd.Notification, groupCount?: number, isExpanded?: boolean, onToggle?: () => void, onClearGroup?: () => void, isPopup?: boolean }) {
    const { n, groupCount = 1, isExpanded = false, onToggle, onClearGroup, isPopup = false } = props
    const sanitize = (text: string) => (text || "").replace(/<[^>]*>/g, "").split("\n").join(" ").replace(/\s+/g, " ").trim()
    const cleanSummary = sanitize(n.summary); const cleanBody = sanitize(n.body)
    
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, margin_start: 16, margin_end: 16, margin_top: 12, margin_bottom: 12, valign: Gtk.Align.CENTER, height_request: 56, hexpand: true })
    box.append(createIconWidget(n, 44))
    
    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    const header = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, hexpand: true })
    header.append(new Gtk.Label({ label: cleanSummary, css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, lines: 1, hexpand: true, max_width_chars: 30, xalign: 0 }))
    
    if (!isPopup) {
        const now = Math.floor(Date.now()/1000); const d = now - n.time
        const timeStr = d < 60 ? "ahora" : (d < 3600 ? `${Math.floor(d/60)}m` : `${Math.floor(d/3600)}h`)
        header.append(new Gtk.Label({ label: timeStr, css_classes: ["nc-item-time"], halign: Gtk.Align.END }))
        if (groupCount > 1 && !isExpanded) header.append(new Gtk.Label({ label: `${groupCount}`, css_classes: ["nc-badge-header"], valign: Gtk.Align.CENTER }))
    }
    
    const clearBtn = new Gtk.Button({ child: new Gtk.Image({ icon_name: "window-close-symbolic", pixel_size: 11 }), css_classes: ["nc-item-clear-btn-compact"] })
    const stopProp = new Gtk.GestureClick(); stopProp.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    stopProp.connect("pressed", (gesture) => { gesture.set_state(Gtk.EventSequenceState.CLAIMED); if (groupCount > 1 && !isExpanded && onClearGroup) onClearGroup(); else n.dismiss() })
    clearBtn.add_controller(stopProp)

    const actions = new Gtk.Box({ spacing: 4, halign: Gtk.Align.END }); actions.append(clearBtn); header.append(actions); textStack.append(header)
    if (n.body) textStack.append(new Gtk.Label({ label: cleanBody, css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, ellipsize: 3, lines: 2, wrap: true, xalign: 0, hexpand: true, max_width_chars: 40 }))
    box.append(textStack)
    
    const container = SquircleContainer({ child: box, radius: 40, n: 3.2, alpha: 0.15, gloss: true, shape: Shape.CAPSULE, borderColor: { r: 1, g: 1, b: 1, a: 0.05 }, css_classes: ["nc-capsule-item"], onClick: () => { if (groupCount > 1 && onToggle) onToggle(); else { n.invoke("default"); status.nc_open = false } } })
    container.height_request = 80; return container
}

/**
 * 🛰️ NotificationCenter: SINGLE WINDOW (v123) - Animated Expansion
 */
export default function NotificationCenter() {
    const notifd = AstalNotifd.get_default()
    const expandedGroups = new Set<string>()

    const overlay = new Gtk.Overlay({ css_classes: ["nc-window-root", "nc-overlay"], hexpand: true, vexpand: true })
    const catcher = new Gtk.Box({ hexpand: true, vexpand: true }); overlay.set_child(catcher)
    const clickGesture = new Gtk.GestureClick(); clickGesture.connect("pressed", () => status.nc_open = false); catcher.add_controller(clickGesture)
    
    const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true, css_classes: ["nc-scroll", "nc-transparent-scroll"] })
    const contentBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ["nc-content-box"], margin_top: 8, margin_bottom: 120, margin_end: 12, halign: Gtk.Align.END, width_request: 450 })
    scroll.set_child(contentBox)
    overlay.add_overlay(scroll)

    const updateNotifs = () => {
        // We only clear if there is a fundamental change in count (simplification for reconciliation)
        // Ideally we'd only update children, but for now we rebuild to keep logic simple.
        // Revealer will be recreated but we'll try to set its state before adding to parent.
        while (contentBox.get_first_child()) contentBox.get_first_child()?.unparent()
        
        contentBox.append(SquircleContainer({ child: new Gtk.Calendar({ hexpand: true, css_classes: ["nc-calendar-widget"] }), radius: 32, gloss: true, alpha: 0.15, borderColor: { r: 1, g: 1, b: 1, a: 0.05 }, css_classes: ["cc-island", "nc-calendar-island"] }))
        contentBox.append(new Gtk.Box({ height_request: 24 }))

        const notifs = notifd.notifications; const groups = new Map<string, AstalNotifd.Notification[]>()
        notifs.forEach(n => {
            const id = appService.getResolvedApp(n.desktop_entry || n.app_name)?.id || n.app_name || "unknown"
            const list = groups.get(id) || []; list.push(n); groups.set(id, list)
        })

        const sortedIds = Array.from(groups.keys()).sort((a,b) => {
            const timeA = Math.max(...groups.get(a)!.map(x => x.time)); const timeB = Math.max(...groups.get(b)!.map(x => x.time))
            if (timeB !== timeA) return timeB - timeA
            return Math.max(...groups.get(b)!.map(x => x.id)) - Math.max(...groups.get(a)!.map(x => x.id))
        })

        sortedIds.forEach(id => {
            const gl = groups.get(id)!; 
            const isExpanded = expandedGroups.has(id); 
            const onToggle = () => { 
                if (isExpanded) expandedGroups.delete(id); 
                else expandedGroups.add(id); 
                updateNotifs() 
            }
            
            const groupContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_bottom: 8 })
            const sortedGroup = gl.slice().sort((a, b) => b.time - a.time || b.id - a.id)
            
            // 1. Always show the first one
            groupContainer.append(NotificationCapsule({ n: sortedGroup[0], groupCount: gl.length, isExpanded, onToggle, onClearGroup: () => gl.forEach(m => m.dismiss()) }))
            
            // 2. Wrap the rest in a Revealer for smooth animation
            if (gl.length > 1) {
                const subBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 8 }) // Small vertical gap for grouped items
                sortedGroup.slice(1).forEach(n => subBox.append(NotificationCapsule({ n, groupCount: gl.length, isExpanded: true, onToggle, onClearGroup: () => gl.forEach(m => m.dismiss()) })))
                
                const revealer = new Gtk.Revealer({ 
                    child: subBox, 
                    transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
                    transition_duration: 350
                })
                
                groupContainer.append(revealer)
                // Set initial state based on interaction
                revealer.reveal_child = isExpanded
            }
            
            contentBox.append(groupContainer)
        })

        if (notifs.length > 0) {
            contentBox.append(new Gtk.Box({ height_request: 32 })) 
            const pillBox = new Gtk.Box({ halign: Gtk.Align.CENTER, height_request: 40 })
            pillBox.append(SquircleContainer({ child: new Gtk.Label({ label: "Borrar notificaciones", margin_start: 32, margin_end: 32, margin_top: 12, margin_bottom: 12 }), shape: Shape.CAPSULE, alpha: 0.2, gloss: true, borderColor: { r: 0, g: 0, b: 0, a: 0 }, hoverBorderColor: { r: 0, g: 0, b: 0, a: 0 }, onClick: () => notifd.notifications.forEach(n => n.dismiss()), css_classes: ["nc-clear-all-pill"] }))
            contentBox.append(pillBox); contentBox.append(new Gtk.Box({ height_request: 40 })) 
        } else contentBox.append(new Gtk.Label({ label: "No hay notificaciones", css_classes: ["nc-empty"], margin_top: 64, halign: Gtk.Align.CENTER }))
    }

    status.connect("notify::nc-open", () => {
        if (!status.nc_open && expandedGroups.size > 0) {
            expandedGroups.clear()
            updateNotifs()
        }
    })

    notifd.connect("notified", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { updateNotifs(); return GLib.SOURCE_REMOVE }))
    notifd.connect("resolved", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { updateNotifs(); return GLib.SOURCE_REMOVE }))
    updateNotifs(); return overlay
}
