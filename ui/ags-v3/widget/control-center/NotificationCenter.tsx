import { Astal, Gtk, Gdk } from "ags/gtk4"
import AstalNotifd from "gi://AstalNotifd"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { execAsync } from "ags/process"
import hs from "../../core/HyprlandState"
import { drawSquircle, createSquirclePath } from "../common/DrawingUtils"
import SquircleContainer, { Shape } from "../common/SquircleContainer"
import IconButton from "../common/IconButton"
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

// A "hero" image (image-path / image-data hint) — screenshot thumbnails, album art,
// chat avatars sent as content rather than the app icon. Returns null when the hint is
// absent, is an icon name (handled by the app icon), or points at a missing file.
export function createHeroWidget(n: AstalNotifd.Notification, size: number): Gtk.Widget | null {
    const raw = n.image
    if (!raw) return null
    const path = raw.replace("file://", "")
    if (!path.startsWith("/") || !GLib.file_test(path, GLib.FileTest.EXISTS)) return null
    let pixbuf: any = null
    try { pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size * 2, size * 2, true) } catch { return null }
    if (!pixbuf) return null

    const da = new Gtk.DrawingArea({ width_request: size, height_request: size, halign: Gtk.Align.END, valign: Gtk.Align.CENTER, css_classes: ["nc-hero"] })
    da.set_draw_func((_da: any, cr: any, w: number, h: number) => {
        if (w <= 0 || h <= 0) return
        // cover-fit: scale so the shorter side fills, then centre-crop inside the squircle
        const scale = Math.max(w / pixbuf.get_width(), h / pixbuf.get_height())
        const sw = Math.max(1, Math.round(pixbuf.get_width() * scale)), sh = Math.max(1, Math.round(pixbuf.get_height() * scale))
        const small = pixbuf.scale_simple(sw, sh, GdkPixbuf.InterpType.BILINEAR)
        cr.save(); createSquirclePath(cr, 0, 0, w, h, 12, 3.2); cr.clip()
        Gdk.cairo_set_source_pixbuf(cr, small, (w - sw) / 2, (h - sh) / 2); cr.paint(); cr.restore()
    })
    return da
}

export function GroupControlHeader(props: { name: string, count: number, onToggle: () => void, onClearGroup: () => void }) {
    const { name, count, onToggle, onClearGroup } = props
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER, hexpand: true, margin_start: 14, margin_end: 6, margin_top: 4, margin_bottom: 4 })
    const labelBox = new Gtk.Box({ spacing: 8, hexpand: true, valign: Gtk.Align.CENTER })
    labelBox.append(new Gtk.Label({ label: name, css_classes: ["nc-group-header-name"], halign: Gtk.Align.START }))
    labelBox.append(new Gtk.Label({ label: `${count}`, css_classes: ["nc-badge-header"], valign: Gtk.Align.CENTER }))
    const collapseBtn = IconButton({ icon: Icons.chevronUp, iconSize: 14, variant: "neutral", onClick: onToggle })
    const clearAllBtn = IconButton({ icon: Icons.close, iconSize: 14, variant: "danger", onClick: onClearGroup })
    box.append(labelBox); box.append(collapseBtn); box.append(clearAllBtn)
    // Paint the background with the same shellOpacity squircle as the cards (the old CSS
    // surface fill was fixed and didn't follow the Settings opacity).
    return SquircleContainer({ child: box, radius: 16, useShellOpacity: true, gloss: true, borderColor: { r: 1, g: 1, b: 1, a: 0.05 }, css_classes: ["nc-group-ctrl-header"] })
}

