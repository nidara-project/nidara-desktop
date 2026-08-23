import Gtk from "gi://Gtk?version=4.0"
import { drawGlassShadow, drawSquircle, hexToFloatRgb } from "./DrawingUtils"
import Theme from "../core/ThemeManager"
import { RADIUS, GLASS_TINT } from "../../lib/tokens"

export enum Shape {
    SQUIRCLE,
    CIRCLE,
    CAPSULE,
    DOCK_PILL
}

interface SquircleContainerProps {
    /** Soft outer shadow, for surfaces that must stay legible against a FLAT backdrop
     *  (a white window behind the control centre) where the rim's white top and bottom
     *  stops vanish and only the dark flank survives. `spread` doubles as how much room
     *  the shadow needs: it forces `inset` up to at least that, which SHRINKS the
     *  painted glass by the same amount. ⚠️ Read `drawGlassShadow` before enabling it on
     *  a surface whose layer has a low `ignore_alpha` — the shadow gets blurred. */
    shadow?: { spread?: number, alpha?: number, drop?: number }
    child: Gtk.Widget
    radius?: number
    gloss?: boolean
    css_classes?: string[]
    hexpand?: boolean
    vexpand?: boolean
    color?: { r: number, g: number, b: number }
    alpha?: number
    hoverColor?: { r: number, g: number, b: number }
    hoverAlpha?: number
    onClick?: () => void
    /** Fire onClick on button RELEASE instead of PRESS. Needed when the same
     *  widget also carries a GestureDrag (notification banner swipe-to-dismiss):
     *  a press-phase click fires before any motion, so the drag can never be
     *  recognised and claim the sequence. Default false (press — snappier). */
    clickOnRelease?: boolean
    perfect?: boolean
    borderColor?: { r: number, g: number, b: number, a: number }
    hoverBorderColor?: { r: number, g: number, b: number, a: number }
    /** On hover, paint the border with the current accent at full opacity. */
    hoverBorderAccent?: boolean
    n?: number
    shape?: Shape
    borderWidth?: number
    margin?: number
    inset?: number
    padding?: number
    useShellOpacity?: boolean
    /** This capsule belongs to the shell skin: its glass tint follows
     *  Theme.chromeIsDark (pinned by appearance.shellAppearance, legible over any
     *  wallpaper) instead of the system mode. DEFAULT true — every bar/dock/overlay
     *  capsule is shell skin. Pass `chrome: false` ONLY for app-mode windows
     *  (About) that should follow the system mode like a third-party app. */
    chrome?: boolean
    /** Which opacity this capsule's glass tracks when useShellOpacity is set:
     *  "bar" → Theme.barOpacity, "overlay" (default) → Theme.overlayOpacity.
     *  (The dock paints from Theme.dockOpacity directly in DockAxis.) */
    opacityRole?: "bar" | "overlay"
    /** Active/"on" fill — while this returns true, the WHOLE capsule paints with
     *  the live accent colour instead of the base glass (standard
     *  quick-settings convention: a toggle's on-state fills its entire tile, not
     *  just its icon). Read live inside the draw call, so an accent change repaints
     *  for free via the Theme "changed" redraw below — no separate wiring needed. */
    getActive?: () => boolean
    /** Static alpha (default 0.85), or a getter for a live-varying one — a
     *  recording indicator pulsing between two alphas reads it every redraw, so
     *  `watchActive` just needs to tick a redraw timer for the pulse to animate. */
    activeAlpha?: number | (() => number)
    /** Override which colour "active" fills with — a hex string, resolved through
     *  `hexToFloatRgb`. Omit to use the live theme accent (every toggle tile:
     *  dark_mode, bt, vpn, …). Set for a FIXED semantic colour that must NOT move
     *  with the user's accent choice — e.g. screen recording uses `DANGER_HEX`,
     *  same red as every other "this needs attention" indicator. */
    activeColorHex?: string
    /** Notifies this container to redraw when the active state flips (the
     *  container has no way to know on its own — it's driven by the caller's own
     *  domain signal, e.g. BluetoothService.watchPower). */
    watchActive?: (cb: () => void) => (() => void)
    /** Fractional variant of getActive — 0..1, fills that fraction of the shape
     *  from the BOTTOM with the live accent (a "gauge": CC slider tiles), the rest
     *  with the base glass, as ONE continuous shape/border (see drawSquircle's
     *  fillFrac) instead of a separately-drawn inner fill layer. Takes priority
     *  over getActive when both are given (in practice, never both). Read live
     *  inside the draw call and re-queued via watchActive, same as getActive. */
    getFill?: () => number
}

