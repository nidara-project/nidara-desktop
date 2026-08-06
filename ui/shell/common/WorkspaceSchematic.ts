import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import appService from "../core/AppService"
import hs, { bareAddr, type ClientGeometry } from "../core/HyprlandState"
import { captureWindow } from "../core/WindowCapture"
import { makeWindowThumbnail, type WindowThumbnail } from "./WindowThumbnail"

export interface SchematicHandle {
    wrapper: Gtk.Widget
    /**
     * Lay the workspace out again.
     *
     * `geom` is an optional FRESH geometry snapshot (`hs.readGeometry()`), used in
     * preference to the cached client objects for position and size only. Without
     * it the layout is as good as the last event that re-synced the client list —
     * which is NOT good enough for a surface that paints real window content into
     * these tiles, because a resize emits no event at all (see readGeometry). Pass
     * it wherever the tile is big enough for the error to show; the app grid's 80px
     * strip is not that place, and one hyprctl per repaint is not free.
     */
    sync: (geom?: ClientGeometry) => void
    /** "The surface is opening": marks every thumbnail stale so the next sync()
     *  re-captures, and ARMS capturing in the first place. Captures are one-shot by
     *  design (one compositor render pass each), so nothing refreshes them while the
     *  surface sits open — and nothing captures at all until a surface says it is
     *  about to be looked at. */
    refresh: () => void
}

/**
 * Below this the capture is unreadable mush and the app icon is doing all the
 * identifying anyway — so we skip the render pass entirely rather than spend one
 * per sliver in a heavily tiled workspace.
 */
const THUMB_MIN_PX = 24

interface Tile { x: number; y: number; w: number; h: number }

function roundedRect(cr: any, x: number, y: number, w: number, h: number, r: number) {
    const PI = Math.PI
    cr.newPath()
    cr.arc(x + r,     y + r,     r, PI,        3 * PI / 2)
    cr.arc(x + w - r, y + r,     r, 3 * PI / 2, 2 * PI)
    cr.arc(x + w - r, y + h - r, r, 0,          PI / 2)
    cr.arc(x + r,     y + h - r, r, PI / 2,     PI)
    cr.closePath()
}

export interface SchematicOptions {
    /**
     * Capture real window content behind the icons. OFF by default and opt-in per
     * surface, because a capture is a compositor render pass per window: the app
     * grid's workspace strip draws the same schematic at ~80px wide, where a
     * thumbnail is mush and the icon is doing the identifying anyway. Only the
     * overview, whose cards are big enough to read, asks for them.
     */
    thumbnails?: boolean
}