export function NotificationCapsule(props: { n: AstalNotifd.Notification, groupCount?: number, isExpanded?: boolean, onToggle?: () => void, onClearGroup?: () => void, isPopup?: boolean, itemExpanded?: boolean, onToggleItem?: () => void, onClose: () => void }) {
    const { n, groupCount = 1, isExpanded = false, onToggle, onClearGroup, isPopup = false, itemExpanded = false, onToggleItem, onClose } = props
    const sanitize = (text: string) => (text || "").replace(/<[^>]*>/g, "").split("\n").join(" ").replace(/\s+/g, " ").trim()
    const cleanSummary = sanitize(n.summary); const cleanBody = sanitize(n.body)

    // Content top-aligned: title sits at the same height as the badge/chevron on the right.
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, margin_start: 16, margin_end: 16, margin_top: 12, margin_bottom: 12, valign: Gtk.Align.START, hexpand: true })
    box.append(createIconWidget(n, 44))   // app icon stays vertically centred (like the hero)

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.START, hexpand: true })
    const header = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, hexpand: true })
    header.append(new Gtk.Label({ label: cleanSummary, css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START, ellipsize: 3, lines: 1, hexpand: true, max_width_chars: 30, xalign: 0 }))

    if (!isPopup) {
        const now = Math.floor(Date.now()/1000); const d = now - n.time
        const timeStr = d < 60 ? t("nc.time.now") : (d < 3600 ? `${Math.floor(d/60)}m` : `${Math.floor(d/3600)}h`)
        header.append(new Gtk.Label({ label: timeStr, css_classes: ["nc-item-time"], halign: Gtk.Align.END }))
    }

    textStack.append(header)

    // Close button — collapsed groups clear the whole group, otherwise dismiss the one.
    const isCollapsedGroup = !isPopup && groupCount > 1 && !isExpanded && !!onToggle
    const clearBtn = IconButton({
        icon: Icons.close, iconSize: 13, variant: "danger", captureClick: true,
        onClick: () => { if (groupCount > 1 && !isExpanded && onClearGroup) onClearGroup(); else n.dismiss() },
    })

    // Two fixed sizes: 2 body lines (normal) / 4 (expanded). Reserve the height so all
    // normals (and all expanded) share one height regardless of how long the body is.
    const bodyLines = itemExpanded ? 4 : 2
    let bodyLabel: Gtk.Label | null = null
    if (cleanBody) {
        bodyLabel = new Gtk.Label({ label: cleanBody, css_classes: ["nc-notif-body"], halign: Gtk.Align.FILL, ellipsize: 3, lines: bodyLines, wrap: true, xalign: 0, hexpand: true })
        // Normal reserves its 2 lines (uniform height); expanded grows to content up to 4.
        if (!isPopup && !itemExpanded) bodyLabel.height_request = bodyLines * 17   // ~17px @ fs-caption 12
        textStack.append(bodyLabel)
    }

    // Action buttons (skip the implicit "default" action — that's the card tap).
    // Only in the expanded size, so the normal size never grows/overflows.
    const actions = (n.get_actions() || []).filter(a => a.id !== "default" && a.label)
    if (actions.length > 0 && itemExpanded) {
        const actionRow = new Gtk.Box({ spacing: 6, margin_top: 8, halign: Gtk.Align.START, css_classes: ["nc-action-row"] })
        actions.forEach(a => {
            const btn = new Gtk.Button({ label: a.label, css_classes: ["nc-action-btn"], halign: Gtk.Align.START })
            const stopProp = new Gtk.GestureClick(); stopProp.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
            stopProp.connect("pressed", (gesture) => {
                gesture.set_state(Gtk.EventSequenceState.CLAIMED)
                n.invoke(a.id)
                if (onClose) onClose()
            })
            btn.add_controller(stopProp)
            actionRow.append(btn)
        })
        textStack.append(actionRow)
    }

    box.append(textStack)

    const hero = createHeroWidget(n, 48)
    if (hero) box.append(hero)

    // An individual notification is expandable if it has actions or a body longer than the
    // 2-line normal size can show. The chevron sits where grouped notifs show their count.
    const expandable = !isPopup && groupCount === 1 && !!onToggleItem && (actions.length > 0 || cleanBody.length > 70)

    // Right column (top-aligned): count badge (collapsed group) OR expand chevron (individual),
    // over the close button.
    const rightCol = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, valign: Gtk.Align.START, halign: Gtk.Align.CENTER, css_classes: ["nc-right-col"] })
    if (isCollapsedGroup) {
        rightCol.append(new Gtk.Label({ label: `${groupCount}`, css_classes: ["nc-badge-header", "nc-badge-stacked"], halign: Gtk.Align.CENTER }))
    } else if (expandable) {
        rightCol.append(IconButton({ icon: itemExpanded ? Icons.chevronUp : Icons.chevronDown, iconSize: 13, variant: "neutral", captureClick: true, onClick: onToggleItem }))
    }
    rightCol.append(clearBtn)
    box.append(rightCol)

    const openApp = async () => {
        const actions = n.get_actions() || []; const hasAction = (id: string) => actions.some(a => a.id === id)
        const appName = n.desktop_entry || n.app_name || ""; const lowerApp = appName.toLowerCase()
        if (lowerApp) {
            let searchClass = lowerApp
            if (lowerApp.includes("telegr")) searchClass = "org.telegram.desktop"
            if (lowerApp.includes("chrome")) searchClass = "google-chrome"
            if (lowerApp.includes("discord")) searchClass = "discord"
            try {
                // hs.clients is the cached, always-current client list — no per-open
                // `hyprctl -j clients` re-shell — and hs.focusWindow centralizes the
                // focus dispatch (same Lua dispatch string the dock uses).
                const target = hs.clients.find((c: any) => c.class?.toLowerCase().includes(lowerApp) || c.class === searchClass)
                if (target) {
                    await hs.focusWindow(target.address)
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
        // Tapping a collapsed group expands it; individual notifs expand via the chevron only.
        if (isCollapsedGroup && onToggle) { onToggle(); return }
        await openApp()
    }

    return SquircleContainer({ child: box, radius: 32, useShellOpacity: true, gloss: true, hexpand: true, borderColor: { r: 1, g: 1, b: 1, a: 0.05 }, css_classes: ["nc-capsule-item"], onClick: handleAction })
}

function makeGroupStack(card: Gtk.Widget, groupCount: number): Gtk.Widget {
    if (groupCount <= 1) return card

    const CARD_H = 80
    const RADIUS = 32          // match the real card's corner radius
    const PEEK   = 14          // how far the nearest ghost peeks below the card
    const STEP   = 10          // extra peek per deeper layer (enough to show body, not just the rim)
    const layers = groupCount >= 3 ? 2 : 1   // a second ghost only once there are 3+

    card.add_css_class("nc-stack-card")

    const wrapper = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 })
    wrapper.append(card)

    // A single DrawingArea paints all ghost layers — no negative margins on a thin area
    // (those reported "min height < 0"). Layers are drawn back-to-front: each deeper one is
    // narrower (more inset), peeks a bit lower, and is fainter, for a stacked-card look.
    const stripH = PEEK + (layers - 1) * STEP
    const da = new Gtk.DrawingArea({ height_request: stripH })
    da.set_draw_func((_da: any, cr: any, w: number, _h: number) => {
        if (w <= 0 || _h <= 0) return
        const color = Theme.isDark ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 }
        for (let i = layers - 1; i >= 0; i--) {
            // Inset >= the card's corner radius so each ghost's straight top edge sits under the
            // STRAIGHT part of the card's bottom (clear of the rounded corners) — no corner gap.
            const inset = RADIUS + i * 16
            const bottomY = PEEK + i * STEP
            // Clip to this layer's band, overlapping the previous layer by ~2px of BODY. The
            // card→ghost1 seam overlaps 4px but the card's inner inset (~2.5) eats most of it,
            // leaving ~1.5px of body; ghosts draw with inset 0, so 2px matches that seam weight.
            const bandTop = i === 0 ? 0 : PEEK + (i - 1) * STEP - 2
            const depth = 1 - i * 0.12   // body stays nearly as solid as the front; just a hair fainter
            cr.save()
            cr.rectangle(0, bandTop, w, bottomY - bandTop)
            cr.clip()
            cr.translate(inset, bottomY - CARD_H)
            // inset 0 so the squircle's bottom edge lands exactly at bottomY (no gap between bands).
            drawSquircle(cr, w - inset * 2, CARD_H, undefined, Theme.shellOpacity * depth, false, color, RADIUS, false, { r: 1, g: 1, b: 1, a: 0.07 * depth }, 3.2, 1.0, 0)
            cr.restore()
        }
    })
    const themeConn = Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
    da.connect("destroy", () => Theme.disconnect(themeConn))
    wrapper.append(da)

    return wrapper
}