/**
 * How far inside the widget rect the glass is actually painted, on every side —
 * `drawSquircle`'s `inset`, the buffer that keeps the border stroke off the
 * allocation edge.
 *
 * ⚠️ **The VISIBLE edge of a capsule is this far in from its allocation**, so a child
 * laid out flush to the widget rect overhangs the glass by `GLASS_INSET`. Anything
 * that has to line up with the curve — a flush panel's content margin, a scroll
 * lane's corner clearance — must subtract it, or it silently sits outside the shape.
 * That is what put the clipboard scroll pill on the panel's curve (2026-08-03).
 */
export const GLASS_INSET = 2.0

/** Resolves a shape's actual paint params for an allocated size. CIRCLE/CAPSULE
 *  always collapse to a perfect arc sized to the smaller dimension (the curve
 *  must follow the shape's own footprint, not a caller's guessed radius);
 *  DOCK_PILL/SQUIRCLE use the requested radius/n as-is. Exported so anything
 *  painting a squircle outside this component (e.g. the CC drag ghost) stays in
 *  lockstep with how a real tile renders instead of re-deriving the mapping. */
export function resolveDrawParams(
    shape: Shape, radius: number, n: number, perfect: boolean, w: number, h: number,
): { radius: number; n: number; perfect: boolean } {
    if (shape === Shape.CIRCLE || shape === Shape.CAPSULE) {
        return { radius: Math.min(w, h) / 2, n: 2.0, perfect: true }
    }
    if (shape === Shape.DOCK_PILL) {
        return { radius: radius || 24, n: 3.2, perfect }
    }
    return { radius, n, perfect }
}

