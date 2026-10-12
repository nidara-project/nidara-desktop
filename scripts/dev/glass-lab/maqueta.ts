// glass-lab: the desktop mock-up — the shell's glass on a model of the desktop, one glass, two
// variants (Regular, Clear), and per piece the properties that set it apart (owner, 2026-10-11).
//
//   scripts/dev/glass-lab/glass-lab.sh            this lab, in a window on your desktop
//   scripts/dev/glass-lab/glass-lab.sh --classic  the older bench (lab.ts: promo exports, A/B)
//
// The scene is a MODEL, not the shell: the bar's real capsules, a menu held open, the Control
// Center's real tiles and the dock's pill, laid out as on the desktop, with no app logic behind
// them. Each piece is a surface of its own, so each can wear its own glass: Hyalo takes the glass's
// numbers per surface, and this file is the material source that gives them (`setMaterialSource`),
// from its own state — no glass-tuning.conf. What is GLOBAL in Hyalo (the shader's bevel and rim
// hooks) is in a section of its own, "Refracción (común)".
//
// The model of the glass this lab is built on:
//   · one material, two variants: Regular and Clear, each with its frost and its rim. What the
//     glass does to the backdrop is each piece's TONE — the stages measured on the reference's own
//     filter (references/hyalo.md → "The tone"): Regular starts from the tones the shell ships,
//     Clear from the reference's Clear.
//   · per piece: which variant, its tone (dark and light face), the colour of its text, and a
//     shadow AROUND it (never under it).
import "../gtk-init"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk?version=4.0"
import Graphene from "gi://Graphene"
import GdkPixbuf from "gi://GdkPixbuf"
import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import System from "system"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import { useNoGtkTheme } from "../../../ui/lib/nidara-kit/platform/gtk-theme"
import { initAppearance } from "../../../ui/lib/nidara-kit/platform/appearance-css"
import { withKitSheet } from "../../../ui/lib/nidara-kit/platform/kit-css"
import { setKitAppearance } from "../../../ui/lib/nidara-kit"
import { registerGlassMaterial, GLASS_TONES, TONE_STAGES, toneStage } from "../../../ui/lib/nidara-kit/platform/glass-material"
import { setMaterialSource, type GlassParams, type GlassPiece, type GlassTone, type InkParams } from "../../../ui/lib/nidara-kit/platform/material"
import { RADIUS } from "../../../ui/lib/nidara-kit/platform/tokens"
import Theme from "../../../ui/shell/core/ThemeManager"
import { safeDisconnect } from "../../../ui/shell/core/signals"
import { GLASS_BLUR } from "../../../ui/shell/core/NidaraTheme"
import { chromeIsDarkFor } from "../../../ui/shell/common/AdaptiveGlass"
import SquircleContainer, { Shape } from "../../../ui/shell/common/SquircleContainer"
import BaseIsland from "../../../ui/shell/surfaces/control-center/BaseIsland"
import { WidgetSize } from "../../../ui/shell/common/widget-kit"
import { makeCapsuleInner, makeIconTile } from "../../../ui/shell/common/widget-kit/tile"
import { barGroup, barItem, BAR_H, BAR_MARGIN } from "../../../ui/shell/surfaces/bar/capsule"
import { uiIcon } from "../../../ui/shell/core/Icons"

const env = (k: string) => GLib.getenv(k) ?? ""
const SHADERS = env("HYALO_SHADER_DIR")
const HYALO = env("GLASS_LAB_HYALO") || "nidara-hyalo"
const PRESETS = `${env("GLASS_LAB_PRESETS") || `${GLib.get_user_data_dir()}/nidara/glass-lab`}/maqueta`
const WALLPAPERS = env("GLASS_LAB_WALLPAPERS")
const SHOT = env("GLASS_LAB_SHOT")
const REPO = env("GLASS_LAB_REPO")
if (!SHADERS) {
    printerr("glass-lab: run it through scripts/dev/glass-lab/glass-lab.sh (HYALO_SHADER_DIR unset)")
    System.exit(2)
}
GLib.mkdir_with_parents(PRESETS, 0o755)

// ── The shell's substrate, as app.ts sets it up ─────────────────────────────
useNoGtkTheme()
initAppearance()
setKitAppearance({
    accent: () => Theme.accentPalette[Theme.accentColor].color,
    surfaceIsDark: (widget) => Theme.isChromeSurface(widget) ? chromeIsDarkFor(widget) : Theme.isDark,
    onChange: (cb) => { const id = Theme.connect("changed", cb); return () => safeDisconnect(Theme, id) },
    overlayOpacity: () => Theme.overlayOpacity,
    reduceTransparency: () => Theme.reduceTransparency,
    glassFrost: () => Theme.glassFrost,
    chromeIsDark: (widget) => widget ? chromeIsDarkFor(widget) : Theme.chromeIsDark,
})
;(Theme as unknown as { applyTokens(): void }).applyTokens()

// ── State: everything a preset holds ────────────────────────────────────────
type Variant = "regular" | "clear"
type PieceId = "barra" | "menu" | "cc" | "dock" | "promo"
type Scene = "Escritorio" | "Círculo promo"
interface Glass { frost: number, passes: number, rim: number }
type ToneVals = Record<typeof TONE_STAGES[number], number>
type Faces = { dark: ToneVals, light: ToneVals }
/** `aspect`: "modo" follows the system mode (the light face and dark text in light mode); "oscuro"
 *  keeps the dark face and white text in both — what the reference's Control Center does; "fondo"
 *  follows the BACKDROP: Hyalo measures what is under the piece (the ink event) and turns it to the
 *  light face with dark content over a bright backdrop, back to the dark one over a dark one. */
type Aspect = "modo" | "oscuro" | "fondo"
interface Piece { glass: Variant, aspect: Aspect,
    /** Its Regular tone, both faces (from the shipped tone of its kind); Clear takes `clearTone`. */
    tone: Faces,
    shadow: { on: boolean, alpha: number, blur: number, dy: number } }
