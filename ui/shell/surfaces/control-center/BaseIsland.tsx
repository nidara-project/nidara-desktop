import { Gtk, Gdk } from "ags/gtk4"
import app from "ags/gtk4/app"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import SquircleContainer, { Shape } from "../../common/SquircleContainer"
import { WidgetSize } from "./Types"

/**
 *  BaseIsland: Geometric Identity
 * - 2x1 (WIDE): Force perfect Capsules 💊
 * - 2x2/4x1: Sync with Dock System (n=3.2)
 */
// The island's inner padding per size — single source for BaseIsland itself
// AND for IslandGrid's ContentBudget math (tile span − 2·padding). TALL
// slider tiles fill the capsule flush against the INSIDE of the drawn Cairo
// border: the border occupies ~2.75–4.25px in (glass fill at inset 2 + a
// 1.5px stroke inset a further 1.5), so padding 4 lands the fill right at the
// border's inner edge — no gap, no covering. trackH = inner width (UNIT − 2·4).
export function islandPadding(size: WidgetSize): number {
    return size === WidgetSize.TALL ? 4 : 12
}

// Per-size shape identity — SINGLE: full circle, WIDE/TALL: perfect capsule,
// FULL_WIDTH: dock-profile pill, SQUARE: squircle. Exported so anything that
// needs to preview a tile's silhouette outside BaseIsland itself (the CC drag
// ghost) stays a single source of truth with what actually renders.
export function resolveIslandShape(size: WidgetSize, width: number, height: number): { shape: Shape; radius: number } {
    if (size === WidgetSize.SINGLE) {
        return { shape: Shape.CIRCLE, radius: width / 2 }
    } else if (size === WidgetSize.WIDE) {
        // 🔒 2x1: CAPSULAS PERFECTAS (Semicircles)
        return { shape: Shape.CAPSULE, radius: height / 2 }
    } else if (size === WidgetSize.TALL) {
        // 1x2: vertical capsule — the slider fills it edge-to-edge (CAPSULE auto-
        // computes radius = min(w,h)/2, so the pill is rounded on the short axis).
        return { shape: Shape.CAPSULE, radius: width / 2 }
    } else if (size === WidgetSize.FULL_WIDTH) {
        // 4x1: Sync with Dock profile
        return { shape: Shape.DOCK_PILL, radius: height / 2 }
    } else {
        // 2x2: Squircle with Dock profile
        return { shape: Shape.SQUIRCLE, radius: 32 }
    }
}

interface BaseIslandProps {
    name: string
    child: Gtk.Widget
    width: number
    height: number
    size: WidgetSize
    alpha?: number
    gloss?: boolean
    centerContent?: boolean
    getActive?: () => boolean
    watchActive?: (cb: () => void) => (() => void)
    getFill?: () => number
    activeColorHex?: string
    activeAlpha?: number | (() => number)
}

export default function BaseIsland({
    name,
    child,
    width,
    height,
    size,
    alpha,
    gloss = true,
    centerContent = false,
    getActive,
    watchActive,
    getFill,
    activeColorHex,
    activeAlpha,
}: BaseIslandProps): Gtk.Widget {

    //  GEOMETRIC RULES:
    const { shape, radius } = resolveIslandShape(size, width, height)
    const n = 3.2 // squircle superellipse exponent

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

    const island = SquircleContainer({
        child,
        radius,
        n,
        borderWidth: 1.5,
        gloss,
        alpha,
        useShellOpacity: alpha === undefined,
        shape,
        css_classes: ["cc-island", `cc-${name}-island`],
        inset: 2.0,
        padding: islandPadding(size),
        getActive,
        watchActive,
        getFill,
        activeColorHex,
        activeAlpha,
    })

    island.set_size_request(width, height)
    return island
}
