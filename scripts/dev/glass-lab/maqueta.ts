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
//   · one material, two variants: Regular and Clear, each with its frost, its dark smoke, its light
//     veil, its saturation and its rim. A tint is PROPORTIONAL — a smoke or a veil mixed into what
//     is behind at one strength — never a brightness ceiling: glass over a newspaper shows the
//     newspaper (owner, 2026-10-11; references/hyalo.md → "Calibrated against the reference").
//   · per piece: which variant, how thick (more tint and a little more frost — larger pieces are
//     thicker), the colour of its text, and a shadow AROUND it (never under it).
import "../gtk-init"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GObject from "gi://GObject"
import Gsk from "gi://Gsk?version=4.0"
import Graphene from "gi://Graphene"
import Pango from "gi://Pango"
import PangoCairo from "gi://PangoCairo"
import System from "system"
import Gtk4LayerShell from "gi://Gtk4LayerShell"
import { useNoGtkTheme } from "../../../ui/lib/nidara-kit/platform/gtk-theme"
import { initAppearance } from "../../../ui/lib/nidara-kit/platform/appearance-css"
import { withKitSheet } from "../../../ui/lib/nidara-kit/platform/kit-css"
import { setKitAppearance } from "../../../ui/lib/nidara-kit"
import { registerGlassMaterial } from "../../../ui/lib/nidara-kit/platform/glass-material"
import { setMaterialSource, type GlassParams, type InkParams } from "../../../ui/lib/nidara-kit/platform/material"
import { GLASS_TINT, RADIUS } from "../../../ui/lib/nidara-kit/platform/tokens"
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
interface Glass { frost: number, passes: number, smoke: number, veil: number, saturation: number, rim: number }
/** `aspect`: "modo" follows the system mode (light veil and dark text in light mode); "oscuro" keeps
 *  the smoke and white text in both — what the reference's Control Center does. */
interface Piece { glass: Variant, thick: number, aspect: "modo" | "oscuro",
    shadow: { on: boolean, alpha: number, blur: number, dy: number } }
interface State {
    dark: boolean
    scene: Scene
    backdrop: string
    regular: Glass
    clear: Glass
    common: { bevel: number, profile: number, strength: number }
    pieces: Record<PieceId, Piece>
}
const PIECE_NAMES: Record<PieceId, string> = { barra: "Barra", menu: "Menú", cc: "Centro de Control", dock: "Dock",
    promo: "Círculo promo" }
