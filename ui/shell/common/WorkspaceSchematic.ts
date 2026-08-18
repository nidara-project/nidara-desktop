import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import appService from "../core/AppService"
import hs, { bareAddr, type ClientGeometry } from "../core/HyprlandState"
import { captureWindow } from "../core/WindowCapture"
import Wallpaper from "../core/WallpaperManager"
import { makeCoverFit } from "./DrawingUtils"
import { safeDisconnect } from "../core/signals"
import { RADIUS } from "../../lib/tokens"
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
    /** Re-solve at a different card width. The map is a scale model of the
     *  monitor, so its width is not a style — it is the denominator of every tile
     *  coordinate, and the caller derives it from the monitor (see
     *  `previewWidthFor` in WorkspaceOverview). A live resolution change makes
     *  that number wrong for as long as the widget lives, which is why this is a
     *  setter and not a construction argument. No-op when the width is unchanged. */
    setWidth: (px: number) => void
}

/**
 * Below this the capture is unreadable mush and the app icon is doing all the
 * identifying anyway — so we skip the render pass entirely rather than spend one
 * per sliver in a heavily tiled workspace.
 */
const THUMB_MIN_PX = 24

/**
 * How far the wallpaper backdrop is dimmed.
 *
 * It is not decoration: the window tiles are `--nidara-surface` (white at 0.08)
 * and would vanish against a bright photo, and the whole point of the map is
 * that windows read as foreground. Dark enough that the tiles and the card's
 * accent border keep their contrast over ANY wallpaper, light enough that you can
 * still tell which desktop you are looking at. Matches the flat 0.3 this
 * replaced closely enough that nothing else in the card had to be re-tuned.
 */
const WP_SCRIM = 0.35

/** Fallback when there is no usable wallpaper on disk: exactly what the
 *  schematic painted before it had a backdrop at all. */
const NO_WP_FILL = 0.3

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

export function createSchematicMap(wsId: number, initialWidth: number, options: SchematicOptions = {}): SchematicHandle {
    const wantThumbnails = options.thumbnails ?? false
    // Not a constant: the caller solves it from the monitor and re-solves it when
    // the monitor changes shape (see `setWidth`). Every tile coordinate below is
    // scaled by it, so the whole map is only as fresh as this number.
    let width = initialWidth
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

    // One cached cover-fit copy per canvas: the schematic's box and the app grid
    // strip's are different sizes, so they cannot share one scaled pixbuf, but
    // they DO share the decode behind it (WallpaperManager.preview).
    const coverFit = makeCoverFit()

    canvas.set_draw_func((da, cr, areaW, areaH) => {
        if (areaW <= 0 || areaH <= 0) return

        // The backdrop is now a picture, so it needs a frame: a photo running
        // into square corners inside a 24px-rounded card reads as a rendering
        // bug. Concentric with `.wo-item` (radius lg, 16px of padding), and
        // proportional so the app grid's 80px strip does not get lozenge corners.
        const bgRadius = Math.min(RADIUS.sm, areaW * 0.06, areaH * 0.06)
        cr.save()
        roundedRect(cr, 0, 0, areaW, areaH, bgRadius)
        cr.clip()

        // The wallpaper itself, dimmed — the workspace map shows the desktop it
        // is a map OF, which is what GNOME, Mission Control and KDE's overview
        // all do. Until the decode lands (and if no image resolves at all) this
        // falls back to the flat wash it used to be, so the card is never blank.
        const wp = Wallpaper.preview
        if (wp) {
            const fit = coverFit(wp, areaW, areaH)
            Gdk.cairo_set_source_pixbuf(cr, fit.pixbuf, fit.x, fit.y)
            cr.paint()
            cr.setSourceRGBA(0, 0, 0, WP_SCRIM)
        } else {
            cr.setSourceRGBA(0, 0, 0, NO_WP_FILL)
        }
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
        cr.restore()
    })

    // The decode is asynchronous and the wallpaper can change while a surface is
    // closed, so the canvas cannot just read it once at build time.
    const wpId = Wallpaper.connect("preview", () => canvas.queue_draw())
    canvas.connect("destroy", () => safeDisconnect(Wallpaper, wpId))
    // Warm at build time — the shell is idle here, and every later call is free
    // while the path and the cached copy agree. One decode is shared by every
    // schematic in the shell (five overview cards + the app grid's strip).
    Wallpaper.warmPreview()

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
            // window: Settings used to be `io.Astal.ags`, a name no theme had, so
            // it fell all the way through to the generic glyph while the dock —
            // which does normalize — drew the registry's icon. That particular
            // class is gone (the window names itself now), but the RULE is not:
            // identity is resolved, never assumed from a raw class. Not the dock's slot mapping
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
        setWidth: (px: number) => {
            const w = Math.max(1, Math.round(px))
            if (w === width) return
            width = w
            // `sync` re-derives the height from the monitor's aspect and applies
            // both size requests, so it is the whole of the resize — but it
            // returns early when it cannot find the workspace's monitor, and then
            // the requests would still describe the old width. Set them here too.
            overlay.set_size_request(width, Math.round(width * (9 / 16)))
            canvas.set_size_request(width, Math.round(width * (9 / 16)))
            sync()
        },
        // The wallpaper is re-checked here too, not only on "changed": gaming
        // hero-art swaps it through hyprland.lua, behind WallpaperManager's back.
        refresh: () => { armed = true; staleAll = true; Wallpaper.warmPreview() },
    }
}