const FORMATS = { "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350], "9:16": [1080, 1920] } as const
type Format = keyof typeof FORMATS
interface State {
    dark: boolean
    scene: Scene
    backdrop: string
    offset: { x: number, y: number }    // the backdrop's pan, 0..1 each way
    drift: boolean                      // the backdrop moves on its own, under the glass
    driftSpeed: number
    promoSize: number                   // the disc's diameter, px (of the file: exports are at scale 1)
    format: Format                      // what an export is made at
    videoSeconds: number
    regular: Glass
    clear: Glass
    /** The reference's Clear, read from its filter (glass-probe catalogue): one tone, both faces. */
    clearTone: ToneVals
    common: { bevel: number, profile: number, strength: number }
    /** "Según fondo": to dark content above this backdrop luminance, back below the other. */
    autoInk: { darkAbove: number, lightBelow: number }
    pieces: Record<PieceId, Piece>
}
const PIECE_NAMES: Record<PieceId, string> = { barra: "Barra", menu: "Menú", cc: "Centro de Control", dock: "Dock",
    promo: "Círculo promo" }
const noShadow = () => ({ on: false, alpha: 0.23, blur: 15, dy: 4 })
/** Which kind of pane each piece is: its shipped tone. */
const KIND: Record<PieceId, GlassPiece> = { barra: "control", menu: "panel", cc: "controlCenter", dock: "dock", promo: "control" }
const vals = (t: GlassTone): ToneVals => Object.fromEntries(TONE_STAGES.map(st => [st, toneStage(t, st)])) as ToneVals
const shipped = (id: PieceId): Faces => ({ dark: vals(GLASS_TONES[KIND[id]].dark), light: vals(GLASS_TONES[KIND[id]].light) })
const toTone = (v: ToneVals): GlassTone => ({ saturation: v.saturation, ceiling: v.ceiling, lift: v.lift, gain: v.gain,
    wash: { r: v.washR, g: v.washG, b: v.washB, a: v.washA }, ambient: v.ambient, ambientLift: v.ambientLift,
    ambientGain: v.ambientGain })
const CLEAR_TONE: ToneVals = { saturation: 1.06, ceiling: 1, lift: 0.125, gain: 1.08, washR: 1, washG: 1, washB: 1, washA: 0,
    ambient: 0, ambientLift: 0, ambientGain: 1 }
// Starting points, not decisions: the frost is the reference's on a Retina screen (σ ≈ 6 Regular,
// ≈ 1 Clear); the tints are proportional; the menu's shadow is the one measured on the reference.
const factory = (): State => ({
    dark: true, scene: "Escritorio", backdrop: "página de texto",
    offset: { x: 0.5, y: 0.5 }, drift: false, driftSpeed: 1, promoSize: 200, format: "16:9", videoSeconds: 10,
    regular: { frost: 1.2, passes: 3, rim: 0.5 },
    clear: { frost: 1.0, passes: 1, rim: 0.5 },
    clearTone: { ...CLEAR_TONE },
    common: { bevel: 30, profile: 4, strength: 1 },
    autoInk: { darkAbove: 0.35, lightBelow: 0.25 },
    pieces: {
        barra: { glass: "regular", tone: shipped("barra"), aspect: "modo", shadow: noShadow() },
        menu: { glass: "regular", tone: shipped("menu"), aspect: "modo", shadow: { on: true, alpha: 0.23, blur: 15, dy: 4 } },
        cc: { glass: "regular", tone: shipped("cc"), aspect: "oscuro", shadow: noShadow() },
        dock: { glass: "regular", tone: shipped("dock"), aspect: "modo", shadow: noShadow() },
        promo: { glass: "clear", tone: shipped("promo"), aspect: "fondo", shadow: noShadow() },
    },
})
let state = factory()
let presetName = ""        // the preset loaded or last saved; "" = none
let dirty = false          // changed since

// ── The material, per piece ─────────────────────────────────────────────────
// The kit's own material is registered first (its host answers reduce-transparency and the mode
// to the kit), then replaced as the SOURCE by one that reads this state, per surface.
registerGlassMaterial({
    reduceTransparency: () => Theme.reduceTransparency,
    panelBlur: () => ({ ...GLASS_BLUR }),
    lightMode: () => !state.dark,
    onChange: (cb) => { const id = Theme.connect("changed", cb); return () => safeDisconnect(Theme, id) },
})
const pieceOf = new Map<Gtk.Native, PieceId>()
const listeners = new Set<() => void>()
const changed = () => { for (const cb of listeners) cb() }
const pieceFor = (native: Gtk.Native): Piece => state.pieces[pieceOf.get(native) ?? "promo"]
/** Whether this piece wears its dark face now: the system is dark, or the piece always is. */
const darkFace = (p: Piece) => state.dark || p.aspect === "oscuro"
/** The piece's face of its variant's tone. */
const faceTone = (p: Piece, face: "dark" | "light"): GlassTone => toTone(p.glass === "clear" ? state.clearTone : p.tone[face])
setMaterialSource({
    glass(native): GlassParams {
        const p = pieceFor(native), g = state[p.glass]
        return { refraction: 40, lensing: 0.15, rim: g.rim }
    },
    tone(native) {
        const p = pieceFor(native)
        // «Según fondo»: the dark face while the content is light, the light one once the ink event
        // turns it dark. Otherwise one face, by the mode or always dark.
        if (p.aspect === "fondo") return { tone: faceTone(p, "dark"), inkTone: faceTone(p, "light") }
        return { tone: faceTone(p, darkFace(p) ? "dark" : "light"), inkTone: null }
    },
    ink(native): InkParams | null {
        // Thresholds no backdrop can miss (the kit's trackModeInk recipe): dark face → white text,
        // light face → dark text.
        const p = pieceFor(native)
        if (p.aspect === "fondo") return { darkAbove: state.autoInk.darkAbove, lightBelow: state.autoInk.lightBelow }
        const dark = darkFace(p)
        return { darkAbove: dark ? 2 : -1, lightBelow: dark ? 1.5 : -2 }
    },
    fusion: () => 2,
    blur(native) {
        const p = pieceFor(native), g = state[p.glass]
        return { size: g.frost, passes: Math.round(g.passes) }
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
})

// The global hooks of the shader (lab_params.conf: each a delta from the factory glass).
function writeShader() {
    const lab = new Array(16).fill(0)
    lab[12] = state.common.bevel - 30          // bevel width cap, + to its 30 px
    lab[4] = state.common.profile - 4          // bevel profile exponent, + to its 4
    lab[5] = state.common.strength - 1         // refraction strength, × (1 + it)
    GLib.file_set_contents(`${SHADERS}/lab_params.conf`,
        lab.map((v, i) => v !== 0 ? `lab[${i}] = ${v}` : "").filter(Boolean).join("\n") + "\n")
}
const iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
/** Everything that follows a change of state: the mode, the shader, the glass, the shadows. */
function apply() {
    const scheme = state.dark ? "prefer-dark" : "default"
    if (iface.get_string("color-scheme") !== scheme) iface.set_string("color-scheme", scheme)
    writeShader()
    updateShadows()
    changed()
    backdropView.queue_draw()
}

// ── Backdrops ───────────────────────────────────────────────────────────────
const wallpapers: Record<string, string> = {}
if (WALLPAPERS) {
    try {
        const it = Gio.File.new_for_path(WALLPAPERS).enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
        for (let i = it.next_file(null); i; i = it.next_file(null)) {
            const n = i.get_name()
            if (/\.(jpe?g|png)$/i.test(n)) wallpapers[`foto: ${n.replace(/\.[^.]+$/, "")}`] = `${WALLPAPERS}/${n}`
        }
    } catch { /* no wallpapers: the synthetic backdrops still work */ }
}
const BACKDROPS = [...Object.keys(wallpapers).sort(), "página de texto", "blanco", "negro", "gris", "mitad blanco/negro", "degradado"]
const rect = (x: number, y: number, w: number, h: number) => { const r = new Graphene.Rect(); r.init(x, y, w, h); return r }
const textures = new Map<string, Gdk.Texture>()
const PHOTO_ZOOM = 1.4
let photoSlack = { x: 1, y: 1 }
function paintSynthetic(cr: any, w: number, h: number) {
    const b = state.backdrop, x0 = state.offset.x * w, y0 = state.offset.y * h
    const fill = (r: number, g: number, bl: number, x = 0, y = 0, ww = w, hh = h) => {
        cr.setSourceRGB(r, g, bl); cr.rectangle(x, y, ww, hh); cr.fill()
    }
    if (b === "negro") fill(0, 0, 0)
    else if (b === "gris") fill(0.5, 0.5, 0.5)
    else if (b === "mitad blanco/negro") { fill(1, 1, 1); fill(0, 0, 0, x0, 0, w - x0, h) }
    else if (b === "degradado") { for (let x = 0; x < w; x += 2) { const v = ((x - x0) / w + 1) % 1; fill(v, v, v, x, 0, 2, h) } }
    else if (b === "página de texto") {
        fill(0.97, 0.97, 0.96)
        const layout = PangoCairo.create_layout(cr)
        layout.set_font_description(Pango.FontDescription.from_string("Sans 15"))
        const line = "El material de cristal deja ver lo que hay detrás y aun así se tiene que leer lo que lleva encima. "
        cr.setSourceRGB(0.08, 0.08, 0.1)
        for (let y = 8 + (y0 % 26) - 26, i = Math.floor(-y0 / 26); y < h; y += 26, i++) {
            cr.moveTo(-((x0 + i * 37) % 400) - 400, y)
            layout.set_text(line.repeat(6), -1)
            PangoCairo.show_layout(cr, layout)
        }
    } else fill(1, 1, 1)
}
const BackdropView = GObject.registerClass(class BackdropView extends Gtk.Widget {
    vfunc_snapshot(snap: Gtk.Snapshot): void {
        const w = this.get_width(), h = this.get_height()
        if (w <= 0 || h <= 0) return
        const path = wallpapers[state.backdrop]
        if (!path) {
            const cr = snap.append_cairo(rect(0, 0, w, h))
            try { paintSynthetic(cr, w, h) } finally { cr.$dispose() }
            return
        }
        let tex = textures.get(path)
        if (!tex) { tex = Gdk.Texture.new_from_filename(path); textures.set(path, tex) }
        // Larger than the output, so there is room to pan it under the glass.
        const s = Math.max(w / tex.get_width(), h / tex.get_height()) * PHOTO_ZOOM
        const dw = tex.get_width() * s, dh = tex.get_height() * s
        photoSlack = { x: dw - w, y: dh - h }
        snap.push_clip(rect(0, 0, w, h))
        snap.append_scaled_texture(tex, Gsk.ScalingFilter.LINEAR,
            rect(-photoSlack.x * state.offset.x, -photoSlack.y * state.offset.y, dw, dh))
        snap.pop()
    }
})

// ── Layer surfaces ──────────────────────────────────────────────────────────
// Headless leaves the controls out, unless GLASS_LAB_WITH_CONTROLS asks for them (to check the column).
const WITH_CONTROLS = !SHOT || !!env("GLASS_LAB_WITH_CONTROLS")
const CONTROLS_W = WITH_CONTROLS ? 400 : 0
const E = Gtk4LayerShell.Edge
function layer(ns: string, layerKind: Gtk4LayerShell.Layer, anchors: Gtk4LayerShell.Edge[],
    margins: Partial<Record<"top" | "bottom" | "left" | "right", number>> = {}, classes: string[] = []): Gtk.Window {
    const win = new Gtk.Window({ css_classes: classes })
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, ns)
    Gtk4LayerShell.set_layer(win, layerKind)
    for (const e of anchors) Gtk4LayerShell.set_anchor(win, e, true)
    if (margins.top) Gtk4LayerShell.set_margin(win, E.TOP, margins.top)
    if (margins.bottom) Gtk4LayerShell.set_margin(win, E.BOTTOM, margins.bottom)
    if (margins.left) Gtk4LayerShell.set_margin(win, E.LEFT, margins.left)
    if (margins.right) Gtk4LayerShell.set_margin(win, E.RIGHT, margins.right)
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    return win
}
const bgWin = layer("glass-lab-backdrop", Gtk4LayerShell.Layer.BACKGROUND, [E.TOP, E.BOTTOM, E.LEFT, E.RIGHT])
const backdropView = new BackdropView({ hexpand: true, vexpand: true })
bgWin.set_child(backdropView)
// Moving the backdrop: drag it (where no piece is), or let it drift.
{
    const drag = new Gtk.GestureDrag()
    let from = { x: 0.5, y: 0.5 }
    drag.connect("drag-begin", () => { from = { ...state.offset } })
    drag.connect("drag-update", (_g, dx: number, dy: number) => {
        if (state.drift) return
        const clamp = (v: number) => Math.min(1, Math.max(0, v))
        const photo = !!wallpapers[state.backdrop]
        const w = backdropView.get_width() || 1, h = backdropView.get_height() || 1
        state.offset = photo
            ? { x: clamp(from.x - dx / Math.max(photoSlack.x, 1)), y: clamp(from.y - dy / Math.max(photoSlack.y, 1)) }
            : { x: clamp(from.x + dx / w), y: clamp(from.y + dy / h) }
        dirty = true; refreshHead(); backdropView.queue_draw()
    })
    backdropView.add_controller(drag)
}
/** Where the drift has the backdrop `k` seconds in: a slow loop, a function of time alone, so a
 *  video steps it frame by frame and comes out smooth however slowly the frames are captured. */
function driftTo(k: number) {
    const t = k * state.driftSpeed
    state.offset = { x: 0.5 - 0.5 * Math.cos(t * 2 * Math.PI / 24), y: 0.5 - 0.5 * Math.cos(t * 2 * Math.PI / 17) }
    backdropView.queue_draw()
}
let driftStart = 0, recording = false
backdropView.add_tick_callback((_w, clock) => {
    if (!state.drift || recording) { driftStart = 0; return GLib.SOURCE_CONTINUE }
    const t = clock.get_frame_time() / 1e6
    if (!driftStart) driftStart = t
    driftTo(t - driftStart)
    return GLib.SOURCE_CONTINUE
})

// A piece: a surface of its own, named as the shell's bar window (its pieces' CSS is scoped to it),
// with room round its glass for the shadow AROUND it (CSS box-shadow: outset, so never under it).
const SHADOW_ROOM = 48
const shadowCss = new Gtk.CssProvider()
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default()!, shadowCss, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
const pieceRadius: Record<PieceId, number> = { barra: 16, menu: 12, cc: 24, dock: 22, promo: 999 }
function updateShadows() {
    const css = (Object.keys(state.pieces) as PieceId[]).map(id => {
        const s = state.pieces[id].shadow
        return `.lab-shadow-${id} { border-radius: ${pieceRadius[id]}px; box-shadow: ${s.on
            ? `0 ${s.dy}px ${s.blur}px rgba(0,0,0,${s.alpha})` : "none"}; }`
    }).join("\n")
    shadowCss.load_from_string(css)
}
const pieceWins: Gtk.Window[] = []
function pieceWindow(id: PieceId, anchors: Gtk4LayerShell.Edge[], margins: Partial<Record<"top" | "bottom" | "left" | "right", number>>,
    child: Gtk.Widget): Gtk.Window {
    const win = layer(`glass-lab-${id}`, Gtk4LayerShell.Layer.TOP, anchors, margins, ["glass-lab-scene", "nidara-bar-window"])
    win.set_name("nidara-bar")
    const room = new Gtk.Box({ margin_top: SHADOW_ROOM, margin_bottom: SHADOW_ROOM, margin_start: SHADOW_ROOM, margin_end: SHADOW_ROOM })
    const holder = new Gtk.Box({ css_classes: [`lab-shadow-${id}`] })
    holder.append(child); room.append(holder); win.set_child(room)
    pieceOf.set(win as unknown as Gtk.Native, id)
    pieceWins.push(win)
    return win
}

// ── The pieces ──────────────────────────────────────────────────────────────
const UNIT = 80, GAP = 16
const label = (text: string, classes: string[] = []) =>
    new Gtk.Label({ label: text, halign: Gtk.Align.START, css_classes: classes, ellipsize: Pango.EllipsizeMode.END })
const icon = (name: string, size = 18) => new Gtk.Image({ gicon: uiIcon(name as any), pixel_size: size, css_classes: ["nd-icon"] })

/** The bar: the real bar groups (surfaces/bar/capsule.ts) in the bar's own row. */
function barPiece(): Gtk.Widget {
    const row = new Gtk.CenterBox({ css_classes: ["bar-centerbox"], height_request: BAR_H, hexpand: true })
    const left = barGroup()
    // The app's name and its menus, each an item with the bar's own padding.
    for (const t of ["Archivos", "Editar", "Ver"]) {
        const l = label(t, ["bar-widget-label"]); l.margin_start = 8; l.margin_end = 8
        left.box.append(barItem({ child: l }))
    }
    const right = barGroup()
    for (const n of ["nd-network-wireless", "nd-audio-volume-high", "nd-battery", "nd-control-center"])
        right.box.append(barItem({ child: icon(n, 18) }))
    right.box.append(barItem({ child: label("12:34", ["bar-widget-label"]) }))
    row.set_start_widget(left.widget); row.set_end_widget(right.widget)
    return row
}
/** A menu held open, as the shell's menus lay out: rows, a separator, one row under the pointer. */
function menuPiece(): Gtk.Widget {
    const rows = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 6, margin_bottom: 6,
        margin_start: 6, margin_end: 6, width_request: 220, css_classes: ["lab-menu"] })
    const row = (t: string, hot = false) => {
        const r = new Gtk.Box({ css_classes: ["nidara-menu-item", ...(hot ? ["lab-menu-hot"] : [])] })
        r.append(new Gtk.Label({ label: t, halign: Gtk.Align.START, hexpand: true, margin_start: 10, margin_end: 10,
            margin_top: 5, margin_bottom: 5 }))
        return r
    }
    for (const t of ["Deshacer", "Rehacer"]) rows.append(row(t))
    rows.append(new Gtk.Separator({ margin_top: 4, margin_bottom: 4, css_classes: ["lab-menu-sep"] }))
    for (const t of ["Cortar", "Copiar", "Pegar", "Seleccionar todo"]) rows.append(row(t, t === "Copiar"))
    rows.append(new Gtk.Separator({ margin_top: 4, margin_bottom: 4, css_classes: ["lab-menu-sep"] }))
    rows.append(row("Buscar…"))
    return SquircleContainer({ child: rows, radius: RADIUS.lg, inset: 0, useShellOpacity: true, chrome: true })
}
/** The Control Center: its real tiles (BaseIsland) on the CC grid. */
function ccPiece(): Gtk.Widget {
    const tile = (size: WidgetSize, w: number, h: number, child: Gtk.Widget, getFill?: () => number) =>
        BaseIsland({ name: "glass-lab", child, width: w, height: h, size, getFill })
    const wide = (ic: string, t: string, s: string) =>
        tile(WidgetSize.WIDE, UNIT * 2 + GAP, UNIT, makeCapsuleInner(() => uiIcon(ic as any), () => t, () => s).box)
    const single = (ic: string) => tile(WidgetSize.SINGLE, UNIT, UNIT, makeIconTile(() => uiIcon(ic as any)))
    const grid = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: GAP })
    const r1 = new Gtk.Box({ spacing: GAP }), r2 = new Gtk.Box({ spacing: GAP })
    r1.append(wide("nd-network-wireless", "Wi-Fi", "Casa")); r1.append(wide("nd-bluetooth-active", "Bluetooth", "Activado"))
    r2.append(single("nd-notifications")); r2.append(single("nd-night-light"))
    r2.append(tile(WidgetSize.WIDE, UNIT * 2 + GAP, UNIT,
        makeCapsuleInner(() => uiIcon("nd-display-brightness"), () => "Brillo", () => "60 %").box, () => 0.6))
    grid.append(r1); grid.append(r2)
    return grid
}
/** The dock: its pill, with the theme's icons (DockAxis needs the app service: a stand-in by shape). */
function dockPiece(): Gtk.Widget {
    const icons = new Gtk.Box({ spacing: 14, margin_start: 16, margin_end: 16, margin_top: 10, margin_bottom: 10 })
    for (const n of ["utilities-terminal", "system-file-manager", "web-browser", "accessories-text-editor",
        "preferences-system", "user-trash"])
        icons.append(new Gtk.Image({ icon_name: n, pixel_size: 48 }))
    return SquircleContainer({ child: icons, shape: Shape.DOCK_PILL, inset: 0, useShellOpacity: true, chrome: true })
}
/** The promotional disc: one round pane with the Nidara mark. */
function promoPiece(): Gtk.Widget {
    const mark = new Gtk.Image({ css_classes: ["glass-lab-mark"], pixel_size: 96, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${REPO}/ui/shell/assets/nidara/assets/nidara-symbolic.svg`)) })
    mark.pixel_size = Math.round(state.promoSize * 0.48)
    const disc = SquircleContainer({ child: mark, shape: Shape.CIRCLE, inset: 0, useShellOpacity: true, chrome: true })
    disc.set_size_request(state.promoSize, state.promoSize)
    return disc
}

let rebuildId = 0
function rebuildSoon() {
    if (rebuildId) GLib.source_remove(rebuildId)
    rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { rebuildId = 0; buildScene(); return GLib.SOURCE_REMOVE })
}
function buildScene() {
    for (const w of pieceWins.splice(0)) { pieceOf.delete(w as unknown as Gtk.Native); w.destroy() }
    // The controls' exclusive zone already keeps every piece out of the column: no margin for it.
    const right = 0
    const S = SHADOW_ROOM
    if (state.scene === "Círculo promo") {
        // Centred in the area beside the controls.
        const win = pieceWindow("promo", [], { right }, promoPiece())
        win.present()
    } else {
        pieceWindow("barra", [E.TOP, E.LEFT, E.RIGHT], { top: 4 - S, left: BAR_MARGIN - S, right: right + BAR_MARGIN - S }, barPiece()).present()
        pieceWindow("menu", [E.TOP, E.LEFT], { top: BAR_H + 10 - S, left: BAR_MARGIN + 40 - S }, menuPiece()).present()
        pieceWindow("cc", [E.TOP, E.RIGHT], { top: BAR_H + 12 - S, right: right + 12 - S }, ccPiece()).present()
        pieceWindow("dock", [E.BOTTOM], { bottom: 8 - S, right }, dockPiece()).present()
    }
    changed()
}

// ── Presets ─────────────────────────────────────────────────────────────────
function presetNames(): string[] {
    const out: string[] = []
    try {
        const it = Gio.File.new_for_path(PRESETS).enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
        for (let i = it.next_file(null); i; i = it.next_file(null)) if (i.get_name().endsWith(".json")) out.push(i.get_name().slice(0, -5))
    } catch { /* none yet */ }
    return out.sort((a, b) => a.localeCompare(b))
}
function savePreset(name: string) {
    GLib.file_set_contents(`${PRESETS}/${name}.json`, JSON.stringify(state, null, 1))
    presetName = name; dirty = false
}
function loadPreset(name: string): boolean {
    try {
        const [, bytes] = GLib.file_get_contents(`${PRESETS}/${name}.json`)
        const loaded = JSON.parse(new TextDecoder().decode(bytes))
        const f = factory()
        // Missing keys take the factory's, so an older preset still loads whole.
        // A preset of the machine before the tone (2026-10-11) kept a smoke, a veil, a saturation and
        // a thickness: none means anything to the tone, so none is carried over.
        const glassOf = (from: Glass, l: Record<string, number> | undefined) =>
            ({ frost: l?.frost ?? from.frost, passes: l?.passes ?? from.passes, rim: l?.rim ?? from.rim })
        state = { ...f, ...loaded, regular: glassOf(f.regular, loaded.regular), clear: glassOf(f.clear, loaded.clear),
            clearTone: { ...f.clearTone, ...loaded.clearTone },
            common: { ...f.common, ...loaded.common }, autoInk: { ...f.autoInk, ...loaded.autoInk },
            pieces: Object.fromEntries((Object.keys(f.pieces) as PieceId[]).map(id => {
                const { thick: _thick, ...lp } = loaded.pieces?.[id] ?? {}
                return [id, { ...f.pieces[id], ...lp, shadow: { ...f.pieces[id].shadow, ...lp.shadow },
                    tone: { dark: { ...f.pieces[id].tone.dark, ...lp.tone?.dark }, light: { ...f.pieces[id].tone.light, ...lp.tone?.light } } }]
            })) as Record<PieceId, Piece> }
        for (const id of Object.keys(state.pieces) as PieceId[]) {
            const legacy = loaded.pieces?.[id]?.ink
            if (legacy && !loaded.pieces?.[id]?.aspect) state.pieces[id].aspect = legacy === "blanco" ? "oscuro" : "modo"
        }
        presetName = name; dirty = false
        return true
    } catch (e) { printerr(`glass-lab: preset ${name}: ${e}`); return false }
}

// ── Exports ─────────────────────────────────────────────────────────────────
// An export is made by a second lab, headless, whose output IS the format (glass-lab.sh --size),
// at scale 1: the file is the scene drawn at the format's px, never an enlarged window. The window
// goes on working meanwhile and shows the export's progress.
const stamp = () => GLib.DateTime.new_now_local().format("%Y%m%d-%H%M%S")!
const OUT_DIR = GLib.path_get_dirname(PRESETS)        // beside the classic lab's captures and videos
function screenshot(path: string, done: (ok: boolean) => void) {
    try {
        const p = Gio.Subprocess.new([HYALO, "msg", "screenshot", path], Gio.SubprocessFlags.STDOUT_SILENCE)
        p.wait_check_async(null, (_p, res) => { try { done(p.wait_check_finish(res)) } catch { done(false) } })
    } catch { done(false) }
}
let exporting: Gio.Subprocess | null = null
function exportNative(kind: "image" | "video", report: (s: string) => void) {
    if (exporting) { report("ya hay una exportación en marcha"); return }
    const [fw, fh] = FORMATS[state.format]
    const base = `${GLib.get_tmp_dir()}/glass-lab-export-${GLib.get_monotonic_time()}`
    GLib.mkdir_with_parents(`${base}-presets/maqueta`, 0o755)
    GLib.file_set_contents(`${base}-presets/maqueta/export.json`, JSON.stringify({ ...state, drift: false }))
    const argv = [`${REPO}/scripts/dev/glass-lab/glass-lab.sh`, "--headless", `${base}.png`, "--export", kind,
        "--preset", `${base}-presets/maqueta/export.json`, "--size", `${fw}x${fh}`, "--bin", HYALO]
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE })
    // The export's preset is read from its own dir; what it writes goes to OUR output dir.
    launcher.setenv("GLASS_LAB_PRESETS", `${base}-presets`, true)
    launcher.setenv("GLASS_LAB_OUT", OUT_DIR, true)
    try { exporting = launcher.spawnv(argv) } catch (e) { report(`no se pudo lanzar la exportación: ${e}`); return }
    report(`exportando a ${fw}×${fh}…`)
    const poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        try { report(new TextDecoder().decode(GLib.file_get_contents(`${base}.progress`)[1])) } catch { /* not yet */ }
        return GLib.SOURCE_CONTINUE
    })
    exporting.wait_async(null, () => {
        GLib.source_remove(poll)
        exporting = null
        let text = ""
        try { text = new TextDecoder().decode(GLib.file_get_contents(`${base}.txt`)[1]).split("\n").slice(1).join("\n").trim() }
        catch { /* no result */ }
        report(text || "la exportación falló")
    })
}
/** Headless (the export's own lab): one image, or a video with the backdrop drifting under the glass. */
function runExport(kind: string) {
    const out = env("GLASS_LAB_OUT") || OUT_DIR
    const finish = (msg: string) => { GLib.file_set_contents(SHOT.replace(/\.png$/, ".txt"), `maqueta\n${msg}\n`); loop.quit() }
    const progress = (msg: string) => GLib.file_set_contents(SHOT.replace(/\.png$/, ".progress"), msg)
    const json = (path: string) => GLib.file_set_contents(path, JSON.stringify(state, null, 1))
    if (kind === "image") {
        const path = `${out}/captura-${stamp()}.png`
        screenshot(path, ok => { if (ok) json(path.replace(/\.png$/, ".json")); finish(ok ? `guardada: ${path}` : "no se pudo capturar") })
        return
    }
    const FPS = 60, frames = Math.max(1, Math.round(state.videoSeconds * FPS))
    const path = `${out}/video-${stamp()}.mp4`
    const frame = `${GLib.get_tmp_dir()}/glass-lab-frame-${GLib.get_monotonic_time()}.ppm`
    const [fw, fh] = FORMATS[state.format]
    let ff: Gio.Subprocess, pipe: Gio.OutputStream
    try {
        ff = Gio.Subprocess.new(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", `${FPS}`, "-i", "-",
            "-vf", `crop=${fw}:${fh}:0:0`, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", path], Gio.SubprocessFlags.STDIN_PIPE)
        pipe = ff.get_stdin_pipe()!
    } catch (e) { finish(`no se pudo arrancar ffmpeg: ${e}`); return }
    recording = true
    const step = (i: number) => {
        if (i >= frames) {
            try { pipe.close(null) } catch { /* closed */ }
            ff.wait_check_async(null, (_p, res) => {
                let ok = false; try { ok = ff.wait_check_finish(res) } catch { /* below */ }
                if (ok) json(path.replace(/\.mp4$/, ".json"))
                finish(ok ? `vídeo: ${state.videoSeconds} s, ${fw}×${fh}\n${path}` : "ffmpeg falló")
            })
            return
        }
        driftTo(i / FPS)
        // A few ms for the backdrop's new frame to be painted and committed before the capture.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            screenshot(frame, ok => {
                if (!ok) { finish(`captura fallida en el fotograma ${i}`); return }
                try { pipe.write_all(GLib.file_get_contents(frame)[1], null); Gio.File.new_for_path(frame).delete(null) }
                catch (e) { finish(`ffmpeg dejó de leer: ${e}`); return }
                if (i % 30 === 0) progress(`grabando… ${i}/${frames}`)
                step(i + 1)
            })
            return GLib.SOURCE_REMOVE
        })
    }
    step(0)
}

// ── The controls ────────────────────────────────────────────────────────────
{
    const css = `${REPO}/ui/shell/style.css`
    const provider = new Gtk.CssProvider()
    provider.load_from_string((GLib.file_test(css, GLib.FileTest.EXISTS) ? withKitSheet(css) : "") + `
        window.glass-lab-scene, window.glass-lab-scene > * { background: none; }
        .glass-lab-mark { color: var(--nidara-text); }
        .lab-menu label { color: var(--nidara-text); }
        .lab-menu-hot { background: var(--nidara-accent); border-radius: 6px; }
        .lab-menu-hot label { color: white; }
        .lab-menu-sep { min-height: 1px; background: alpha(currentColor, 0.15); }
        window.lab-controls { background: #ececf0; color: #1d1d22; font-size: 13px; }
        window.lab-controls.dark { background: #1f1f24; color: #ececf0; }
        window.lab-controls .lab-head { padding: 14px 16px 12px 16px; border-bottom: 1px solid alpha(currentColor, 0.12); }
        window.lab-controls .lab-title { font-weight: 700; font-size: 15px; }
        window.lab-controls .lab-section { font-weight: 700; font-size: 14px; margin-top: 18px; }
        window.lab-controls .lab-note { opacity: 0.65; font-size: 11px; }
        window.lab-controls .lab-value { font-family: monospace; font-size: 12px; opacity: 0.8; }
        window.lab-controls .lab-dirty { color: #c26a00; font-size: 11px; }
        window.lab-controls button { padding: 4px 10px; border-radius: 6px; background: alpha(currentColor, 0.08); }
        window.lab-controls button:hover { background: alpha(currentColor, 0.14); }
        window.lab-controls button.lab-on { background: var(--nidara-accent); color: white; }
        window.lab-controls entry { padding: 4px 8px; border-radius: 6px; background: alpha(currentColor, 0.06);
            border: 1px solid alpha(currentColor, 0.2); }
        window.lab-controls scrollbar { background: transparent; }
        window.lab-controls scrollbar slider { min-width: 8px; min-height: 40px; border-radius: 4px;
            background: alpha(currentColor, 0.35); margin: 2px; }`)
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default()!, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
}
const controlsWin = layer("glass-lab-controls", Gtk4LayerShell.Layer.TOP, [E.TOP, E.BOTTOM, E.RIGHT], {}, ["lab-controls"])
Gtk4LayerShell.set_exclusive_zone(controlsWin, CONTROLS_W)
Gtk4LayerShell.set_keyboard_mode(controlsWin, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
controlsWin.set_size_request(CONTROLS_W, -1)
const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
controlsWin.set_child(column)
const headBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, css_classes: ["lab-head"] })
const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.ALWAYS,
    overlay_scrolling: false, vexpand: true })
column.append(headBox); column.append(scroller)

/** Something changed in the state: the scene follows, the header says it is unsaved. */
function touched() { dirty = true; apply(); refreshHead() }

const note = (t: string) => new Gtk.Label({ label: t, xalign: 0, wrap: true, css_classes: ["lab-note"] })
function slider(title: string, get: () => number, set: (v: number) => void, min: number, max: number, decimals = 2): Gtk.Widget {
    const fmt = (v: number) => v.toFixed(decimals).replace(".", ",")
    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    const head = new Gtk.Box({ spacing: 8 })
    const value = new Gtk.Label({ label: fmt(get()), css_classes: ["lab-value"] })
    head.append(new Gtk.Label({ label: title, xalign: 0, hexpand: true, wrap: true })); head.append(value)
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, decimals === 0 ? 1 : 10 ** -decimals)
    scale.set_draw_value(false); scale.set_value(get())
    scale.connect("value-changed", () => {
        let v = scale.get_value(); if (decimals === 0) v = Math.round(v)
        value.set_label(fmt(v)); set(v); touched()
    })
    // The wheel scrolls the column, never the value under the pointer.
    const wheel = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL })
    wheel.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    wheel.connect("scroll", (_c: Gtk.EventControllerScroll, _dx: number, dy: number) => {
        const adj = scroller.get_vadjustment(); adj.set_value(adj.get_value() + dy * 48); return true
    })
    scale.add_controller(wheel)
    row.append(head); row.append(scale)
    return row
}
/** A row of buttons, one of them on: a choice you can see whole. */
function segmented(title: string, options: string[], get: () => string, set: (v: string) => void, after?: () => void): Gtk.Widget {
    const row = new Gtk.Box({ spacing: 8 })
    if (title) row.append(new Gtk.Label({ label: title, xalign: 0, hexpand: true }))
    const group = new Gtk.Box({ spacing: 4 })
    const buttons = options.map(o => {
        const b = new Gtk.Button({ label: o })
        b.connect("clicked", () => { set(o); for (const x of buttons) x.remove_css_class("lab-on"); b.add_css_class("lab-on"); touched(); after?.() })
        if (get() === o) b.add_css_class("lab-on")
        group.append(b); return b
    })
    row.append(group)
    return row
}
function dropdown(title: string, options: string[], get: () => string, set: (v: string) => void): Gtk.Widget {
    const row = new Gtk.Box({ spacing: 8 })
    row.append(new Gtk.Label({ label: title, xalign: 0, hexpand: true }))
    const dd = Gtk.DropDown.new_from_strings(options)
    dd.set_selected(Math.max(0, options.indexOf(get())))
    dd.connect("notify::selected", () => { set(options[dd.get_selected()]); touched() })
    row.append(dd)
    return row
}
function toggle(title: string, get: () => boolean, set: (v: boolean) => void): Gtk.Widget {
    const row = new Gtk.Box({ spacing: 8 })
    row.append(new Gtk.Label({ label: title, xalign: 0, hexpand: true }))
    const sw = new Gtk.Switch({ active: get(), valign: Gtk.Align.CENTER })
    sw.connect("notify::active", () => { set(sw.active); touched() })
    row.append(sw)
    return row
}

// The header: always on screen — which preset, saving it, the mode, the scene, the backdrop.
let dirtyLabel: Gtk.Label
function fillHead() {
    for (let c = headBox.get_first_child(); c; c = headBox.get_first_child()) headBox.remove(c)
    headBox.append(new Gtk.Label({ label: "Laboratorio de cristal", xalign: 0, css_classes: ["lab-title"] }))
    // Preset: the dropdown SHOWS the loaded one.
    const names = presetNames()
    const options = ["(sin preset)", ...names]
    const presetRow = new Gtk.Box({ spacing: 6 })
    const dd = Gtk.DropDown.new_from_strings(options)
    dd.hexpand = true
    dd.set_selected(Math.max(0, options.indexOf(presetName)))
    dd.connect("notify::selected", () => {
        const v = options[dd.get_selected()]
        if (v === "(sin preset)" || v === presetName) return
        if (loadPreset(v)) { apply(); buildScene(); fillAll() }
    })
    const save = new Gtk.Button({ label: "Guardar" })
    save.connect("clicked", () => { if (presetName) { savePreset(presetName); refreshHead() } else saveAs.set_visible(true) })
    const asBtn = new Gtk.Button({ label: "Guardar como…" })
    presetRow.append(dd); presetRow.append(save); presetRow.append(asBtn)
    headBox.append(presetRow)
    const saveAs = new Gtk.Box({ spacing: 6, visible: false })
    const entry = new Gtk.Entry({ placeholder_text: "Nombre del preset", hexpand: true })
    const ok = new Gtk.Button({ label: "Guardar" })
    const doSave = () => {
        const n = entry.get_text().trim().replace(/[\/]/g, "-")
        if (!n) return
        savePreset(n); fillHead()
    }
    ok.connect("clicked", doSave); entry.connect("activate", doSave)
    saveAs.append(entry); saveAs.append(ok)
    asBtn.connect("clicked", () => { saveAs.set_visible(!saveAs.get_visible()); entry.grab_focus() })
    headBox.append(saveAs)
    dirtyLabel = new Gtk.Label({ xalign: 0, css_classes: ["lab-dirty"] })
    headBox.append(dirtyLabel)
    headBox.append(segmented("Apariencia", ["Oscuro", "Claro"], () => state.dark ? "Oscuro" : "Claro", v => { state.dark = v === "Oscuro" },
        () => { if (state.dark) controlsWin.add_css_class("dark"); else controlsWin.remove_css_class("dark") }))
    headBox.append(segmented("Escena", ["Escritorio", "Círculo promo"], () => state.scene, v => { state.scene = v as Scene },
        () => { buildScene(); fillBody() }))
    headBox.append(dropdown("Fondo", BACKDROPS, () => state.backdrop, v => { state.backdrop = v }))
    refreshHead()
}
function refreshHead() {
    dirtyLabel?.set_label(dirty ? (presetName ? `Cambios sin guardar en «${presetName}»` : "Cambios sin guardar") : "")
}

function fillBody() {
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_start: 16, margin_end: 16,
        margin_top: 4, margin_bottom: 24 })
    const at = scroller.get_vadjustment().get_value()
    scroller.set_child(page)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { scroller.get_vadjustment().set_value(at); return GLib.SOURCE_REMOVE })
    const section = (title: string, sub = "") => {
        page.append(new Gtk.Label({ label: title, xalign: 0, css_classes: ["lab-section"] }))
        if (sub) page.append(note(sub))
    }
    for (const v of ["regular", "clear"] as Variant[]) {
        const g = state[v]
        section(v === "regular" ? "Cristal Regular" : "Cristal Clear",
            "Propiedades generales de la variante. Cada pieza elige variante abajo.")
        page.append(slider("Escarcha: tamaño", () => g.frost, x => { g.frost = x }, 0.3, 6, 2))
        page.append(slider("Escarcha: pasadas", () => g.passes, x => { g.passes = x }, 1, 5, 0))
        page.append(slider("Canto de luz", () => g.rim, x => { g.rim = x }, 0, 1.5, 2))
    }
    section("Refracción (común a todo)", "Hyalo la aplica igual a todas las piezas.")
    page.append(slider("Ancho del bisel (px)", () => state.common.bevel, x => { state.common.bevel = x }, 10, 120, 0))
    page.append(slider("Perfil del bisel", () => state.common.profile, x => { state.common.profile = x }, 1, 9, 1))
    page.append(slider("Fuerza ×", () => state.common.strength, x => { state.common.strength = x }, 0, 3, 2))
    section("Cambio según el fondo", "Para las piezas con aspecto «Según fondo»: Hyalo mide el punto más oscuro bajo su "
        + "contenido. Por encima del primer umbral pasan a velo claro con texto e icono oscuros; vuelven por debajo del segundo "
        + "(el hueco evita el parpadeo). Luminancia 0 = negro, 1 = blanco.")
    page.append(slider("Pasar a oscuro por encima de", () => state.autoInk.darkAbove, x => { state.autoInk.darkAbove = x }, 0.05, 0.95, 2))
    page.append(slider("Volver a claro por debajo de", () => state.autoInk.lightBelow, x => { state.autoInk.lightBelow = x }, 0.02, 0.9, 2))
    section("Fondo", "Arrastra el fondo con el ratón donde no hay piezas, o déjalo moverse solo.")
    page.append(toggle("Mover solo", () => state.drift, x => { state.drift = x }))
    page.append(slider("Velocidad", () => state.driftSpeed, x => { state.driftSpeed = x }, 0.2, 4, 1))
    if (state.scene === "Círculo promo") {
        section("Círculo promo")
        // The disc is rebuilt once the slider rests, not on every step.
        page.append(slider("Tamaño (px del archivo)", () => state.promoSize, x => { state.promoSize = x; rebuildSoon() }, 48, 720, 0))
    }
    section("Exportar", "Se hace aparte, al tamaño exacto del formato; la ventana sigue funcionando.")
    page.append(segmented("Formato", Object.keys(FORMATS), () => state.format, v => { state.format = v as Format }))
    page.append(slider("Duración del vídeo (s)", () => state.videoSeconds, x => { state.videoSeconds = x }, 1, 30, 0))
    const exportRow = new Gtk.Box({ spacing: 6 })
    const status = new Gtk.Label({ xalign: 0, wrap: true, css_classes: ["lab-note"], selectable: true })
    for (const [t, k] of [["Exportar imagen", "image"], ["Exportar vídeo", "video"]] as const) {
        const b = new Gtk.Button({ label: t, hexpand: true })
        b.connect("clicked", () => exportNative(k, m => status.set_label(m)))
        exportRow.append(b)
    }
    page.append(exportRow); page.append(status)
    const ids: PieceId[] = state.scene === "Círculo promo" ? ["promo"] : ["barra", "menu", "cc", "dock"]
    for (const id of ids) {
        const p = state.pieces[id]
        section(PIECE_NAMES[id])
        page.append(segmented("Cristal", ["Regular", "Clear"], () => p.glass === "regular" ? "Regular" : "Clear",
            v => { p.glass = v === "Regular" ? "regular" : "clear" }))
        // Its tone, the face it wears now (in «según fondo», the dark one; the light one is the ink's).
        const face: "dark" | "light" = darkFace(p) ? "dark" : "light"
        const t = (): ToneVals => p.glass === "clear" ? state.clearTone : p.tone[face]
        page.append(note(p.glass === "clear" ? "Tono: el Clear de la referencia (común a las piezas Clear)."
            : `Tono Regular de esta pieza, cara ${face === "dark" ? "oscura" : "clara"}.`))
        const TONE_ROWS: [typeof TONE_STAGES[number], string, number, number][] = [
            ["saturation", "Saturación", 0, 2], ["ceiling", "Techo", 0, 1], ["lift", "Niveles: negro", 0, 1],
            ["gain", "Niveles: blanco", 0, 1.5], ["washA", "Velado: opacidad", 0, 1], ["ambient", "Luz ambiente", 0, 1]]
        for (const [st, title, min, max] of TONE_ROWS) page.append(slider(title, () => t()[st], x => { t()[st] = x }, min, max, 3))
        const ASPECTS: [string, Aspect][] = [["Según modo", "modo"], ["Siempre oscuro", "oscuro"], ["Según fondo", "fondo"]]
        page.append(segmented("Aspecto", ASPECTS.map(a => a[0]), () => ASPECTS.find(a => a[1] === p.aspect)![0],
            v => { p.aspect = ASPECTS.find(a => a[0] === v)![1] }))
        page.append(toggle("Sombra alrededor", () => p.shadow.on, x => { p.shadow.on = x }))
        page.append(slider("  opacidad", () => p.shadow.alpha, x => { p.shadow.alpha = x }, 0, 0.8, 2))
        page.append(slider("  desenfoque (px)", () => p.shadow.blur, x => { p.shadow.blur = x }, 0, 40, 0))
        page.append(slider("  desplazamiento abajo (px)", () => p.shadow.dy, x => { p.shadow.dy = x }, 0, 20, 0))
    }
    const reset = new Gtk.Button({ label: "Volver a los valores de partida", margin_top: 18 })
    reset.connect("clicked", () => { const keep = state.backdrop; state = factory(); state.backdrop = keep; presetName = ""; touched(); buildScene(); fillAll() })
    page.append(reset)
}
function fillAll() { fillHead(); fillBody() }

// ── Start ───────────────────────────────────────────────────────────────────
if (env("GLASS_LAB_PRESET")) loadPreset(GLib.path_get_basename(env("GLASS_LAB_PRESET")).replace(/\.json$/, ""))
if (env("GLASS_LAB_BG")) state.backdrop = env("GLASS_LAB_BG")
if (env("GLASS_LAB_SCENE")) state.scene = env("GLASS_LAB_SCENE") as Scene
if (env("GLASS_LAB_LIGHT")) state.dark = false
apply()
bgWin.present()
buildScene()
const loop = GLib.MainLoop.new(null, false)
if (SHOT && env("GLASS_LAB_EXPORT")) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => { runExport(env("GLASS_LAB_EXPORT")); return GLib.SOURCE_REMOVE })
} else if (SHOT) {
    // Headless: one capture of the scene once the glass has settled, then quit.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
        try {
            const p = Gio.Subprocess.new([HYALO, "msg", "screenshot", SHOT], Gio.SubprocessFlags.STDOUT_SILENCE)
            p.wait_check_async(null, () => { GLib.file_set_contents(SHOT.replace(/\.png$/, ".txt"), "maqueta\nok\n"); loop.quit() })
        } catch { loop.quit() }
        return GLib.SOURCE_REMOVE
    })
}
if (WITH_CONTROLS) {
    if (state.dark) controlsWin.add_css_class("dark")
    fillAll()
    controlsWin.present()
}
loop.run()
