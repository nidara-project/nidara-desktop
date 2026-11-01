import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import SquircleContainer, { Shape } from "../../common/SquircleContainer"
import { ON_WHITE } from "../../../lib/nidara-kit/platform/tokens"
import { bindWhileRealized } from "../../../lib/nidara-kit/lifetime"
import { WidgetSize } from "../../common/widget-kit"

/**
 *  BaseIsland: Geometric Identity — every tile size has the SAME corner, half a cell
 *  (owner, 2026-11-01): 1×1 a circle, 2×1/1×2/4×1 capsules, 2×2 a square with that corner.
 */
// The island's inner padding per size, from its glass — single source for BaseIsland
// itself AND for IslandGrid's ContentBudget math (tile span − 2·padding). TALL slider
// tiles fill the capsule 2 in from its glass, flush against the inside of a painted 1.5px
// border. trackH = inner width (UNIT − 2·2). (4 and 12 from the tile's box until #762,
// whose glass was painted 2 px inside it.)
export function islandPadding(size: WidgetSize): number {
    return size === WidgetSize.TALL ? 2 : 10
}

// Per-size shape identity — every size draws the same corner: half a cell (`corner`,
// handed in by IslandGrid, which owns UNIT), with circular arcs. SINGLE: that corner
// all round (a circle); WIDE/TALL/FULL_WIDTH: capsules of it; SQUARE: a square with it.
// Until 2026-11-01 the 4×1 took the dock's 3.2 profile and the 2×2 RADIUS.xl (32) at
// 3.2 — a ladder token, visibly tighter than the circle beside it. Exported so the CC
// drag ghost previews exactly what renders.
export function resolveIslandShape(
    size: WidgetSize, width: number, height: number, corner: number,
): { shape: Shape; radius: number; perfect: boolean } {
    if (size === WidgetSize.SINGLE) {
        return { shape: Shape.CIRCLE, radius: width / 2, perfect: true }
    } else if (size === WidgetSize.TALL) {
        // 1x2: vertical capsule — the slider fills it edge-to-edge (CAPSULE auto-
        // computes radius = min(w,h)/2, so the pill is rounded on the short axis).
        return { shape: Shape.CAPSULE, radius: width / 2, perfect: true }
    } else if (size === WidgetSize.WIDE || size === WidgetSize.FULL_WIDTH) {
        return { shape: Shape.CAPSULE, radius: height / 2, perfect: true }
    } else {
        return { shape: Shape.SQUIRCLE, radius: corner, perfect: true }
    }
}

interface BaseIslandProps {
    name: string
    child: Gtk.Widget
    width: number
    height: number
    size: WidgetSize
    /** Half a cell: the one corner every tile size draws (resolveIslandShape). */
    corner: number
    alpha?: number
    gloss?: boolean
    centerContent?: boolean
    getActive?: () => boolean
    watchActive?: (cb: () => void) => (() => void)
    getFill?: () => number
    activeColorHex?: string
    activeAlpha?: number | (() => number)
    /** A keyboard stop of its own (see SquircleContainer.keyboardStop). */
    keyboardStop?: boolean
}

export default function BaseIsland({
    name,
    child,
    width,
    height,
    size,
    corner,
    alpha,
    gloss = true,
    centerContent = false,
    getActive,
    watchActive,
    getFill,
    activeColorHex,
    activeAlpha,
    keyboardStop = false,
}: BaseIslandProps): Gtk.Widget {

    //  GEOMETRIC RULES:
    const { shape, radius, perfect } = resolveIslandShape(size, width, height, corner)
    const n = 3.2 // unused while every shape is `perfect`; SquircleContainer still takes one

    // WIDE capsules: pin content to the LEFT. halign FILL doesn't stretch a
    // shrink-wrapping box — GTK centres it instead, so the icon x drifts with the
    // text width (short label → more centred). START + no hexpand left-anchors every
    // tile at the same inset regardless of label length. The capsule background is
    // the DrawingArea (which still fills), so the content needn't fill. Other sizes
    // keep FILL (round buttons, sliders, media all expect to fill their island).
    if (size === WidgetSize.WIDE && !centerContent) {
        child.halign = Gtk.Align.START
        child.hexpand = false
    } else if (size === WidgetSize.WIDE && centerContent) {
        // centerContent WIDE tiles (e.g. cpu/memory) fill the width so their inner
        // CenterBox can sit dead-centre instead of drifting with content width.
        child.halign = Gtk.Align.FILL
        child.hexpand = true
    } else {
        child.halign = Gtk.Align.FILL
    }
    child.valign = Gtk.Align.FILL

    // What is ON is WHITE, its icon in the accent (owner, 2026-10-12, after the reference;
    // until then the whole tile filled with the accent). A 1×1 IS its circle, so the whole
    // tile turns white; a larger tile keeps its glass and only its icon circle does — the
    // island carries `active` and the stylesheet paints the circle (`_control-center.scss`).
    // The gauge (getFill) fills with the same white.
    const wholeIsOn = size === WidgetSize.SINGLE

    const island = SquircleContainer({
        child,
        radius,
        n,
        perfect,
        borderWidth: 1.5,
        gloss,
        alpha,
        useShellOpacity: alpha === undefined,
        shape,
        // cc-size-*: the tile's shape, which its keyboard ring (CSS) has to follow.
        css_classes: ["cc-island", `cc-${name}-island`, `cc-size-${size}`],
        padding: islandPadding(size),
        getActive: wholeIsOn ? getActive : undefined,
        watchActive,
        getFill,
        activeColorHex,
        activeColor: activeColorHex ? undefined : ON_WHITE,
        activeAlpha: activeAlpha ?? 1,
        keyboardStop,
    })
    if (getActive) {
        const sync = () => {
            if (getActive()) island.add_css_class("active")
            else island.remove_css_class("active")
        }
        sync()
        if (watchActive) bindWhileRealized(island, () => { sync(); return watchActive(sync) })
    }

    island.set_size_request(width, height)
    return island
}