export default function SquircleContainer({
    child,
    radius = RADIUS.lg,
    gloss = false,
    css_classes = [],
    hexpand = false,
    vexpand = false,
    color,
    alpha,
    hoverColor,
    hoverAlpha,
    onClick,
    clickOnRelease = false,
    perfect = false,
    borderColor,
    hoverBorderColor,
    hoverBorderAccent = false,
    n = 3.2,
    shape = Shape.SQUIRCLE,
    borderWidth = 1.0,
    inset,
    padding,
    useShellOpacity = false,
    chrome = true,
    opacityRole = "overlay",
    getActive,
    activeAlpha = 0.85,
    activeColorHex,
    watchActive,
    getFill,
    shadow,
}: SquircleContainerProps) {
    const container = new Gtk.Grid({
        css_classes,
        hexpand,
        vexpand
    })

    const da = new Gtk.DrawingArea({
        hexpand: true,
        vexpand: true
    })

    let isHovered = false
    // The shadow lives OUTSIDE the silhouette, so the inset is what reserves its room:
    // without this a `spread` larger than GLASS_INSET is simply clipped by the widget.
    const shadowSpread = shadow ? (shadow.spread ?? 4) : 0
    const techInset = Math.max(inset !== undefined ? inset : GLASS_INSET, shadowSpread)

    if (useShellOpacity || chrome) {
        Theme.connect("changed", () => { if (da.get_mapped()) da.queue_draw() })
    }

    da.set_draw_func((_, cr, w, h) => {
        if (w <= 0 || h <= 0) return
        // Shell-skin capsules (default) follow the pinned shell appearance;
        // app-mode surfaces (chrome:false, e.g. About) follow the system mode.
        const dark = chrome ? Theme.chromeIsDark : Theme.isDark
        const themeColor = dark
            ? { r: GLASS_TINT.dark.r, g: GLASS_TINT.dark.g, b: GLASS_TINT.dark.b }
            : { r: GLASS_TINT.light.r, g: GLASS_TINT.light.g, b: GLASS_TINT.light.b }
        const defaultLight = { r: GLASS_TINT.light.r, g: GLASS_TINT.light.g, b: GLASS_TINT.light.b }
        const baseColor = color || (useShellOpacity ? themeColor : defaultLight)
        // Explicit alpha always wins (even with useShellOpacity, so a surface can
        // stay theme-coloured + redraw-on-toggle yet be near-opaque — e.g. the CC
        // context menu, which floats over content with no real internal blur).
        const baseAlpha = alpha !== undefined ? alpha : (useShellOpacity ? (opacityRole === "bar" ? Theme.barOpacity : Theme.overlayOpacity) : 0.05)
        let shareColor = baseColor
        let shareAlpha = baseAlpha
        let shareBorder = borderColor
        let fillFrac: number | undefined = undefined

        if (getFill || getActive) {
            const frac = getFill ? Math.max(0, Math.min(1, getFill())) : (getActive!() ? 1 : 0)
            if (frac > 0) {
                const activeColor = hexToFloatRgb(activeColorHex ?? Theme.accentPalette[Theme.accentColor].color)
                const resolvedAlpha = typeof activeAlpha === "function" ? activeAlpha() : activeAlpha
                if (frac >= 1) {
                    shareColor = activeColor
                    shareAlpha = resolvedAlpha
                } else {
                    fillFrac = frac
                    shareColor = activeColor  // the FILLED (bottom) portion
                    shareAlpha = resolvedAlpha  // baseColor/baseAlpha (still held above) become the empty portion
                }
            }
        }

        if (isHovered) {
            if (hoverColor) shareColor = hoverColor
            if (hoverAlpha !== undefined) shareAlpha = hoverAlpha
            if (hoverBorderColor) shareBorder = hoverBorderColor
            if (hoverBorderAccent) {
                // Read the accent live so the outline tracks accent changes.
                shareBorder = { ...hexToFloatRgb(Theme.accentPalette[Theme.accentColor].color), a: 1 }
            }
        }

        // Gtk4 provides a clean surface; OVER is the standard blending mode.
        cr.setOperator(2) // OVER

        const { radius: drawRadius, n: drawN, perfect: drawPerfect } = resolveDrawParams(shape, radius, n, perfect, w, h)

        // The shadow goes down FIRST, outside the silhouette, in the room `techInset`
        // reserved for it above. Same geometry as the glass, so it tracks the shape.
        if (shadow) {
            drawGlassShadow(
                cr, techInset, techInset, w - techInset * 2, h - techInset * 2,
                drawRadius, drawN, drawPerfect,
                shadow.spread ?? 4, shadow.alpha ?? 0.18, shadow.drop ?? 1,
            )
        }

        drawSquircle(
            cr, w, h, undefined,
            shareAlpha, gloss, shareColor,
            drawRadius, drawPerfect, shareBorder,
            drawN, borderWidth, techInset,
            undefined, fillFrac, baseColor, baseAlpha,
        )
    })

    const grid = new Gtk.Grid({
        css_classes,
        hexpand,
        vexpand
    })

    // Background first (bottom)
    da.hexpand = true
    da.vexpand = true
    da.halign = Gtk.Align.FILL
    da.valign = Gtk.Align.FILL
    grid.attach(da, 0, 0, 1, 1)

    if (padding !== undefined) {
        child.margin_top = padding
        child.margin_bottom = padding
        child.margin_start = padding
        child.margin_end = padding
    }

    // Content second (top)
    grid.attach(child, 0, 0, 1, 1)

    if (hoverColor || hoverAlpha !== undefined || hoverBorderColor || hoverBorderAccent || onClick) {
        const motion = new Gtk.EventControllerMotion()
        motion.connect("enter", () => { isHovered = true; da.queue_draw() })
        motion.connect("leave", () => { isHovered = false; da.queue_draw() })
        grid.add_controller(motion)
    }

    if (onClick) {
        const click = new Gtk.GestureClick()
        // Release-phase for drag-carrying widgets (banners): a competing
        // GestureDrag that claims the sequence mid-motion then cancels this
        // click, so a swipe never also triggers the tap action.
        click.connect(clickOnRelease ? "released" : "pressed", () => onClick())
        grid.add_controller(click)
    }

    if (watchActive) {
        const cleanup = watchActive(() => { if (da.get_mapped()) da.queue_draw() })
        grid.connect("unrealize", cleanup)
    }

    // Handle for morph layers (common/MorphRevealer.ts): a morphing overlay
    // suppresses this container's own glass paint (opacity 0 on the DA — the
    // content child on top is untouched) while it paints an interpolated
    // Cairo clone of the same shape, then hands back at rest.
    ;(grid as any).glassArea = da

    return grid
}