const noShadow = () => ({ on: false, alpha: 0.23, blur: 15, dy: 4 })
// Starting points, not decisions: the frost is the reference's on a Retina screen (σ ≈ 6 Regular,
// ≈ 1 Clear); the tints are proportional; the menu's shadow is the one measured on the reference.
const factory = (): State => ({
    dark: true, scene: "Escritorio", backdrop: "página de texto",
    regular: { frost: 1.2, passes: 3, smoke: 0.35, veil: 0.3, saturation: 1.25, rim: 0.5 },
    clear: { frost: 1.0, passes: 1, smoke: 0, veil: 0.1, saturation: 1.3, rim: 0.5 },
    common: { bevel: 30, profile: 4, strength: 1 },
    pieces: {
        barra: { glass: "regular", thick: 1, aspect: "modo", shadow: noShadow() },
        menu: { glass: "regular", thick: 1.8, aspect: "modo", shadow: { on: true, alpha: 0.23, blur: 15, dy: 4 } },
        cc: { glass: "regular", thick: 1, aspect: "oscuro", shadow: noShadow() },
        dock: { glass: "regular", thick: 1, aspect: "modo", shadow: noShadow() },
        promo: { glass: "clear", thick: 1, aspect: "modo", shadow: noShadow() },
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
    panelBlur: () => ({ size: GLASS_BLUR.regular.size, passes: GLASS_BLUR.regular.passes }),
    lightMode: () => !state.dark,
    onChange: (cb) => { const id = Theme.connect("changed", cb); return () => safeDisconnect(Theme, id) },
})
const pieceOf = new Map<Gtk.Native, PieceId>()
const listeners = new Set<() => void>()
const changed = () => { for (const cb of listeners) cb() }
const pieceFor = (native: Gtk.Native): Piece => state.pieces[pieceOf.get(native) ?? "promo"]
/** Whether this piece wears its dark face now: the system is dark, or the piece always is. */
const darkFace = (p: Piece) => state.dark || p.aspect === "oscuro"
/** A thicker pane absorbs more: thickness t compounds the tint as (1 − a)^t would through t panes. */
const thicken = (a: number, t: number) => Math.min(0.95, 1 - Math.pow(1 - Math.max(0, Math.min(0.95, a)), t))
const rgb = (c: { r: number, g: number, b: number }) => ({ r: c.r, g: c.g, b: c.b })
setMaterialSource({
    glass(native): GlassParams {
        const p = pieceFor(native), g = state[p.glass]
        const dark = darkFace(p)
        const a = thicken(dark ? g.smoke : g.veil, p.thick)
        // One strength everywhere (alphaMin = alphaMax, target 1): a smoke or a veil, proportional.
        return { tint: rgb(dark ? GLASS_TINT.dark : GLASS_TINT.light), alphaMin: a, alphaMax: a, target: 1,
            refraction: 40, lensing: 0.15, rim: g.rim, saturation: g.saturation }
    },
    ink(native): InkParams | null {
        // Thresholds no backdrop can miss (the kit's trackModeInk recipe): dark face → white text,
        // light face → dark text.
        const dark = darkFace(pieceFor(native))
        return { darkAbove: dark ? 2 : -1, lightBelow: dark ? 1.5 : -2, tint: rgb(GLASS_TINT.light) }
    },
    scrim: () => null,
    fusion: () => 2,
    blur(native) {
        const p = pieceFor(native), g = state[p.glass]
        return { size: g.frost * Math.sqrt(Math.max(0.5, p.thick)), passes: Math.round(g.passes) }
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
})

// The global hooks of the shader (lab_params.conf: each a delta from the factory glass).
function writeShader() {
    const lab = new Array(16).fill(0)
    lab[12] = state.common.bevel - 80          // bevel width cap, + to its 80 px
    lab[4] = state.common.profile - 5          // bevel profile exponent, + to its 5
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
function paintSynthetic(cr: any, w: number, h: number) {
    const b = state.backdrop
    const fill = (r: number, g: number, bl: number, x = 0, y = 0, ww = w, hh = h) => {
        cr.setSourceRGB(r, g, bl); cr.rectangle(x, y, ww, hh); cr.fill()
    }
    if (b === "negro") fill(0, 0, 0)
    else if (b === "gris") fill(0.5, 0.5, 0.5)
    else if (b === "mitad blanco/negro") { fill(1, 1, 1); fill(0, 0, 0, w / 2, 0, w - w / 2, h) }
    else if (b === "degradado") { for (let x = 0; x < w; x += 2) { const v = x / w; fill(v, v, v, x, 0, 2, h) } }
    else if (b === "página de texto") {
        fill(0.97, 0.97, 0.96)
        const layout = PangoCairo.create_layout(cr)
        layout.set_font_description(Pango.FontDescription.from_string("Sans 15"))
        const line = "El material de cristal deja ver lo que hay detrás y aun así se tiene que leer lo que lleva encima. "
        cr.setSourceRGB(0.08, 0.08, 0.1)
        for (let y = 8, i = 0; y < h; y += 26, i++) {
            cr.moveTo(-((i * 37) % 400), y)
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
        const s = Math.max(w / tex.get_width(), h / tex.get_height())
        const dw = tex.get_width() * s, dh = tex.get_height() * s
        snap.append_scaled_texture(tex, Gsk.ScalingFilter.LINEAR, rect((w - dw) / 2, (h - dh) / 2, dw, dh))
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
    const disc = SquircleContainer({ child: mark, shape: Shape.CIRCLE, inset: 0, useShellOpacity: true, chrome: true })
    disc.set_size_request(200, 200)
    return disc
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
        state = { ...f, ...loaded, regular: { ...f.regular, ...loaded.regular }, clear: { ...f.clear, ...loaded.clear },
            common: { ...f.common, ...loaded.common },
            pieces: Object.fromEntries((Object.keys(f.pieces) as PieceId[]).map(id =>
                [id, { ...f.pieces[id], ...loaded.pieces?.[id], shadow: { ...f.pieces[id].shadow, ...loaded.pieces?.[id]?.shadow } }])) as Record<PieceId, Piece> }
        for (const id of Object.keys(state.pieces) as PieceId[]) {
            const legacy = loaded.pieces?.[id]?.ink
            if (legacy && !loaded.pieces?.[id]?.aspect) state.pieces[id].aspect = legacy === "blanco" ? "oscuro" : "modo"
        }
        presetName = name; dirty = false
        return true
    } catch (e) { printerr(`glass-lab: preset ${name}: ${e}`); return false }
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
        page.append(slider("Ahumado (modo oscuro)", () => g.smoke, x => { g.smoke = x }, 0, 0.9, 2))
        page.append(slider("Velo (modo claro)", () => g.veil, x => { g.veil = x }, 0, 0.9, 2))
        page.append(slider("Saturación", () => g.saturation, x => { g.saturation = x }, 0.5, 2, 2))
        page.append(slider("Canto de luz", () => g.rim, x => { g.rim = x }, 0, 1.5, 2))
    }
    section("Refracción (común a todo)", "Hyalo la aplica igual a todas las piezas.")
    page.append(slider("Ancho del bisel (px)", () => state.common.bevel, x => { state.common.bevel = x }, 10, 120, 0))
    page.append(slider("Perfil del bisel", () => state.common.profile, x => { state.common.profile = x }, 1, 9, 1))
    page.append(slider("Fuerza ×", () => state.common.strength, x => { state.common.strength = x }, 0, 3, 2))
    const ids: PieceId[] = state.scene === "Círculo promo" ? ["promo"] : ["barra", "menu", "cc", "dock"]
    for (const id of ids) {
        const p = state.pieces[id]
        section(PIECE_NAMES[id])
        page.append(segmented("Cristal", ["Regular", "Clear"], () => p.glass === "regular" ? "Regular" : "Clear",
            v => { p.glass = v === "Regular" ? "regular" : "clear" }))
        page.append(slider("Grosor (más tinte y escarcha)", () => p.thick, x => { p.thick = x }, 0.5, 3, 2))
        page.append(segmented("Aspecto", ["Según modo", "Siempre oscuro"], () => p.aspect === "modo" ? "Según modo" : "Siempre oscuro",
            v => { p.aspect = v === "Según modo" ? "modo" : "oscuro" }))
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
if (SHOT) {
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
