import { Astal, Gtk, Gdk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { drawSquircle } from "../common/DrawingUtils"
import SquircleContainer, { Shape } from "../common/SquircleContainer"
import Theme from "../../core/ThemeManager"
import Gio from "gi://Gio"
import appService from "../../core/AppService"
import status from "../../core/Status"
import { dockSideState } from "../../widget/dock/state"
import { UNIT, GAP, GRID_WIDTH } from "./CCLayoutManager"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

export function createIconWidget(n: AstalNotifd.Notification, size: number) {
    const entry = n.desktop_entry || n.app_name || ""
    const appRes = appService.getResolvedApp(entry)
    const img = new Gtk.Image({ pixel_size: size, halign: Gtk.Align.START, valign: Gtk.Align.CENTER })
    if (appRes) {
        const icon = appRes.icon_name || appRes.get_icon()
        if (typeof icon === "string") {
            if (icon.startsWith("/") || icon.startsWith("file://")) img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(icon.replace("file://", "")))
            else img.icon_name = icon
        } else if (icon) img.gicon = icon
    } else {
        const fallback = appService.getIconName(n.app_icon || n.app_name)
        if (fallback?.startsWith("/") || fallback?.startsWith("file://")) img.gicon = Gio.FileIcon.new(Gio.File.new_for_path(fallback.replace("file://", "")))
        else if (fallback) img.icon_name = fallback; else img.gicon = Icons.info
    }
    return img
}

export function GroupControlHeader(props: { name: string, count: number, onToggle: () => void }) {
    const { name, count, onToggle } = props
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, css_classes: ["nc-group-ctrl-header"] })
    const labelBox = new Gtk.Box({ spacing: 8, hexpand: true })
    labelBox.append(new Gtk.Label({ label: name, css_classes: ["nc-group-header-name"], halign: Gtk.Align.START }))
    labelBox.append(new Gtk.Label({ label: `${count}`, css_classes: ["nc-badge-header"], valign: Gtk.Align.CENTER }))
    const collapseBtn = new Gtk.Button({ 
        child: new Gtk.Image({ gicon: Icons.chevronUp, pixel_size: 14 , css_classes: ["cs-icon"] }),
        css_classes: ["nc-group-collapse-btn"],
        valign: Gtk.Align.CENTER
    }); collapseBtn.connect("clicked", () => onToggle())
    box.append(labelBox); box.append(collapseBtn); return box
}