export default function NotificationCenter() {
    const notifd = AstalNotifd.get_default()
    const expandedGroups = new Set<string>()
    const expandedItems = new Set<number>()   // individual notifs (by n.id) in expanded size
    const toggleItem = (nid: number) => { if (expandedItems.has(nid)) expandedItems.delete(nid); else expandedItems.add(nid); updateNotifs() }
    const groupCache = new Map<string, { container: Gtk.Box, headerBox: Gtk.Box, revealer: any, subBox: Gtk.Box, sig: string }>()

    // The content keeps its full width (GRID_WIDTH); LANE is extra space ADDED on the right
    // to host the scrollbar. The overlay scrollbar floats in that lane only when there's
    // overflow — so it never reflows the cards and never overlaps them, even inflated on hover.
    const LANE = 14
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, visible: false, width_request: GRID_WIDTH + LANE, css_classes: ["nc-outer", "overlay-fade"] })

    const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true, hexpand: true, css_classes: ["nc-scroll", "nc-transparent-scroll"] })
    // The scroll forces its child to the full viewport width (GRID_WIDTH + LANE). A
    // padding-right of LANE (in .nc-content-box) keeps the cards at GRID_WIDTH and leaves
    // the lane free on the right for the overlay scrollbar — no reflow, no overlap.
    const listContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ["nc-content-box"], margin_top: 0, margin_bottom: 0 })
    scroll.set_child(listContainer)

    const CAL_H = 3 * UNIT + 2 * GAP      // 3 rows = 264px
    const calendarIsland = SquircleContainer({
        child: new Gtk.Calendar({ hexpand: true, vexpand: true, css_classes: ["nc-calendar-widget"] }),
        radius: 32, gloss: true, useShellOpacity: true,
        borderColor: { r: 1, g: 1, b: 1, a: 0.05 },
        css_classes: ["cc-island", "nc-calendar-island"],
    })
    // Calendar fixed to GRID_WIDTH and left-aligned, so its right edge lines up with the cards
    // (the LANE sits to the right of both).
    calendarIsland.set_size_request(GRID_WIDTH, CAL_H)
    calendarIsland.set_halign(Gtk.Align.START)
    const emptyLabel = new Gtk.Label({ label: t("nc.empty"), css_classes: ["nc-empty"], margin_top: 64, halign: Gtk.Align.CENTER, visible: false })
    const pillBox = new Gtk.Box({ halign: Gtk.Align.CENTER, margin_top: 24, margin_bottom: 12, visible: false })
    const clearAllBtn = SquircleContainer({ child: new Gtk.Label({ label: t("nc.clear-all"), margin_start: 32, margin_end: 32, margin_top: 12, margin_bottom: 12 }), shape: Shape.CAPSULE, useShellOpacity: true, gloss: true, borderColor: { r: 0, g: 0, b: 0, a: 0 }, hoverBorderColor: { r: 0, g: 0, b: 0, a: 0 }, onClick: () => notifd.notifications.forEach(n => n.dismiss()), css_classes: ["nc-clear-all-pill"] })
    pillBox.append(clearAllBtn)

    const notificationItemsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, hexpand: true })
    listContainer.append(emptyLabel)
    listContainer.append(notificationItemsBox)
    listContainer.append(pillBox)

    outer.append(calendarIsland)
    outer.append(scroll)

    const updateNotifs = () => {
        const notifs = notifd.notifications; const groups = new Map<string, AstalNotifd.Notification[]>()
        notifs.forEach(n => {
            const id = appService.getResolvedApp(n.desktop_entry || n.app_name)?.id || n.app_name || "unknown"
            const list = groups.get(id) || []; list.push(n); groups.set(id, list)
        })
        // Drop expand state for notifications that no longer exist.
        const liveIds = new Set(notifs.map(n => n.id))
        expandedItems.forEach(eid => { if (!liveIds.has(eid)) expandedItems.delete(eid) })
        const sortedIds = Array.from(groups.keys()).sort((a,b) => {
            const timeA = Math.max(...groups.get(a)!.map(x => x.time)); const timeB = Math.max(...groups.get(b)!.map(x => x.time))
            return timeB - timeA || Math.max(...groups.get(b)!.map(x => x.id)) - Math.max(...groups.get(a)!.map(x => x.id))
        })
        emptyLabel.set_visible(notifs.length === 0); pillBox.set_visible(notifs.length > 0)
        groupCache.forEach((cache, id) => { if (!Array.from(groups.keys()).includes(id)) { if (cache.container.get_parent()) notificationItemsBox.remove(cache.container); groupCache.delete(id) } })

        sortedIds.forEach((id, index) => {
            const gl = groups.get(id)!; const sortedGroup = gl.sort((a, b) => b.time - a.time || b.id - a.id)
            const isExpanded = expandedGroups.has(id)
            const timeBucket = Math.floor(Date.now() / 60_000)
            const sig = `${gl.length}:${isExpanded}:${sortedGroup.map(n => n.id).join(",")}:${sortedGroup.map(n => expandedItems.has(n.id) ? '1' : '0').join('')}:${timeBucket}`
            let cache = groupCache.get(id)
            if (!cache) {
                const subBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 4 })
                const revealer = new (Gtk as any).Revealer({ child: subBox, transition_type: (Gtk as any).RevealerTransitionType.SLIDE_DOWN, transition_duration: 350 })
                const headerBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
                const container = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, hexpand: true })
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
                        cache.headerBox.append(GroupControlHeader({ name: appName, count: gl.length, onToggle, onClearGroup: () => gl.forEach(m => m.dismiss()) }))
                        sortedGroup.forEach(n => cache!.subBox.append(NotificationCapsule({ n, groupCount: 1, isExpanded: true, onToggle: undefined, onClearGroup: () => n.dismiss(), itemExpanded: expandedItems.has(n.id), onToggleItem: () => toggleItem(n.id), onClose: closeNC })))
                    } else {
                        cache.container.add_css_class("nc-group-with-ghost")
                        const capsule = NotificationCapsule({ n: sortedGroup[0], groupCount: gl.length, isExpanded: false, onToggle, onClearGroup: () => gl.forEach(m => m.dismiss()), onClose: closeNC })
                        cache.headerBox.append(makeGroupStack(capsule, gl.length))
                    }
                    cache.revealer.reveal_child = isExpanded
                } else {
                    cache.container.remove_css_class("nc-group-with-ghost")
                    cache.headerBox.append(NotificationCapsule({ n: sortedGroup[0], groupCount: 1, isExpanded: false, onToggle: undefined, onClearGroup: () => sortedGroup[0].dismiss(), itemExpanded: expandedItems.has(sortedGroup[0].id), onToggleItem: () => toggleItem(sortedGroup[0].id), onClose: closeNC }))
                    expandedGroups.delete(id); cache.revealer.reveal_child = false
                }
                cache.sig = sig
            }
            if (!cache.container.get_parent()) notificationItemsBox.append(cache.container)
        })
    }

    let timestampTimer: number | null = null

    status.connect("notify::nc-open", () => {
        if (status.nc_open) {
            updateNotifs()
            // Refresh relative timestamps ("2m", "1h") while NC is visible.
            timestampTimer = GLib.timeout_add(GLib.PRIORITY_LOW, 60_000, () => {
                if (!status.nc_open) { timestampTimer = null; return GLib.SOURCE_REMOVE }
                updateNotifs()
                return GLib.SOURCE_CONTINUE
            })
        } else {
            if (timestampTimer !== null) { GLib.source_remove(timestampTimer); timestampTimer = null }
            expandedGroups.clear()
            updateNotifs()
        }
    })
    // Only rebuild when NC is open — opening NC always calls updateNotifs() above.
    notifd.connect("notified", () => { if (status.nc_open) updateNotifs() })
    notifd.connect("resolved", () => { if (status.nc_open) updateNotifs() })
    updateNotifs()
    return outer
}