export function createSchematicMap(wsId: number, width: number, options: SchematicOptions = {}): SchematicHandle {
    const wantThumbnails = options.thumbnails ?? false
    const initialHeight = Math.round(width * (9 / 16))

    // Cairo canvas draws background + tile rectangles at exact pixel coords.
    // CSS color: var(--nidara-surface) on this widget is read via get_color()
    // to get the actual surface color without hardcoding.
    const canvas = new Gtk.DrawingArea({
        css_classes: ["wo-schematic-canvas"],
        can_target: false,
        width_request: width,
        height_request: initialHeight,
    })

    // Gtk.Fixed positions transparent icon widgets over each tile
    const iconFixed = new Gtk.Fixed({
        css_classes: ["wo-schematic-icons"],
        can_target: false,
        hexpand: true,
        vexpand: true,
    }) as any
    iconFixed.set_overflow(Gtk.Overflow.HIDDEN)

    // Overlay: canvas (base) + iconFixed (top layer)
    const overlay = new Gtk.Overlay({
        css_classes: ["wo-schematic-preview"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        can_target: false,
        width_request: width,
        height_request: initialHeight,
    })
    overlay.set_child(canvas)
    overlay.add_overlay(iconFixed)

    const HYPR_ROUNDING = 24

    let currentTiles: Tile[] = []
    let currentRadius   = 0

    canvas.set_draw_func((da, cr, areaW, areaH) => {
        if (areaW <= 0 || areaH <= 0) return
        // Dark background
        cr.setSourceRGBA(0, 0, 0, 0.3)
        cr.rectangle(0, 0, areaW, areaH)
        cr.fill()

        // Tile color: read from CSS 'color' property = var(--nidara-surface)
        const col = da.get_style_context().get_color()
        cr.setSourceRGBA(col.red, col.green, col.blue, col.alpha)
        for (const t of currentTiles) {
            const r = Math.min(currentRadius, t.w / 2, t.h / 2)
            roundedRect(cr, t.x, t.y, t.w, t.h, r)
            cr.fill()
        }
    })

    // lastW/lastH are remembered because a capture lands asynchronously, long after
    // the sync that sized the tile — and the icon has to be re-laid-out at that
    // moment, from placeholder to badge.
    interface WinWidget { box: Gtk.Overlay; icon: Gtk.Image; thumb: WindowThumbnail; lastW: number; lastH: number }
    const winWidgets = new Map<string, WinWidget>()

    /**
     * The app icon has TWO jobs and they want different geometry.
     *
     * With no thumbnail it is the placeholder: big and centred, carrying the whole
     * tile. Once real content arrives it becomes a badge parked on the bottom edge
     * — which is what GNOME, macOS Mission Control and KDE all do, and for the same
     * reason: at this scale the content identifies the DOCUMENT, not the app. Two
     * Chrome windows are indistinguishable at 150px; the icon is what tells them
     * apart. Removing it entirely (the first cut of this) loses that.
     */
    const applyIconLayout = (widget: WinWidget, w: number, h: number) => {
        if (widget.thumb.hasTexture()) {
            widget.icon.valign = Gtk.Align.END
            widget.icon.vexpand = false
            widget.icon.margin_bottom = Math.max(2, Math.round(Math.min(w, h) * 0.06))
            widget.icon.pixel_size = Math.round(Math.max(16, Math.min(28, Math.min(w, h) * 0.32)))
            // Below this the badge would cover the content it is annotating.
            widget.icon.visible = w > 40 && h > 40
        } else {
            widget.icon.valign = Gtk.Align.CENTER
            widget.icon.vexpand = true
            widget.icon.margin_bottom = 0
            widget.icon.pixel_size = Math.min(w * 0.7, h * 0.7, 32)
            widget.icon.visible = w > 12 && h > 12
        }
    }

    // Addresses we have already asked the compositor for. A capture costs a render
    // pass, and sync() runs on every HyprlandState "changed" while the overview is
    // open — without this, dragging a window would re-capture every window on the
    // workspace on every motion event.
    const captured = new Set<string>()
    let staleAll = true
    // Nothing is captured until a surface has said it is opening (refresh()). The
    // overview lays its cards out once at startup so the first Super+Tab has content
    // to morph into — and that pass used to fire a capture per window, for a surface
    // nobody was looking at. Every one of them failed, with reason `buffer_constraints`
    // and for a reason worth keeping: the shell was starting, its bar and dock were
    // claiming their exclusive zones, and so every tiled window was being RESIZED
    // underneath the capture session that had just advertised the old size.
    let armed = false

    const requestThumb = (address: string, widget: WinWidget, w: number, h: number, force: boolean) => {
        if (!wantThumbnails || !armed) return
        if (w < THUMB_MIN_PX || h < THUMB_MIN_PX) return
        if (captured.has(address) && !force) return
        captured.add(address)

        // The capture is sized in DEVICE pixels: asking for the widget size on a
        // 2x display would hand back a texture at half the resolution GSK then
        // upscales, which looks softer than the placeholder it replaced.
        const sf = overlay.get_scale_factor() || 1
        captureWindow(address, Math.round(w * sf), Math.round(h * sf))
            .then(texture => {
                // The window may have closed, or the schematic rebuilt its widgets,
                // while the capture was in flight.
                if (winWidgets.get(address) !== widget) return
                if (!texture) {
                    // Leave it uncaptured so a later open can retry — a window that
                    // was mid-close now is not permanently thumbnail-less.
                    captured.delete(address)
                    return
                }
                widget.thumb.setTexture(texture)
                widget.box.add_css_class("has-thumb")
                // Placeholder → badge, now that there is content underneath.
                applyIconLayout(widget, widget.lastW, widget.lastH)
            })
            .catch(e => console.warn(`[Schematic] thumbnail ${address}: ${e}`))
    }

    const sync = (geom?: ClientGeometry) => {
        // Consumed once per sync so a "changed" storm mid-open does not re-capture
        // on every event — only the sync that follows the open does.
        const force = staleAll
        staleAll = false

        // Position and size come from the caller's fresh snapshot when there is one.
        // The cached Client object is the fallback and carries the same four fields,
        // so this is a straight swap — it is just older, by however long it has been
        // since an event last re-synced the list (a resize is not one, ever).
        const rectOf = (c: any) => geom?.get(bareAddr(c.address)) ?? c
        const workspaces = hs.workspaces
        const monitors   = hs.monitors
        const clients    = hs.clients

        const ws = workspaces.find((w: any) => w.id === wsId)

        let hMonitor: any = monitors.find((m: any) => m.name === (ws?.monitor || ""))
        // monitor_id is a loose runtime fallback not in the Workspace typings.
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.id === ((ws as any)?.monitor_id ?? -1))
        if (!hMonitor && wsId === hs.focusedWorkspaceId) hMonitor = hs.focusedMonitor
        if (!hMonitor) hMonitor = monitors.find((m: any) => m.active_workspace?.id === wsId) ?? monitors[0]
        if (!hMonitor?.width) return

        const scaleFactor = hMonitor.scale || 1
        const logicalW    = hMonitor.width  / scaleFactor
        const logicalH    = hMonitor.height / scaleFactor
        const scale       = width / logicalW
        const drawH       = Math.round(logicalH * scale)

        overlay.set_size_request(width, drawH)
        canvas.set_size_request(width, drawH)

        const monX = hMonitor.x || 0
        const monY = hMonitor.y || 0

        const wsClients = clients
            .filter((c: any) => c?.workspace?.id === wsId)
            .sort((a: any, b: any) => (b.focus_history_id || 0) - (a.focus_history_id || 0))

        // rounding_power=3.2 makes corners look more rounded than the raw radius implies;
        // multiply by 4 to keep the schematic visually faithful at minimap scale
        currentRadius = HYPR_ROUNDING * 4 * scale

        // Cairo tiles — float coords so all inter-window gaps scale identically
        currentTiles = wsClients.map((c: any) => {
            const r = rectOf(c)
            return {
                x: (r.x - monX) * scale,
                y: (r.y - monY) * scale,
                w: Math.max(1, r.width  * scale),
                h: Math.max(1, r.height * scale),
            }
        })
        canvas.queue_draw()

        // Per-window widgets: the captured thumbnail with the app icon over it.
        // The icon is NOT a fallback that gets replaced — it is what the tile opens
        // with, and the texture arrives BEHIND it, so nothing jumps when a capture
        // lands late (or never).
        const activeAddresses = new Set(wsClients.map((c: any) => c.address))
        winWidgets.forEach((_: any, addr: string) => {
            if (!activeAddresses.has(addr)) {
                const w = winWidgets.get(addr)
                if (w) iconFixed.remove(w.box)
                winWidgets.delete(addr)
                captured.delete(addr)
            }
        })

        wsClients.forEach((c: any) => {
            const r = rectOf(c)
            const x = Math.round((r.x - monX) * scale)
            const y = Math.round((r.y - monY) * scale)
            const w = Math.max(2, Math.round(r.width  * scale))
            const h = Math.max(2, Math.round(r.height * scale))

            let widget = winWidgets.get(c.address)
            if (!widget) {
                const img = new Gtk.Image({
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                    hexpand: true,
                    vexpand: true,
                })
                const thumb = makeWindowThumbnail()
                // Overlay, not Box: the thumbnail takes the full tile and the icon
                // keeps its centered alignment on top of it.
                const box = new Gtk.Overlay({
                    css_classes: ["wo-schematic-icon"],
                    can_focus: false,
                    focusable: false,
                })
                box.set_child(thumb)
                box.add_overlay(img)
                iconFixed.put(box, x, y)
                widget = { box, icon: img, thumb, lastW: w, lastH: h }
                winWidgets.set(c.address, widget)
            } else {
                iconFixed.move(widget.box, x, y)
            }

            widget.lastW = w
            widget.lastH = h
            widget.box.set_size_request(w, h)
            // Same radius the Cairo tile beneath is using, clamped by this tile's
            // own box so narrow slivers do not round into lozenges.
            widget.thumb.setRadius(currentRadius)
            requestThumb(c.address, widget, w, h, force)

            // Identity FIRST, icon second. Feeding `c.class` straight to the icon
            // theme makes this surface disagree with the dock about the same
            // window: Settings is `io.Astal.ags`, a name no theme has, so it fell
            // all the way through to the generic glyph while the dock — which does
            // normalize — drew the registry's icon. Not the dock's slot mapping
            // (resolveHyprlandClass), which would draw Nautilus as the Home icon.
            const iconId = appService.resolveWindowApp(c.class || "") || c.class || "application-x-executable"
            const instance = (c as any).initialClass || (c as any).instance || ""
            let webAppIcon: string | null = null
            if (iconId.startsWith("chrome-") && iconId.endsWith("-default")) {
                const parts = iconId.split("-")
                if (parts.length >= 3) webAppIcon = parts[1]
            }
            const resolved =
                (webAppIcon ? appService.getIconName(webAppIcon) : null) ||
                appService.getIconName(iconId) ||
                appService.getIconName(instance) ||
                appService.getIconName(c.initialTitle || "") ||
                "application-x-executable"

            if (resolved.startsWith("/")) {
                widget.icon.set_from_gicon(Gio.FileIcon.new(Gio.File.new_for_path(resolved)))
            } else {
                widget.icon.set_from_icon_name(resolved)
            }

            applyIconLayout(widget, w, h)
        })
    }

    return {
        wrapper: overlay,
        sync,
        refresh: () => { armed = true; staleAll = true },
    }
}