export function NotificationCapsule(props: { n: AstalNotifd.Notification, groupCount?: number, isExpanded?: boolean, onToggle?: () => void, onClearGroup?: () => void, isPopup?: boolean, onClose: () => void }) {
    const { n, groupCount = 1, isExpanded = false, onToggle, onClearGroup, isPopup = false, onClose } = props
    const sanitize = (text: string) => (text || "").replace(/<[^>]*>/g, "").split("\n").join(" ").replace(/\s+/g, " ").trim()
    const cleanSummary = sanitize(n.summary); const cleanBody = sanitize(n.body)
    const expandableBody = !isPopup && cleanBody.length > 60

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, margin_start: 16, margin_end: 16, margin_top: 12, margin_bottom: 12, valign: Gtk.Align.CENTER, hexpand: true })
    box.append(createIconWidget(n, 44))

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    const header = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, hexpand: true })
    header.append(new Gtk.Label({ label: cleanSummary, css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, lines: 1, hexpand: true, max_width_chars: 30, xalign: 0 }))

    if (!isPopup) {
        const now = Math.floor(Date.now()/1000); const d = now - n.time
        const timeStr = d < 60 ? t("nc.time.now") : (d < 3600 ? `${Math.floor(d/60)}m` : `${Math.floor(d/3600)}h`)
        header.append(new Gtk.Label({ label: timeStr, css_classes: ["nc-item-time"], halign: Gtk.Align.END }))
        if (groupCount > 1 && !isExpanded) header.append(new Gtk.Label({ label: `${groupCount}`, css_classes: ["nc-badge-header"], valign: Gtk.Align.CENTER }))
    }

    const clearBtn = new Gtk.Button({ child: new Gtk.Image({ gicon: Icons.close, pixel_size: 11, css_classes: ["cs-icon"] }), css_classes: ["nc-item-clear-btn-compact"] })
    const stopPropClear = new Gtk.GestureClick(); stopPropClear.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    stopPropClear.connect("pressed", (gesture) => { gesture.set_state(Gtk.EventSequenceState.CLAIMED); if (groupCount > 1 && !isExpanded && onClearGroup) onClearGroup(); else n.dismiss() })
    clearBtn.add_controller(stopPropClear)

    const actionsBox = new Gtk.Box({ spacing: 4, halign: Gtk.Align.END })

    // Group expand/collapse chevron — separate from card tap
    if (!isPopup && groupCount > 1 && !isExpanded && onToggle) {
        const expandBtn = new Gtk.Button({ child: new Gtk.Image({ gicon: Icons.chevronDown, pixel_size: 11, css_classes: ["cs-icon"] }), css_classes: ["nc-item-clear-btn-compact"] })
        const stopPropExpand = new Gtk.GestureClick(); stopPropExpand.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        stopPropExpand.connect("pressed", (gesture) => { gesture.set_state(Gtk.EventSequenceState.CLAIMED); onToggle() })
        expandBtn.add_controller(stopPropExpand)
        actionsBox.append(expandBtn)
    }

    actionsBox.append(clearBtn)
    header.append(actionsBox)
    textStack.append(header)

    let bodyLabel: Gtk.Label | null = null
    let bodyExpanded = false
    if (cleanBody) {
        bodyLabel = new Gtk.Label({ label: cleanBody, css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START, ellipsize: 3, lines: 2, wrap: true, xalign: 0, hexpand: true, max_width_chars: 40 })
        textStack.append(bodyLabel)
    }
    box.append(textStack)

    const openApp = async () => {
        const actions = n.get_actions() || []; const hasAction = (id: string) => actions.some(a => a.id === id)
        const appName = n.desktop_entry || n.app_name || ""; const lowerApp = appName.toLowerCase()
        if (lowerApp) {
            let searchClass = lowerApp
            if (lowerApp.includes("telegr")) searchClass = "org.telegram.desktop"
            if (lowerApp.includes("chrome")) searchClass = "google-chrome"
            if (lowerApp.includes("discord")) searchClass = "discord"
            try {
                const clients = JSON.parse(await execAsync(["hyprctl", "-j", "clients"]))
                const target = clients.find((c: any) => c.class.toLowerCase().includes(lowerApp) || c.class === searchClass)
                if (target) {
                    await execAsync(["hyprctl", "dispatch", "focuswindow", `address:${target.address}`])
                    if (hasAction("default")) n.invoke("default")
                } else {
                    if (hasAction("default")) n.invoke("default")
                    else appService.getResolvedApp(appName)?.launch()
                }
            } catch (e) {
                if (hasAction("default")) n.invoke("default")
                else appService.getResolvedApp(appName)?.launch()
            }
        } else {
            const urlMatch = n.body.match(/https?:\/\/[^\s<>"]+/g) || n.summary.match(/https?:\/\/[^\s<>"]+/g)
            if (urlMatch) execAsync(["xdg-open", urlMatch[0]]).catch(e => console.error(e))
            else if (hasAction("default")) n.invoke("default")
        }
        if (onClose) onClose()
    }

    const handleAction = async () => {
        if (expandableBody && !bodyExpanded && bodyLabel) {
            bodyExpanded = true
            bodyLabel.set_lines(-1)
            bodyLabel.set_ellipsize(0)
            return
        }
        await openApp()
    }

    return SquircleContainer({ child: box, radius: 32, useShellOpacity: true, gloss: true, borderColor: { r: 1, g: 1, b: 1, a: 0.05 }, css_classes: ["nc-capsule-item"], onClick: handleAction })
}

function makeGroupStack(card: Gtk.Widget, groupCount: number): Gtk.Widget {
    if (groupCount <= 1) return card

    const PEEK_H = 12
    const INSET  = 8
    const CARD_H = 80

    card.add_css_class("nc-stack-card")

    const wrapper = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 })
    wrapper.append(card)

    const da = new Gtk.DrawingArea({ height_request: PEEK_H, margin_start: INSET, margin_end: INSET })
    da.add_css_class("nc-ghost-strip-0")
    da.set_draw_func((_da: any, cr: any, w: number, _h: number) => {
        const color = Theme.isDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
        cr.save()
        cr.translate(0, -(CARD_H - PEEK_H))
        drawSquircle(cr, w, CARD_H, undefined, Theme.shellOpacity, false, color, 28, false, { r: 1, g: 1, b: 1, a: 0.07 })
        cr.restore()
    })
    Theme.connect("changed", () => da.queue_draw())
    wrapper.append(da)

    return wrapper
}

export default function NotificationCenter() {
    const notifd = AstalNotifd.get_default()
    const expandedGroups = new Set<string>()
    const groupCache = new Map<string, { container: Gtk.Box, headerBox: Gtk.Box, revealer: any, subBox: Gtk.Box, sig: string }>()

    const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true, width_request: 356, css_classes: ["nc-scroll", "nc-transparent-scroll"] })
    const listContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ["nc-content-box"], margin_top: 0, margin_bottom: 0 })
    // Dock-on-right: push NC away from dock by increasing outer margin (handled in Bar.tsx via dockSideState)
    scroll.set_child(listContainer)

    const CAL_W = GRID_WIDTH               // 4 cols = 356px
    const CAL_H = 3 * UNIT + 2 * GAP      // 3 rows = 264px
    const calendarIsland = SquircleContainer({
        child: new Gtk.Calendar({ hexpand: true, vexpand: true, css_classes: ["nc-calendar-widget"] }),
        radius: 32, gloss: true, useShellOpacity: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
        css_classes: ["cc-island", "nc-calendar-island"],
    })
    calendarIsland.set_size_request(CAL_W, CAL_H)
    const emptyLabel = new Gtk.Label({ label: t("nc.empty"), css_classes: ["nc-empty"], margin_top: 64, halign: Gtk.Align.CENTER, visible: false })
    const pillBox = new Gtk.Box({ halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 12, visible: false })
    const clearAllBtn = SquircleContainer({ child: new Gtk.Label({ label: t("nc.clear-all"), margin_start: 32, margin_end: 32, margin_top: 12, margin_bottom: 12 }), shape: Shape.CAPSULE, useShellOpacity: true, gloss: true, borderColor: { r: 0, g: 0, b: 0, a: 0 }, hoverBorderColor: { r: 0, g: 0, b: 0, a: 0 }, onClick: () => notifd.notifications.forEach(n => n.dismiss()), css_classes: ["nc-clear-all-pill"] })
    pillBox.append(clearAllBtn)

    listContainer.append(calendarIsland); listContainer.append(emptyLabel)
    const notificationItemsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 })
    listContainer.append(notificationItemsBox); listContainer.append(pillBox)

    const updateNotifs = () => {
        const notifs = notifd.notifications; const groups = new Map<string, AstalNotifd.Notification[]>()
        notifs.forEach(n => {
            const id = appService.getResolvedApp(n.desktop_entry || n.app_name)?.id || n.app_name || "unknown"
            const list = groups.get(id) || []; list.push(n); groups.set(id, list)
        })
        const sortedIds = Array.from(groups.keys()).sort((a,b) => {
            const timeA = Math.max(...groups.get(a)!.map(x => x.time)); const timeB = Math.max(...groups.get(b)!.map(x => x.time))
            return timeB - timeA || Math.max(...groups.get(b)!.map(x => x.id)) - Math.max(...groups.get(a)!.map(x => x.id))
        })
        emptyLabel.set_visible(notifs.length === 0); pillBox.set_visible(notifs.length > 0)
        groupCache.forEach((cache, id) => { if (!Array.from(groups.keys()).includes(id)) { if (cache.container.get_parent()) notificationItemsBox.remove(cache.container); groupCache.delete(id) } })

        sortedIds.forEach((id, index) => {
            const gl = groups.get(id)!; const sortedGroup = gl.sort((a, b) => b.time - a.time || b.id - a.id)
            const isExpanded = expandedGroups.has(id)
            const sig = `${gl.length}:${isExpanded}:${sortedGroup.map(n => n.id).join(",")}`
            let cache = groupCache.get(id)
            if (!cache) {
                const subBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 4 })
                const revealer = new (Gtk as any).Revealer({ child: subBox, transition_type: (Gtk as any).RevealerTransitionType.SLIDE_DOWN, transition_duration: 350 })
                const headerBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
                const container = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 })
                container.append(headerBox); container.append(revealer)
                cache = { container, headerBox, revealer, subBox, sig: "" }
                groupCache.set(id, cache); notificationItemsBox.append(container)
            }
            if (cache.sig !== sig) {
                while (cache.headerBox.get_first_child()) cache.headerBox.get_first_child()?.unparent()
                while (cache.subBox.get_first_child()) cache.subBox.get_first_child()?.unparent()
                const closeNC = () => { status.nc_open = false }
                const onToggle = () => { if (expandedGroups.has(id)) expandedGroups.delete(id); else expandedGroups.add(id); updateNotifs() }
                const appName = appService.getResolvedApp(sortedGroup[0].desktop_entry || sortedGroup[0].app_name)?.name || sortedGroup[0].app_name || "App"
                if (gl.length > 1) {
                    if (isExpanded) {
                        cache.container.remove_css_class("nc-group-with-ghost")
                        cache.headerBox.append(GroupControlHeader({ name: appName, count: gl.length, onToggle }))
                        sortedGroup.forEach(n => cache!.subBox.append(NotificationCapsule({ n, groupCount: 1, isExpanded: true, onToggle: undefined, onClearGroup: () => n.dismiss(), onClose: closeNC })))
                    } else {
                        cache.container.add_css_class("nc-group-with-ghost")
                        const capsule = NotificationCapsule({ n: sortedGroup[0], groupCount: gl.length, isExpanded: false, onToggle, onClearGroup: () => gl.forEach(m => m.dismiss()), onClose: closeNC })
                        cache.headerBox.append(makeGroupStack(capsule, gl.length))
                    }
                    cache.revealer.reveal_child = isExpanded
                } else {
                    cache.container.remove_css_class("nc-group-with-ghost")
                    cache.headerBox.append(NotificationCapsule({ n: sortedGroup[0], groupCount: 1, isExpanded: false, onToggle: undefined, onClearGroup: () => sortedGroup[0].dismiss(), onClose: closeNC }))
                    expandedGroups.delete(id); cache.revealer.reveal_child = false
                }
                cache.sig = sig
            }
            if (!cache.container.get_parent()) notificationItemsBox.append(cache.container)
        })
    }

    status.connect("notify::nc-open", () => { if (!status.nc_open) { expandedGroups.clear(); updateNotifs() } else { updateNotifs() } })
    notifd.connect("notified", () => updateNotifs())
    notifd.connect("resolved", () => updateNotifs())
    updateNotifs()
    return scroll
}
