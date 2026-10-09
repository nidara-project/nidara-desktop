// glass-lab — the glass material on the bench: the shell's own pieces, over chosen backdrops,
// on a Hyalo of their own, with every number and every layer on a slider.
//
//   scripts/dev/glass-lab/glass-lab.sh              a window on your desktop (a nested Hyalo)
//   scripts/dev/glass-lab/glass-lab.sh --headless   one capture + measurements, nothing on screen
//
// Run it through glass-lab.sh, never by hand: the script gives it a sandbox (its own
// glass-tuning.conf, the glass shader through HYALO_SHADER_DIR, settings in memory) and the Hyalo it
// draws on. What this file needs from that environment:
//
//   GLASS_LAB_TUNING    the glass-tuning.conf the material reads (under $XDG_CONFIG_HOME/nidara)
//   HYALO_SHADER_DIR    where Hyalo reads the glass shader (hyalo's glass_final.glsl, linked)
//                       and lab_params.conf, which this writes
//   GLASS_LAB_HYALO     the Hyalo binary, for `msg screenshot` against the nested compositor
//   GLASS_LAB_PRESETS   where presets and captures are kept (outside the sandbox)
//   GLASS_LAB_WALLPAPERS  the factory wallpapers, offered as backdrops
//   GLASS_LAB_SHOT      headless: capture here, print the measurements, quit
//   GLASS_LAB_PRESET    a preset file to start from
//
// What it is FOR (the study in #705): the same panes the shell draws — bar groups, Control
// Center tiles, a notification stack, round buttons, a tooltip, a menu — so a number tried
// here is the number the desktop will show. Two pieces are stand-ins, marked as such on
// screen, because their real component cannot live outside the shell: the dock (DockAxis needs
// the app service) and the island (MorphRevealer needs the shell's state).
//
// The ink (which pieces turn their text dark together) is the study's open question, so it is
// a control: per piece (today), per group, per panel — `trackInkGroup` on the containers.
import "../gtk-init"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
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
import { setKitAppearance, NidaraCircleButton, NidaraButton, attachTooltip } from "../../../ui/lib/nidara-kit"
import { registerGlassMaterial, GLASS_MATERIAL_DEFAULTS, GLASS_DENSE_DEFAULTS } from "../../../ui/lib/nidara-kit/platform/glass-material"
import { trackFluidCrystal, trackScrimRegion, trackNoScrim, trackInkGroup, trackNoInk, trackDenseGlass, INK_DARK_CLASS } from "../../../ui/lib/nidara-kit/platform/material"
import { RADIUS, rowInsetFor } from "../../../ui/lib/nidara-kit/platform/tokens"
import Theme from "../../../ui/shell/core/ThemeManager"
import { safeDisconnect } from "../../../ui/shell/core/signals"
import { GLASS_BLUR } from "../../../ui/shell/core/NidaraTheme"
import { chromeIsDarkFor } from "../../../ui/shell/common/AdaptiveGlass"
import SquircleContainer, { Shape, GLASS_SHADOW, GLASS_INSET } from "../../../ui/shell/common/SquircleContainer"
import BaseIsland from "../../../ui/shell/surfaces/control-center/BaseIsland"
import { WidgetSize } from "../../../ui/shell/common/widget-kit"
import { makeCapsuleInner, makeIconTile } from "../../../ui/shell/common/widget-kit/tile"
import { makeGroupStack } from "../../../ui/shell/surfaces/control-center/NotificationCenter"
import { barGroup, barItem, BAR_H, BAR_MARGIN } from "../../../ui/shell/surfaces/bar/capsule"
import { menuRow, menuSeparator } from "../../../ui/shell/common/MenuRow"
import { createSquirclePath } from "../../../ui/lib/nidara-kit/platform/glass-paint"
import { uiIcon } from "../../../ui/shell/core/Icons"

const env = (k: string) => GLib.getenv(k) ?? ""
const TUNING = env("GLASS_LAB_TUNING")
const SHADERS = env("HYALO_SHADER_DIR")
const HYALO = env("GLASS_LAB_HYALO") || "nidara-hyalo"
const PRESETS = env("GLASS_LAB_PRESETS") || `${GLib.get_user_data_dir()}/nidara/glass-lab`
const WALLPAPERS = env("GLASS_LAB_WALLPAPERS")
const SHOT = env("GLASS_LAB_SHOT")
const REPO = env("GLASS_LAB_REPO")
if (!TUNING || !SHADERS) {
    printerr("glass-lab: run it through scripts/dev/glass-lab/glass-lab.sh (GLASS_LAB_TUNING / HYALO_SHADER_DIR unset)")
    System.exit(2)
}

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
// The token sheet the shell's windows wear — the chrome skin, and the light skin a pane takes when
// its ink turns dark (`generateSkinFlipScope`). The shell applies it from its own start-up path
// (syncGtkTheme), which also writes gsettings; the lab wants only the CSS.
;(Theme as unknown as { applyTokens(): void }).applyTokens()
// The shell's glass on Hyalo (core/CompositorGlass.ts, with hyalo-settings' blur baseline).
registerGlassMaterial({
    reduceTransparency: () => Theme.reduceTransparency,
    panelBlur: () => ({ size: GLASS_BLUR.regular.size, passes: GLASS_BLUR.regular.passes }),
    lightMode: () => !Theme.isDark,
    onChange: (cb) => { const id = Theme.connect("changed", cb); return () => safeDisconnect(Theme, id) },
})
{
    const css = `${REPO}/ui/shell/style.css`
    const provider = new Gtk.CssProvider()
    provider.load_from_string((GLib.file_test(css, GLib.FileTest.EXISTS) ? withKitSheet(css) : "") + `
        window.glass-lab-scene, window.glass-lab-scene > * { background: none; }
        .glass-lab-tag { color: rgba(255,255,255,0.9); background: rgba(0,0,0,0.55); border-radius: 4px;
                         padding: 1px 6px; font-size: 11px; }
        window.glass-lab-controls, window.glass-lab-controls scrolledwindow { background: #ececf0; color: #1d1d22; }
        window.glass-lab-controls.dark, window.glass-lab-controls.dark scrolledwindow { background: #1f1f24; color: #ececf0; }
        .glass-lab-mark { color: var(--nidara-text); }
        .glass-lab-readout { font-family: monospace; font-size: 12px; }
        .glass-lab-row-title { font-weight: 600; }
        .glass-lab-row-sub { opacity: 0.65; font-size: 11px; }
        .glass-lab-value { font-family: monospace; font-size: 12px; opacity: 0.8; }
        .glass-lab-section > title label { font-weight: 700; font-size: 14px; }
        .glass-lab-footer { opacity: 0.65; font-size: 11px; }`)
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default()!, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
    if (!GLib.file_test(css, GLib.FileTest.EXISTS)) printerr(`glass-lab: ${css} missing — compile the shell's SCSS first`)
}

// ── State: everything a preset holds ────────────────────────────────────────
type Ink = "pieza" | "grupo" | "panel"
// Which pieces are on the bench. One at a time keeps a neighbour's shadow (the Control Center's
// fades over 160 px) off the reading; «todas» is the overview.
const SHOWS = ["tipos de cristal", "todas", "barra", "centro de control", "avisos", "botones y tooltip", "isla y dock",
    "panel grande", "promo: logo"] as const
type Show = typeof SHOWS[number]
// What every export is cut to, and the size it is written at: drawn natively at that size, never
// the window's.
const FORMATS = { "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350], "9:16": [1080, 1920] } as const
type PromoFormat = keyof typeof FORMATS
interface LabState {
    backdrop: string
    offset: number                 // the backdrop's split/pan, 0..1 of the width
    offsetY: number                // its vertical pan, 0..1
    drift: boolean                 // the backdrop moves on its own, under the glass
    driftSpeed: number             // × the drift's pace
    promoSize: number              // the promotional disc's diameter, px
    videoSeconds: number           // how long an exported video runs
    promoFormat: PromoFormat       // the frame every export is cut to (the name predates the scene's)
    ink: Ink
    show: Show
    tuning: Record<string, number> // glass-tuning.conf keys, only those off the factory value
                                   // (and blurSize/blurPasses, written as its `blur`)
    flags: { ink: boolean, scrim: boolean, glass: boolean, dark: boolean }
    lab: number[]                  // lab_params.conf, 16 values: the shader's LAB hooks, 0 = factory
    dense: Record<string, number>  // the dense type's keys (`dense.<key>`), only those off its defaults
                                   // (and blurSize/blurPasses, written as its `dense.blur`)
    elevation: Record<GlassType, Elevation>   // the shadow around each type (the lab's, on trial)
    types: Record<BenchPiece, GlassType>      // the type each piece of the bench wears
}
// The TYPES of glass (2026-10-08, owner: "several types of glass, each with its controls, and a
// piece can change its type"). Measured on the reference (glass-probe FINDINGS, «Elevación,
// densidad y geometría del Dock»): the dock, the Control Center and the dock's label are GLASS —
// translucent, no shadow, edged by a 1 px line; menus and large panels are DENSE — ≈0.98 of the
// mode's colour, with a drop shadow OUTSIDE them, offset down (menus 0.23 · 15 px · 4 px, large
// panels 0.39 · 38 px · 18 px; stronger in dark mode). A type is the GLASS's own properties, never a
// layer over it (owner: "a glass with other properties, not a glass with a sticker"): the dense
// type is the material's (`trackDenseGlass`, `dense.<key>` in glass-tuning.conf). Only the shadow
// around is the lab's, drawn behind the piece, until the compositor learns it. A type is per
// SURFACE, so every piece of the bench is a window of its own.
type GlassType = "cristal" | "denso"
const GLASS_TYPES: GlassType[] = ["cristal", "denso"]
interface Elevation { alpha: number, blur: number, dy: number }
type BenchPiece = "menú" | "centro de control"
const BENCH_PIECES: BenchPiece[] = ["menú", "centro de control"]
const factory = (): LabState => ({ backdrop: "blanco", offset: 0.5, offsetY: 0.5, drift: false, driftSpeed: 1,
    promoSize: 72, videoSeconds: 10, promoFormat: "16:9", ink: "pieza", show: "tipos de cristal", tuning: {},
    flags: { ink: true, scrim: true, glass: true, dark: true }, lab: new Array(16).fill(0), dense: {},
    elevation: { cristal: { alpha: 0, blur: 15, dy: 4 }, denso: { alpha: 0.23, blur: 15, dy: 4 } },
    types: { "menú": "denso", "centro de control": "cristal" } })
let state = factory()

function writeFile(path: string, text: string) {
    GLib.file_set_contents(path, text)
}
// The system's light/dark mode, which the kit's own controls follow (GSettings are in memory here).
// The controls' window follows it too: the kit's text turns white in dark mode, and a light
// window under it left that text unreadable.
const iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
let controlsWinRef: Gtk.Window | null = null
function apply() {
    const scheme = state.flags.dark === false ? "default" : "prefer-dark"
    if (iface.get_string("color-scheme") !== scheme) iface.set_string("color-scheme", scheme)
    if (state.flags.dark === false) controlsWinRef?.remove_css_class("dark"); else controlsWinRef?.add_css_class("dark")
    const lines = ["# written by glass-lab"]
    // The frost is one key of the material's, `blur = SIZE:PASSES`; the lab keeps its two halves as
    // numbers, so a preset and A/B carry them like any other.
    const { blurSize, blurPasses, ...material } = state.tuning
    for (const [k, v] of Object.entries(material)) lines.push(`${k} = ${v}`)
    if (blurSize !== undefined || blurPasses !== undefined)
        lines.push(`blur = ${blurSize ?? GLASS_BLUR.regular.size}:${Math.round(blurPasses ?? GLASS_BLUR.regular.passes)}`)
    if (!state.flags.ink) lines.push("ink = off")
    if (!state.flags.scrim) lines.push("scrim = off")
    if (!state.flags.glass) lines.push("glass = off")
    const { blurSize: dSize, blurPasses: dPasses, ...dense } = state.dense
    for (const [k, v] of Object.entries(dense)) lines.push(`dense.${k} = ${v}`)
    if (dSize !== undefined || dPasses !== undefined)
        lines.push(`dense.blur = ${dSize ?? GLASS_BLUR.regular.size}:${Math.round(dPasses ?? GLASS_BLUR.regular.passes)}`)
    writeFile(TUNING, lines.join("\n") + "\n")
    writeFile(`${SHADERS}/lab_params.conf`,
        state.lab.map((v, i) => v !== 0 ? `lab[${i}] = ${v}` : "").filter(Boolean).join("\n") + "\n")
    backdropArea?.queue_draw()
    refreshBench()
}

// ── Backdrops ───────────────────────────────────────────────────────────────
const wallpapers: Record<string, string> = {}
if (WALLPAPERS) {
    const dir = Gio.File.new_for_path(WALLPAPERS)
    try {
        const it = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
        for (let info = it.next_file(null); info; info = it.next_file(null)) {
            const n = info.get_name()
            if (/\.(jpe?g|png)$/i.test(n)) wallpapers[`foto: ${n.replace(/\.[^.]+$/, "")}`] = `${WALLPAPERS}/${n}`
        }
    } catch { /* no wallpapers: the synthetic backdrops still work */ }
}
const BACKDROPS = ["blanco", "negro", "gris", "mitad blanco/negro", "degradado", "rejilla", "página de texto",
    ...Object.keys(wallpapers).sort()]
// A photo is a texture, uploaded once and only moved (scaled on the GPU): drawn through Cairo it
// was converted and rescaled on the CPU every frame — two cores and 6 GB within minutes of
// letting it drift (2026-10-05).
const textures = new Map<string, Gdk.Texture>()
let backdropArea: Gtk.Widget | null = null

// A photo is drawn this much larger than it needs to cover the output, so it always has room
// to move under the glass whatever the window's proportions (cover alone left none: a photo as
// wide as the window cannot pan sideways).
const PHOTO_ZOOM = 1.6
let photoSlack = { x: 1, y: 1 }    // how far, in px, the photo can move: what a drag divides by
function paintBackdrop(cr: any, w: number, h: number) {
    const b = state.backdrop, x0 = state.offset * w, y0 = state.offsetY * h
    const fill = (r: number, g: number, bl: number, x = 0, y = 0, ww = w, hh = h) => {
        cr.setSourceRGB(r, g, bl); cr.rectangle(x, y, ww, hh); cr.fill()
    }
    if (b === "blanco") fill(1, 1, 1)
    else if (b === "negro") fill(0, 0, 0)
    else if (b === "gris") fill(0.5, 0.5, 0.5)
    else if (b === "mitad blanco/negro") { fill(1, 1, 1); fill(0, 0, 0, x0, 0, w - x0, h) }
    else if (b === "degradado") {
        for (let x = 0; x < w; x += 2) { const v = ((x - x0) / w + 1) % 1; fill(v, v, v, x, 0, 2, h) }
    } else if (b === "rejilla") {
        fill(0.92, 0.92, 0.92)
        cr.setSourceRGB(0.1, 0.1, 0.1)
        for (let x = (x0 % 40); x < w; x += 40) { cr.rectangle(x, 0, 2, h) }
        for (let y = (y0 % 40); y < h; y += 40) { cr.rectangle(0, y, w, 2) }
        cr.fill()
    } else if (b === "página de texto") {
        fill(0.97, 0.97, 0.96)
        const layout = PangoCairo.create_layout(cr)
        layout.set_font_description(Pango.FontDescription.from_string("Sans 15"))
        const line = "El material de cristal deja ver lo que hay detrás y aun así se tiene que leer lo que lleva encima. "
        cr.setSourceRGB(0.08, 0.08, 0.1)
        for (let y = 8 + (y0 % 26) - 26, i = Math.floor(-y0 / 26); y < h; y += 26, i++) {
            cr.moveTo(-((x0 + i * 37) % 400), y)
            layout.set_text(line.repeat(4), -1)
            PangoCairo.show_layout(cr, layout)
        }
    }
}
const rect = (x: number, y: number, w: number, h: number) => { const r = new Graphene.Rect(); r.init(x, y, w, h); return r }
const BLACK = new Gdk.RGBA({ red: 0.05, green: 0.05, blue: 0.06, alpha: 1 })
const BackdropView = GObject.registerClass(class BackdropView extends Gtk.Widget {
    vfunc_snapshot(snap: Gtk.Snapshot): void {
        const W = this.get_width(), H = this.get_height()
        if (W <= 0 || H <= 0) return
        // The export's frame is the backdrop's whole world: drawn inside it as the export draws
        // it over its whole output, so what the frame shows is what the file shows.
        let x = 0, y = 0, w = W, h = H
        const r = stageRect()
        if (r.w > 0 && r.h > 0 && (r.w !== W || r.h !== H)) {
            snap.append_color(BLACK, rect(0, 0, W, H))
            x = r.x; y = r.y; w = r.w; h = r.h
        }
        snap.save()
        const at = new Graphene.Point(); at.init(x, y)
        snap.translate(at)
        this.paintIn(snap, w, h)
        snap.restore()
    }
    paintIn(snap: Gtk.Snapshot, w: number, h: number): void {
        const path = wallpapers[state.backdrop]
        if (!path) {
            const cr = snap.append_cairo(rect(0, 0, w, h))
            try { paintBackdrop(cr, w, h) } finally { cr.$dispose() }
            return
        }
        let tex = textures.get(path)
        if (!tex) { tex = Gdk.Texture.new_from_filename(path); textures.set(path, tex) }
        const s = Math.max(w / tex.get_width(), h / tex.get_height()) * PHOTO_ZOOM
        const dw = tex.get_width() * s, dh = tex.get_height() * s
        photoSlack = { x: dw - w, y: dh - h }
        snap.push_clip(rect(0, 0, w, h))
        snap.append_scaled_texture(tex, Gsk.ScalingFilter.LINEAR,
            rect(-photoSlack.x * state.offset, -photoSlack.y * state.offsetY, dw, dh))
        snap.pop()
    }
})

// ── The shadow around a piece, by its type (the lab's, on trial) ───────────
// A layer with no children, behind the piece in the same grid cell (as SquircleContainer lays its
// painter under its child): no container of its own to dispose, so nothing is unparented while
// the JS engine sweeps a scene a rebuild dropped (a container that did closed the lab at random,
// 2026-10-08). Its settings ride on the wrapper (`cfg`).
interface Layer { type: GlassType, radius: number, inset: number }
const ElevationLayer = GObject.registerClass(class ElevationLayer extends Gtk.Widget {
    vfunc_snapshot(snap: Gtk.Snapshot): void {
        const cfg = (this as unknown as { cfg?: Layer }).cfg
        if (!cfg) return
        const e = state.elevation[cfg.type]
        const w = this.get_width(), h = this.get_height()
        const x = cfg.inset, y = cfg.inset, bw = w - 2 * cfg.inset, bh = h - 2 * cfg.inset
        if (e.alpha <= 0 || bw <= 0 || bh <= 0) return
        // GSK's outset shadow is drawn outside the outline only, so it never darkens the glass.
        const outline = new Gsk.RoundedRect()
        outline.init_from_rect(rect(x, y, bw, bh), Math.min(cfg.radius, bw / 2, bh / 2))
        snap.append_outset_shadow(outline, new Gdk.RGBA({ red: 0, green: 0, blue: 0, alpha: e.alpha }),
            0, e.dy, 0, e.blur)
    }
})
const shadowLayers: Gtk.Widget[] = []
/** `pane` (a pane of glass with `radius` and `inset`, as SquircleContainer takes them) over the
 *  shadow of `type`. */
function withShadow(type: GlassType, pane: Gtk.Widget, radius: number, inset: number): Gtk.Widget {
    const layer = new ElevationLayer({ hexpand: true, vexpand: true, can_target: false })
    ;(layer as unknown as { cfg: Layer }).cfg = { type, radius, inset }
    const grid = new Gtk.Grid({ halign: pane.halign, valign: pane.valign })
    grid.attach(layer, 0, 0, 1, 1)
    grid.attach(pane, 0, 0, 1, 1)
    shadowLayers.push(layer)
    return grid
}

// ── The specimens ───────────────────────────────────────────────────────────
// Each records the content it lays over its glass, so a measurement can lift it off and read
// the glass alone under the text.
interface Specimen { name: string, contents: Gtk.Widget[] }
const specimens: Specimen[] = []

const UNIT = 80, GAP = 16          // surfaces/control-center/CCLayoutManager.ts (not imported: it
                                   // pulls the whole widget registry in)
const label = (text: string, classes: string[] = []) =>
    new Gtk.Label({ label: text, halign: Gtk.Align.START, css_classes: classes, ellipsize: Pango.EllipsizeMode.END })
const icon = (name: string, size = 18) => new Gtk.Image({ gicon: uiIcon(name as any), pixel_size: size, css_classes: ["nd-icon"] })
const tag = (text: string) => new Gtk.Label({ label: text, css_classes: ["glass-lab-tag"], halign: Gtk.Align.START })

/** The bar: two groups of the real bar glass (surfaces/bar/capsule.ts) in the bar's own row
 *  (Bar.tsx's `barBox`: its height and its CSS are what make a group 32 tall), no shadow. */
function barRow(): Gtk.Widget {
    const row = new Gtk.CenterBox({ css_classes: ["bar-centerbox"], height_request: BAR_H, valign: Gtk.Align.START,
        hexpand: true, margin_start: BAR_MARGIN, margin_end: BAR_MARGIN })
    const left = barGroup()
    const title = label("Laboratorio", ["bar-widget-label"])
    left.box.append(barItem({ child: title }))
    const right = barGroup()
    const items = ["nd-network-wireless", "nd-audio-volume-high", "nd-battery", "nd-control-center"].map(n => icon(n, 18))
    for (const i of items) right.box.append(barItem({ child: i }))
    const clock = label("12:34", ["bar-widget-label"])
    right.box.append(barItem({ child: clock }))
    row.set_start_widget(left.widget); row.set_end_widget(right.widget)
    trackFluidCrystal(row, "bar")
    trackNoScrim(row)
    specimens.push({ name: "barra", contents: [title, ...items, clock] })
    if (state.ink === "grupo") { trackInkGroup(left.widget); trackInkGroup(right.widget) }
    if (state.ink === "panel") trackInkGroup(row)
    return row
}

/** The bench's type for the Control Center's tiles (null off the bench: no shadow around them). */
let tileType: GlassType | null = null
function tile(size: WidgetSize, w: number, h: number, child: Gtk.Widget, getFill?: () => number) {
    const t = BaseIsland({ name: "glass-lab", child, width: w, height: h, size, getFill })
    trackFluidCrystal(t, "tile")
    // A tile is a circle or a capsule: the shadow's radius is held to half its shorter side.
    return tileType ? withShadow(tileType, t, 999, GLASS_INSET) : t
}
/** The Control Center: BaseIsland tiles on the CC grid, one shadow region for the panel. */
function controlCenter(): Gtk.Widget {
    const grid = new Gtk.Grid({ column_spacing: GAP, row_spacing: GAP })
    // The tiles' content is the widget kit's own (common/widget-kit/tile.ts), as the CC's widgets build it.
    const wide = (ic: string, t: string, s: string) => {
        const inner = makeCapsuleInner(() => uiIcon(ic as any), () => t, () => s)
        specimens.push({ name: `cc ${t}`, contents: [inner.box] })
        return tile(WidgetSize.WIDE, UNIT * 2 + GAP, UNIT, inner.box)
    }
    const single = (ic: string) => {
        const t = makeIconTile(() => uiIcon(ic as any))
        specimens.push({ name: `cc ${ic}`, contents: [t] })
        return tile(WidgetSize.SINGLE, UNIT, UNIT, t)
    }
    const fill = makeCapsuleInner(() => uiIcon("nd-display-brightness"), () => "Brillo", () => "60 %")
    const fillBox = fill.box
    specimens.push({ name: "cc Brillo", contents: [fillBox] })
    const rows = [
        [wide("nd-network-wireless", "Wi-Fi", "Casa"), wide("nd-bluetooth-active", "Bluetooth", "Activado")],
        [single("nd-notifications"), single("nd-night-light"),
            tile(WidgetSize.WIDE, UNIT * 2 + GAP, UNIT, fillBox, () => 0.6)],
    ]
    const rowBoxes: Gtk.Box[] = []
    rows.forEach((r, y) => {
        const rb = new Gtk.Box({ spacing: GAP }); r.forEach(t => rb.append(t)); rowBoxes.push(rb)
        grid.attach(rb, 0, y, 1, 1)
    })
    const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_start: 16, margin_end: 16,
        margin_top: 16, margin_bottom: 16 })
    panel.append(grid)
    trackFluidCrystal(panel, "panel")
    trackScrimRegion(panel)
    // As in the shell (Bar.tsx): the Control Center's text is white always (owner, 2026-10-08).
    trackNoInk(panel)
    return panel
}

/** A notification stack: the card as NotificationCenter builds it, stacked by makeGroupStack. */
function notifications(): Gtk.Widget {
    const card = (app: string, body: string) => {
        const box = new Gtk.Box({ spacing: 12, margin_start: 14, margin_end: 14, margin_top: 12, margin_bottom: 12 })
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true })
        const a = label(app, ["nidara-atomic-label-bold"]), b = label(body, ["nc-notif-body"])
        col.append(a); col.append(b)
        const i = icon("nd-notifications", 24)
        box.append(i); box.append(col)
        const c = SquircleContainer({ child: box, radius: RADIUS.xl, useShellOpacity: true, gloss: true, hexpand: true,
            borderColor: { r: 1, g: 1, b: 1, a: 0.05 }, css_classes: ["nc-capsule-item"], shadow: GLASS_SHADOW })
        c.set_size_request(UNIT * 4 + GAP * 3, -1)
        specimens.push({ name: `aviso ${app}`, contents: [box] })
        return c
    }
    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_start: 16, margin_end: 16,
        margin_top: 16, margin_bottom: 16 })
    const stack = makeGroupStack(card("Mensajes", "¿Has visto el cristal nuevo?"), 3)
    column.append(stack)
    column.append(card("Calendario", "Revisión del material, 17:00"))
    trackFluidCrystal(column, "panel")
    trackScrimRegion(column)
    // As in the shell (Bar.tsx): the notifications' text is white always (owner, 2026-10-08).
    trackNoInk(column)
    return column
}

/** Round buttons and a tooltip — the kit's own. */
function controls(): Gtk.Widget {
    const box = new Gtk.Box({ spacing: 14 })
    const names = ["nd-window-close", "nd-media-playback-start", "nd-preferences-system"]
    const buttons = names.map(n => NidaraCircleButton({ icon: uiIcon(n as any), iconSize: 16, variant: "neutral" }))
    buttons.forEach(b => box.append(b))
    specimens.push({ name: "botones", contents: buttons.map(b => b.get_child()!) })
    // The tooltip opens on its own once the scene is up, and stays.
    const tip = attachTooltip(buttons[1], "Reproducir", { position: Gtk.PositionType.BOTTOM })
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => { tip.popover.popup(); return GLib.SOURCE_REMOVE })
    // The tooltip is a popover — a surface of its own — and is not measured.
    trackScrimRegion(box)
    return box
}

/** A menu as the shell builds its flat menus (the system menu, the Control Center's context
 *  menu): `menuRow` rows in a pane of glass of radius lg, inset as the system menu insets them. */
function menuPiece(type: GlassType): Gtk.Widget {
    const inset = rowInsetFor(RADIUS.lg) + GLASS_INSET
    const rows = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2,
        margin_top: inset, margin_bottom: inset, margin_start: inset, margin_end: inset })
    const items = [
        menuRow({ label: "Nueva ventana", icon: uiIcon("nd-window-new" as any), onClick: () => {} }),
        menuRow({ label: "Abrir…", icon: uiIcon("nd-document-open" as any), onClick: () => {} }),
        menuRow({ label: "Ajustes del cristal", icon: uiIcon("nd-preferences-system" as any), onClick: () => {} }),
    ]
    items.forEach(i => rows.append(i))
    rows.append(menuSeparator())
    const quit = menuRow({ label: "Cerrar", onClick: () => {} })
    rows.append(quit)
    const card = SquircleContainer({ child: rows, radius: RADIUS.lg, useShellOpacity: true, gloss: true, chrome: true,
        shadow: GLASS_SHADOW })
    card.set_size_request(240, -1)
    trackFluidCrystal(card, "popover")
    specimens.push({ name: "menú", contents: [...items, quit] })
    return withShadow(type, card, RADIUS.lg, GLASS_INSET)
}

/** Stand-ins, marked: the island's capsule and the dock's pill, by shape only. */
function islandPiece(): Gtk.Widget {
    const islandRow = new Gtk.Box({ spacing: 8 })
    const islandText = new Gtk.Box({ spacing: 8, margin_start: 14, margin_end: 14 })
    const t = label("Grabando 00:42", ["bar-widget-label"]); islandText.append(icon("nd-media-record", 16)); islandText.append(t)
    const island = SquircleContainer({ child: islandText, shape: Shape.CAPSULE, useShellOpacity: true, gloss: true,
        chrome: true, shadow: GLASS_SHADOW })
    island.set_size_request(-1, 32)
    const stop = NidaraCircleButton({ icon: uiIcon("nd-media-playback-stop"), iconSize: 14, variant: "neutral" })
    islandRow.append(island); islandRow.append(stop)
    trackFluidCrystal(islandRow, "bar")
    trackNoScrim(islandRow)
    specimens.push({ name: "isla (sustituto)", contents: [islandText] })
    if (state.ink === "panel") trackInkGroup(islandRow)
    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    col.append(islandRow); col.append(tag("isla: sustituto, solo la forma"))
    return col
}
function dockPiece(): Gtk.Widget {
    const dockIcons = new Gtk.Box({ spacing: 14, margin_start: 16, margin_end: 16, margin_top: 10, margin_bottom: 10 })
    for (const n of ["nd-utilities-terminal", "nd-globe", "nd-preferences-system", "nd-view-grid", "nd-user-trash"])
        dockIcons.append(icon(n, 40))
    const dock = SquircleContainer({ child: dockIcons, shape: Shape.DOCK_PILL, useShellOpacity: true, gloss: true,
        chrome: true, shadow: GLASS_SHADOW })
    const dockWrap = new Gtk.Box(); dockWrap.append(dock)
    trackFluidCrystal(dockWrap, "bar")
    trackNoScrim(dockWrap)
    specimens.push({ name: "dock (sustituto)", contents: [dockIcons] })
    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    col.append(tag("dock: sustituto, solo la forma")); col.append(dockWrap)
    return col
}
/** The app grid's panel: its glass as AppGrid.tsx builds it (radius xl, inset 2, the loose
 *  shadow — the grid declares no region) at its size (6 × 3 tiles of 163 px, 920 wide). The panel
 *  is what is on the bench — its lensing, its rim, its shadow at full size; the apps are a sample
 *  from the icon theme, and the search field and workspace strip are left out. */
function bigPanel(): Gtk.Widget {
    const COLS = 6, ROWS = 3, ROW_H = 163
    const apps: [string, string][] = [["utilities-terminal", "Terminal"], ["system-file-manager", "Archivos"],
        ["web-browser", "Navegador"], ["accessories-text-editor", "Editor de texto"], ["preferences-system", "Ajustes"],
        ["applications-graphics", "Gráficos"], ["accessories-calculator", "Calculadora"], ["x-office-calendar", "Calendario"],
        ["multimedia-video-player", "Vídeos"], ["audio-x-generic", "Música"], ["image-x-generic", "Fotos"],
        ["system-software-install", "Software"], ["help-browser", "Ayuda"], ["mail-unread", "Correo"],
        ["accessories-screenshot", "Captura de pantalla"], ["system-monitor", "Monitor del sistema"],
        ["applications-games", "Juegos"], ["user-trash", "Papelera"]]
    const grid = new Gtk.Grid({ column_spacing: 8, row_spacing: 8, halign: Gtk.Align.CENTER, margin_top: 8,
        margin_bottom: 8, column_homogeneous: true })
    const labels: Gtk.Widget[] = []
    apps.slice(0, COLS * ROWS).forEach(([ic, name], i) => {
        const img = new Gtk.Image({ icon_name: ic, pixel_size: 72, hexpand: true, vexpand: true })
        const plate = new Gtk.Box({ css_classes: ["app-grid-plate"], width_request: 96, height_request: 96,
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER })
        plate.append(img)
        const l = new Gtk.Label({ label: name, css_classes: ["app-grid-label"], justify: Gtk.Justification.CENTER,
            max_width_chars: 13, wrap: true, wrap_mode: Pango.WrapMode.WORD, lines: 2, ellipsize: Pango.EllipsizeMode.END })
        labels.push(l)
        const item = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ["app-grid-item"],
            halign: Gtk.Align.CENTER, valign: Gtk.Align.START })
        item.append(plate); item.append(l)
        const button = new Gtk.Box({ css_classes: ["app-grid-button"] }); button.append(item)
        grid.attach(button, i % COLS, Math.floor(i / COLS), 1, 1)
    })
    const area = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: 920,
        height_request: ROWS * ROW_H + (ROWS - 1) * 8 + 16, margin_top: 28, margin_start: 32, margin_end: 32, margin_bottom: 4 })
    area.append(grid)
    const panel = SquircleContainer({ child: area, radius: RADIUS.xl, gloss: true, useShellOpacity: true, inset: 2.0,
        hexpand: false, vexpand: false, shadow: GLASS_SHADOW })
    trackFluidCrystal(panel, "launcher")
    specimens.push({ name: "panel grande", contents: labels })
    if (state.ink === "panel" || state.ink === "grupo") trackInkGroup(panel)
    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    col.append(panel); col.append(tag("panel grande: el cristal y el tamaño de la cuadrícula de apps; apps de muestra"))
    return col
}

/** For promotional images and videos: one round pane of glass with the Nidara mark, alone and
 *  centred — the material and nothing else. The mark is the bar's (symbolic, so it takes the
 *  pane's ink: white, dark where the backdrop under it turns bright). Default: the app grid's
 *  icon size. */
let promoDisc: { disc: Gtk.Widget, mark: Gtk.Image } | null = null
/** The disc's size on screen: `promoSize` is px of the EXPORTED file, and the frame on screen is
 *  that file at a scale (the format's height over the frame's). */
function promoScreenSize(): number {
    const r = stageRect()
    const k = r.h > 0 ? r.h / FORMATS[state.promoFormat][1] : 1
    return Math.max(8, Math.round(state.promoSize * k))
}
function sizePromo() {
    if (!promoDisc) return
    const size = promoScreenSize()
    promoDisc.disc.set_size_request(size, size)
    promoDisc.mark.pixel_size = Math.round(size * 0.5)
}
function promoPiece(): Gtk.Widget {
    const mark = new Gtk.Image({ css_classes: ["glass-lab-mark"],
        gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${REPO}/ui/shell/assets/nidara/assets/nidara-symbolic.svg`)) })
    const disc = SquircleContainer({ child: mark, shape: Shape.CIRCLE, useShellOpacity: true, gloss: true,
        chrome: true, shadow: GLASS_SHADOW })
    trackFluidCrystal(disc, "media")
    promoDisc = { disc, mark }
    sizePromo()
    specimens.push({ name: "logo", contents: [mark] })
    return disc
}

function standIns(): Gtk.Widget {
    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 40 })
    col.append(islandPiece()); col.append(dockPiece())
    return col
}

// ── Windows ─────────────────────────────────────────────────────────────────
function layerWindow(layer: Gtk4LayerShell.Layer, ns: string, classes: string[], exclusive = -1): Gtk.Window {
    const win = new Gtk.Window({ css_classes: classes })
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, ns)
    Gtk4LayerShell.set_layer(win, layer)
    for (const e of [Gtk4LayerShell.Edge.TOP, Gtk4LayerShell.Edge.BOTTOM, Gtk4LayerShell.Edge.LEFT, Gtk4LayerShell.Edge.RIGHT])
        Gtk4LayerShell.set_anchor(win, e, true)
    Gtk4LayerShell.set_exclusive_zone(win, exclusive)
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    return win
}

const bgWin = layerWindow(Gtk4LayerShell.Layer.BACKGROUND, "glass-lab-backdrop", [])
backdropArea = new BackdropView({ hexpand: true, vexpand: true })
bgWin.set_child(backdropArea)

// Moving the backdrop under the glass: drag it, or let it drift. The drag is on the scene (the
// layer above, where the pointer is); the backdrop follows the pointer, a photo 1:1.
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
function panBy(dx: number, dy: number, from: { x: number, y: number }) {
    const w = backdropArea!.get_width() || 1, h = backdropArea!.get_height() || 1
    if (wallpapers[state.backdrop]) {
        state.offset = clamp01(from.x - dx / Math.max(photoSlack.x, 1))
        state.offsetY = clamp01(from.y - dy / Math.max(photoSlack.y, 1))
    } else {
        state.offset = clamp01(from.x + dx / w)
        state.offsetY = clamp01(from.y + dy / h)
    }
    backdropArea!.queue_draw()
}
/** Where the drift has the backdrop `k` seconds in: a slow loop (≈ 24 s across, 17 s down at
 *  ×1) — content passing under the glass, not a shake. A function of time alone, so an exported
 *  video steps it frame by frame and comes out smooth however slowly the frames are captured. */
function driftTo(k: number) {
    const t = k * state.driftSpeed
    state.offset = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI / 24)
    state.offsetY = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI / 17)
    backdropArea!.queue_draw()
}
let driftStart = 0
let recording = false
backdropArea.add_tick_callback((_w, clock) => {
    if (!state.drift || recording) { driftStart = 0; return GLib.SOURCE_CONTINUE }
    const t = clock.get_frame_time() / 1e6
    if (!driftStart) driftStart = t
    driftTo(t - driftStart)
    return GLib.SOURCE_CONTINUE
})

// The scene wears the bar window's name: the shell's CSS for these pieces is scoped to it.
const scene = layerWindow(Gtk4LayerShell.Layer.TOP, "glass-lab-scene", ["glass-lab-scene", "nidara-bar-window"])
scene.set_name("nidara-bar")
// The scene spans the whole output and keeps its pieces out of the controls' column with a
// margin (set at start, window mode only): anchored to both sides, it follows the lab window as
// it is resized — a size given once went stale the moment the window was maximised.
const stageHolder = new Gtk.Overlay({ hexpand: true, vexpand: true })
scene.set_child(stageHolder)
// The pieces sit in a box the frame's size (fitToFrame): their own margins stay theirs. An
// OVERLAY, which the holder does not measure, and clipped: pieces wider than a narrow frame
// (the whole scene in a 9:16 one) widened the holder, so the frame, so the margins — a loop
// that grew until GSK could not allocate the drawing.
const frameBox = new Gtk.Box({ hexpand: true, vexpand: true, overflow: Gtk.Overflow.HIDDEN })
stageHolder.set_child(new Gtk.Box({ hexpand: true, vexpand: true }))
stageHolder.add_overlay(frameBox)
const setSceneContent = (w: Gtk.Widget) => {
    const old = frameBox.get_first_child()
    if (old) frameBox.remove(old)
    w.hexpand = true; w.vexpand = true
    frameBox.append(w)
}

/** What an export takes, in the scene's px: the chosen format, fitted and centred in the area
 *  beside the controls — whatever is on the bench. */
function stageRect(): Box4 {
    const w = stageHolder.get_width(), h = stageHolder.get_height()
    // Headless, the output IS the format (glass-lab.sh --size): the frame is all of it.
    if (SHOT) return { x: 0, y: 0, w, h }
    const [fw, fh] = FORMATS[state.promoFormat], m = 24
    const k = Math.min(Math.max(1, w - 2 * m) / fw, Math.max(1, h - 2 * m) / fh)
    const sw = Math.floor(fw * k), sh = Math.floor(fh * k)
    return { x: Math.round((w - sw) / 2), y: Math.round((h - sh) / 2), w: sw, h: sh }
}
/** The pieces laid out inside the frame, as the export lays them out over its whole output (at
 *  the scale that makes that output, in logical px, this frame: exportNative). */
function fitToFrame() {
    const r = stageRect(), w = stageHolder.get_width(), h = stageHolder.get_height()
    if (r.w <= 0 || r.h <= 0) return
    frameBox.margin_start = r.x; frameBox.margin_top = r.y
    frameBox.margin_end = Math.max(0, w - r.x - r.w); frameBox.margin_bottom = Math.max(0, h - r.y - r.h)
}
// The frame on screen: everything outside it dimmed, a hairline just outside its edge — both
// outside what an export takes.
const frameGuide = new Gtk.DrawingArea({ can_target: false, hexpand: true, vexpand: true })
let lastFrame = ""
frameGuide.set_draw_func((_a, cr, w, h) => {
    // The window was resized or the format changed: the pieces and the backdrop follow the frame.
    const key = JSON.stringify(stageRect())
    if (key !== lastFrame) {
        lastFrame = key
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { fitToFrame(); sizePromo(); backdropArea?.queue_draw(); return GLib.SOURCE_REMOVE })
    }
    const r = stageRect()
    cr.setFillRule(1 /* EVEN_ODD */)
    cr.rectangle(0, 0, w, h); cr.rectangle(r.x, r.y, r.w, r.h)
    cr.setSourceRGBA(0, 0, 0, 0.6); cr.fill()
    cr.rectangle(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3)
    cr.setLineWidth(1); cr.setSourceRGBA(1, 1, 1, 0.5); cr.stroke()
})
stageHolder.add_overlay(frameGuide)
{
    const drag = new Gtk.GestureDrag()
    let from = { x: 0.5, y: 0.5 }
    // While it drifts the drift has the backdrop: switch it off to drag.
    drag.connect("drag-begin", () => { from = { x: state.offset, y: state.offsetY } })
    drag.connect("drag-update", (_g, dx: number, dy: number) => { if (!state.drift) panBy(dx, dy, from) })
    scene.add_controller(drag)
}
// ── The bench of types: each piece a window of its own, wearing its type ─────
const benchWindows: { win: Gtk.Window, root: Gtk.Widget, piece: BenchPiece }[] = []
function clearBench() {
    for (const b of benchWindows.splice(0)) b.win.destroy()
}
/** One piece on a surface of its own, at (x, y) of the output; `room` around it for its shadow. */
function benchWindow(piece: BenchPiece, x: number, y: number) {
    const type = state.types[piece]
    const win = new Gtk.Window({ css_classes: ["glass-lab-scene", "nidara-bar-window"] })
    win.set_name("nidara-bar")   // the shell's CSS for these pieces is scoped to the bar's window
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, "glass-lab-bench")
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.TOP)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.TOP, y)
    Gtk4LayerShell.set_margin(win, Gtk4LayerShell.Edge.LEFT, x)
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    const room = 60
    const holder = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: room, margin_bottom: room,
        margin_start: room, margin_end: room })
    tileType = type
    const content = piece === "menú" ? menuPiece(type) : controlCenter()
    tileType = null
    holder.append(content)
    holder.append(tag(`${piece}: ${type}`))
    // The dense type: the material's dense glass, and content that follows the mode (no ink).
    if (type === "denso") { trackDenseGlass(content); trackNoInk(content) }
    win.set_child(holder)
    win.present()
    benchWindows.push({ win, root: content, piece })
    refreshBench()
}
function buildBench() {
    clearBench()
    const r = stageRect()
    benchWindow("menú", r.x + 40, r.y + 80)
    benchWindow("centro de control", r.x + 420, r.y + 80)
}
/** A dense piece in light mode wears the light skin (dark text); every shadow is redrawn. */
function refreshBench() {
    for (const b of benchWindows) {
        if (state.types[b.piece] === "denso" && state.flags.dark === false) b.root.add_css_class("nidara-skin-light")
        else b.root.remove_css_class("nidara-skin-light")
    }
    for (const l of shadowLayers) l.queue_draw()
}

function buildScene() {
    specimens.length = 0
    shadowLayers.length = 0
    clearBench()
    promoDisc = null
    const show = state.show
    if (show === "tipos de cristal") {
        setSceneContent(new Gtk.Box())
        // After the scene's layout: the bench sits inside the export's frame.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { if (state.show === "tipos de cristal") buildBench(); return GLib.SOURCE_REMOVE })
        frameGuide.queue_draw()
        return
    }
    if (show === "barra") {
        const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
        root.append(barRow())
        setSceneContent(root)
        return
    }
    if (show !== "todas") {
        const one = show === "centro de control" ? controlCenter() : show === "avisos" ? notifications()
            : show === "botones y tooltip" ? controls() : show === "panel grande" ? bigPanel()
            : show === "promo: logo" ? promoPiece() : standIns()
        one.halign = Gtk.Align.CENTER; one.valign = Gtk.Align.CENTER
        setSceneContent(one)
        frameGuide.queue_draw()
        return
    }
    // Where the desktop has them: the island in the bar's row, the dock at the bottom.
    const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_bottom: 8 })
    const top = new Gtk.Overlay()
    top.set_child(barRow())
    const island = islandPiece(); island.halign = Gtk.Align.CENTER; island.valign = Gtk.Align.START
    island.margin_top = (BAR_H - 32) / 2
    top.add_overlay(island)
    root.append(top)
    // A flow, so a narrow output wraps the panels instead of pushing the scene off its edge.
    const cols = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous: false, column_spacing: 24,
        row_spacing: 8, min_children_per_line: 1, max_children_per_line: 3, vexpand: true, valign: Gtk.Align.START,
        halign: Gtk.Align.CENTER })
    for (const w of [controlCenter(), controls(), notifications()]) { w.valign = Gtk.Align.START; cols.append(w) }
    root.append(cols)
    const dock = dockPiece(); dock.halign = Gtk.Align.CENTER
    root.append(dock)
    setSceneContent(root)
    frameGuide.queue_draw()
}

// ── Measuring: the text against the glass under it ──────────────────────────
const debugLines: string[] = []
interface Reading { name: string, text: number, glass: number, ratio: number, dark: boolean }
const lum8 = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
function screenshot(path: string, done: (ok: boolean) => void) {
    try {
        const p = Gio.Subprocess.new([HYALO, "msg", "screenshot", path], Gio.SubprocessFlags.STDOUT_SILENCE)
        p.wait_check_async(null, (_p, res) => { try { done(p.wait_check_finish(res)) } catch { done(false) } })
    } catch { done(false) }
}
function leaves(w: Gtk.Widget, out: Gtk.Widget[] = []): Gtk.Widget[] {
    if (w instanceof Gtk.Label || w instanceof Gtk.Image) { if (w.get_mapped()) out.push(w); return out }
    for (let c = w.get_first_child(); c; c = c.get_next_sibling()) leaves(c, out)
    return out
}
type Box4 = { x: number, y: number, w: number, h: number }
function boundsIn(w: Gtk.Widget, root: Gtk.Widget): Box4 | null {
    const [ok, r] = w.compute_bounds(root)
    if (!ok) return null
    return { x: Math.round(r.get_x()), y: Math.round(r.get_y()), w: Math.round(r.get_width()), h: Math.round(r.get_height()) }
}
/** Where the ink actually is: an image's glyph (pixel_size, centred), a label's text (its natural
 *  size at its xalign) — not the allocation, which can reach the glass's bright rim. */
function inkBox(w: Gtk.Widget): Box4 | null {
    const r = boundsIn(w, scene)
    if (!r) return null
    let nw = r.w, nh = r.h, xf = 0.5
    if (w instanceof Gtk.Image) { nw = nh = Math.min(w.pixel_size > 0 ? w.pixel_size : 16, r.w, r.h) }
    else if (w instanceof Gtk.Label) {
        nw = Math.min(r.w, w.measure(Gtk.Orientation.HORIZONTAL, -1)[1])
        nh = Math.min(r.h, w.measure(Gtk.Orientation.VERTICAL, nw)[1])
        xf = w.xalign
    }
    return { x: Math.round(r.x + (r.w - nw) * xf), y: Math.round(r.y + (r.h - nh) / 2), w: nw, h: nh }
}
/** The p-th percentile (0..1) — the worst glass pixel without one antialiased edge pixel deciding. */
function pct(v: number[], p: number): number {
    const s = [...v].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]
}
/** Luminances inside a box of a screenshot. */
function sample(pb: GdkPixbuf.Pixbuf, b: Box4): number[] {
    const px = pb.get_pixels(), rs = pb.get_rowstride(), n = pb.get_n_channels(), out: number[] = []
    for (let y = Math.max(0, b.y); y < Math.min(pb.get_height(), b.y + b.h); y++)
        for (let x = Math.max(0, b.x); x < Math.min(pb.get_width(), b.x + b.w); x++) {
            const i = y * rs + x * n
            out.push(0.2126 * lum8(px[i]) + 0.7152 * lum8(px[i + 1]) + 0.0722 * lum8(px[i + 2]))
        }
    return out
}
/**
 * Two captures: as it is, and with the content lifted off (opacity 0 — the glass stays). Under
 * each text the glass's WORST pixel (the one closest to the ink) against the ink (the
 * text's own extreme pixel in the first capture): the contrast the reader actually gets there.
 */
function measure(tmp: string, done: (r: Reading[]) => void) {
    const a = `${tmp}-a.png`, b = `${tmp}-b.png`
    screenshot(a, ok => {
        if (!ok) { done([]); return }
        specimens.forEach(s => s.contents.forEach(c => c.set_opacity(0)))
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            screenshot(b, ok2 => {
                specimens.forEach(s => s.contents.forEach(c => c.set_opacity(1)))
                if (!ok2) { done([]); return }
                const pa = GdkPixbuf.Pixbuf.new_from_file(a), pbb = GdkPixbuf.Pixbuf.new_from_file(b)
                const sx = pa.get_width() / scene.get_width()
                const out: Reading[] = []
                for (const s of specimens) {
                    let worst: Reading | null = null
                    for (const c of s.contents) for (const leaf of leaves(c)) {
                        const r = inkBox(leaf)
                        if (!r || r.w < 2 || r.h < 2) continue
                        const box = { x: Math.round(r.x * sx), y: Math.round(r.y * sx), w: Math.round(r.w * sx), h: Math.round(r.h * sx) }
                        const glass = sample(pbb, box), withText = sample(pa, box)
                        if (env("GLASS_LAB_DEBUG")) debugLines.push(`${s.name} ${leaf.constructor.name} ${JSON.stringify(box)} glass max ${Math.max(...glass).toFixed(3)}`)
                        if (!glass.length) continue
                        let pane: Gtk.Widget | null = leaf
                        let dark = false
                        for (; pane; pane = pane.get_parent()) if (pane.has_css_class(INK_DARK_CLASS)) { dark = true; break }
                        const ink = dark ? Math.min(...withText) : Math.max(...withText)
                        const g = dark ? pct(glass, 0.02) : pct(glass, 0.98)
                        const ratio = (Math.max(ink, g) + 0.05) / (Math.min(ink, g) + 0.05)
                        if (!worst || ratio < worst.ratio) worst = { name: s.name, text: ink, glass: g, ratio, dark }
                    }
                    if (worst) out.push(worst)
                }
                done(out)
            })
            return GLib.SOURCE_REMOVE
        })
    })
}
const fmt = (r: Reading) =>
    `${r.ratio.toFixed(2).padStart(6)}:1  ${r.ratio >= 4.5 ? "AA " : r.ratio >= 3 ? "3:1" : "✗  "}  ${r.dark ? "oscuro" : "blanco"}  vidrio L=${r.glass.toFixed(3)}  ${r.name}`

// ── Exports: images and videos of what is inside the frame ──────────────────
const stamp = () => GLib.DateTime.new_now_local().format("%Y%m%d-%H%M%S")
const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2)

/** What a capture is written as: all of it, never scaled — exports run headless on an output
 *  that IS the format (exportNative), so the frame is the whole capture. Even sides, for H.264.
 *  (In capture px, which at the export's scale are not the scene's px.) */
function cut(captureWidth: number, captureHeight: number): { x: number, y: number, w: number, h: number, outW: number, outH: number } {
    // At a fractional scale the output's logical size rounds up, and a capture of it comes out a
    // few px larger than the output itself (1083×1923 for 1080×1920 at ×2.85): the format's size,
    // from the top-left, is what the output shows.
    const [sw, sh] = (env("GLASS_LAB_SIZE") || "").split("x").map(Number)
    const w = even(Math.min(captureWidth, sw || captureWidth)), h = even(Math.min(captureHeight, sh || captureHeight))
    return { x: 0, y: 0, w, h, outW: w, outH: h }
}

/** `cb` once the backdrop's next frame is painted (its frame clock's after-paint), or after 50 ms
 *  if it has no clock — never stalled by a frame that does not come. */
function afterPaint(cb: () => void) {
    let fired = false
    const go = () => { if (fired) return; fired = true; GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { cb(); return GLib.SOURCE_REMOVE }) }
    const clock = backdropArea?.get_frame_clock()
    if (clock) {
        const id = clock.connect("after-paint", () => { clock.disconnect(id); go() })
        backdropArea!.queue_draw()
    }
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { go(); return GLib.SOURCE_REMOVE })
}

/**
 * Every export at the format's own size, whatever is on the bench: the window's frame is a preview, at whatever
 * scale the screen allows (a 9:16 frame is 1390 px tall on a 1440 px screen), so the file is made
 * by a second lab, headless, whose output IS the format (glass-lab.sh --size 1080x1920) — drawn
 * natively, never enlarged. The window goes on working meanwhile; this reports its progress.
 */
let exporting: Gio.Subprocess | null = null
function exportNative(kind: "image" | "video", report: (s: string) => void) {
    if (exporting) { report("ya hay una exportación en marcha"); return }
    const [fw, fh] = FORMATS[state.promoFormat]
    const base = `${GLib.get_tmp_dir()}/glass-lab-export-${GLib.get_monotonic_time()}`
    writeFile(`${base}.json`, JSON.stringify({ ...state, drift: false }))
    // The export's Hyalo at the scale that makes its output, in logical px, the frame on screen:
    // the same scene as the preview — the same layout, the glass's widths and the backdrop's
    // framing in the same proportion — drawn at the format's px. At scale 1 the file showed the
    // pieces and the glass's px-sized effects (bevel, rim, refraction) smaller than the preview.
    // In 120ths: what fractional-scale-v1 carries, so GTK draws at exactly the output's scale.
    const scale = Math.round(Math.min(4, Math.max(0.25, fw / Math.max(1, stageRect().w))) * 120) / 120
    const argv = [`${REPO}/scripts/dev/glass-lab/glass-lab.sh`, "--headless", `${base}.png`, "--export", kind,
        "--preset", `${base}.json`, "--size", `${fw}x${fh}`, "--scale", scale.toFixed(4), "--bin", HYALO]
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE })
    // The lab runs in a sandbox HOME: the presets dir is said outright, not re-derived from it.
    launcher.setenv("GLASS_LAB_PRESETS", PRESETS, true)
    try { exporting = launcher.spawnv(argv) } catch (e) { report(`no se pudo lanzar la exportación: ${e}`); return }
    report(`exportando a ${fw}×${fh}…`)
    const poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        try {
            const [ok, bytes] = GLib.file_get_contents(`${base}.progress`)
            if (ok) report(new TextDecoder().decode(bytes))
        } catch { /* not yet */ }
        return GLib.SOURCE_CONTINUE
    })
    exporting.wait_async(null, (p, res) => {
        GLib.source_remove(poll)
        exporting = null
        let text = ""
        try { text = new TextDecoder().decode(GLib.file_get_contents(`${base}.txt`)[1]).split("\n").slice(1).join("\n").trim() }
        catch { /* no result */ }
        report(text || `la exportación falló (registro: ${GLib.get_tmp_dir()}/glass-lab.*/hyalo.log)`)
        for (const ext of ["json", "txt", "progress"]) try { Gio.File.new_for_path(`${base}.${ext}`).delete(null) } catch { /* gone */ }
    })
}

/** One image of what is inside the frame, and the values beside it (.json). */
function exportImage(report: (s: string) => void) {
    const path = `${PRESETS}/captura-${stamp()}.png`
    const raw = `${GLib.get_tmp_dir()}/glass-lab-raw-${GLib.get_monotonic_time()}.png`
    screenshot(raw, ok => {
        if (!ok) { report("no se pudo capturar"); return }
        try {
            const pb = GdkPixbuf.Pixbuf.new_from_file(raw)
            const c = cut(pb.get_width(), pb.get_height())
            const sub = pb.new_subpixbuf(c.x, c.y, Math.min(c.w, pb.get_width() - c.x), Math.min(c.h, pb.get_height() - c.y))
            const img = c.outW === sub.get_width() ? sub : sub.scale_simple(c.outW, c.outH, GdkPixbuf.InterpType.HYPER)!
            img.savev(path, "png", [], [])
            Gio.File.new_for_path(raw).delete(null)
            writeFile(path.replace(/\.png$/, ".json"), JSON.stringify(state, null, 2))
            report(`guardada (${img.get_width()}×${img.get_height()}): ${path}\n(los valores, al lado en .json)`)
        } catch (e) { report(`no se pudo recortar: ${e}`) }
    })
}

/**
 * A video of what is inside the frame, the backdrop drifting under the glass: frame by frame —
 * the drift set to each frame's time, the compositor's capture, piped to ffmpeg, which cuts the
 * frame out and scales it to the format — so it is smooth at 60 fps however long each capture
 * takes.
 */
function exportVideo(report: (s: string) => void) {
    if (recording) return
    const FPS = 60, frames = Math.max(1, Math.round(state.videoSeconds * FPS))
    const out = `${PRESETS}/video-${stamp()}.mp4`
    // Raw (Hyalo writes a binary PPM for a .ppm path): a PNG cost 541 ms a frame to compress at
    // 1080×1920 and ffmpeg more to undo it. An older Hyalo writes a PNG under that name, which
    // ffmpeg and GdkPixbuf still read by its content — slower, not wrong.
    const frame = `${GLib.get_tmp_dir()}/glass-lab-frame-${GLib.get_monotonic_time()}.ppm`
    let ff: Gio.Subprocess | null = null
    let pipe: Gio.OutputStream | null = null
    let size = ""
    recording = true
    const done = (msg: string) => {
        recording = false
        if (!ff) { report(msg); return }
        try { pipe?.close(null) } catch { /* already closed */ }
        const p = ff
        p.wait_check_async(null, (_p, res) => {
            let ok = false
            try { ok = p.wait_check_finish(res) } catch { /* reported below */ }
            if (ok) writeFile(out.replace(/\.mp4$/, ".json"), JSON.stringify(state, null, 2))
            report(ok ? `${msg} (${size})\n${out}\n(los valores, al lado en .json)` : `ffmpeg falló (${msg})`)
        })
    }
    // ffmpeg starts with the first capture: the cut is in its pixels.
    const start = (captureWidth: number, captureHeight: number): boolean => {
        const c = cut(captureWidth, captureHeight)
        size = `${c.outW}×${c.outH}`
        try {
            ff = Gio.Subprocess.new(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", `${FPS}`,
                "-i", "-", "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${c.outW}:${c.outH}:flags=lanczos`,
                "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
                Gio.SubprocessFlags.STDIN_PIPE)
            pipe = ff.get_stdin_pipe()
            return true
        } catch (e) { done(`no se pudo arrancar ffmpeg: ${e}`); return false }
    }
    const step = (i: number) => {
        if (i >= frames) { done(`vídeo: ${frames} fotogramas, ${state.videoSeconds} s`); return }
        driftTo(i / FPS)
        // Once GTK has painted (and committed) the backdrop at this time: the capture draws the
        // scene again from the surfaces as they are, glass included. Not a fixed wait.
        afterPaint(() => {
            screenshot(frame, ok => {
                if (!ok) { done(`captura fallida en el fotograma ${i}`); return }
                try {
                    if (!ff) {
                        const [, cw, ch] = GdkPixbuf.Pixbuf.get_file_info(frame)
                        if (!start(cw, ch)) return
                    }
                    const [, bytes] = GLib.file_get_contents(frame)
                    pipe!.write_all(bytes, null)
                    Gio.File.new_for_path(frame).delete(null)
                } catch (e) { done(`ffmpeg dejó de leer en el fotograma ${i}: ${e}`); return }
                if (i % 30 === 0) report(`grabando… ${i}/${frames} (${size})`)
                step(i + 1)
            })
        })
    }
    step(0)
}

// ── Presets ─────────────────────────────────────────────────────────────────
GLib.mkdir_with_parents(PRESETS, 0o755)
function savePreset(name: string): string {
    const path = `${PRESETS}/${name}.json`
    writeFile(path, JSON.stringify(state, null, 2))
    return path
}
function loadPreset(path: string): boolean {
    try {
        const [, bytes] = GLib.file_get_contents(path)
        const loaded = JSON.parse(new TextDecoder().decode(bytes))
        const f = factory()
        state = { ...f, ...loaded, flags: { ...f.flags, ...loaded.flags }, dense: { ...loaded.dense },
            elevation: { cristal: { ...f.elevation.cristal, ...loaded.elevation?.cristal },
                denso: { ...f.elevation.denso, ...loaded.elevation?.denso } },
            types: { ...f.types, ...loaded.types } }
        if (!SHOWS.includes(state.show)) state.show = f.show
        return true
    } catch (e) { printerr(`glass-lab: preset ${path}: ${e}`); return false }
}
function presetNames(): string[] {
    const out: string[] = []
    try {
        const it = Gio.File.new_for_path(PRESETS).enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
        for (let i = it.next_file(null); i; i = it.next_file(null)) if (i.get_name().endsWith(".json")) out.push(i.get_name().slice(0, -5))
    } catch { /* none yet */ }
    return out.sort()
}

// ── The controls window ─────────────────────────────────────────────────────
const D = GLASS_MATERIAL_DEFAULTS as Record<string, number>
const DD = GLASS_DENSE_DEFAULTS as Record<string, number>
// A column on the right of the nested desktop, reserving its width so the scene never sits under it.
const CONTROLS_W = 440
const controlsWin = new Gtk.Window({ title: "Laboratorio de cristal", css_classes: ["glass-lab-controls"] })
controlsWinRef = controlsWin
Gtk4LayerShell.init_for_window(controlsWin)
Gtk4LayerShell.set_namespace(controlsWin, "glass-lab-controls")
Gtk4LayerShell.set_layer(controlsWin, Gtk4LayerShell.Layer.TOP)
for (const e of [Gtk4LayerShell.Edge.TOP, Gtk4LayerShell.Edge.BOTTOM, Gtk4LayerShell.Edge.RIGHT])
    Gtk4LayerShell.set_anchor(controlsWin, e, true)
Gtk4LayerShell.set_exclusive_zone(controlsWin, CONTROLS_W)
Gtk4LayerShell.set_keyboard_mode(controlsWin, Gtk4LayerShell.KeyboardMode.ON_DEMAND)
controlsWin.set_size_request(CONTROLS_W, -1)
// A scrollbar that is always there (overlay scrollbars hid it until the pointer found the edge).
const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER,
    vscrollbar_policy: Gtk.PolicyType.ALWAYS, overlay_scrolling: false })
controlsWin.set_child(scroller)

// ── The controls' own rows ──────────────────────────────────────────────────
// Plain rows for a dense instrument column (owner, 2026-10-09: every text cut off, no
// scrollbar, an endless list, and a wheel that changed the slider under the pointer). The
// title and its note WRAP — the kit's rows hold them to one line, and in this column nearly every
// one was cut — the value is shown, and a slider ignores the wheel: the wheel scrolls the column.
const textCol = (title: string, sub: string) => {
    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 1, hexpand: true })
    col.append(new Gtk.Label({ label: title, xalign: 0, wrap: true, css_classes: ["glass-lab-row-title"] }))
    if (sub) col.append(new Gtk.Label({ label: sub, xalign: 0, wrap: true, css_classes: ["glass-lab-row-sub"] }))
    return col
}
function SliderRow(title: string, sub: string, init: number, min: number, max: number, cb: (v: number) => void,
    opts: { decimals?: number, debounce?: number } = {}): Gtk.Widget {
    const decimals = opts.decimals ?? 0
    const fmt = (v: number) => v.toFixed(decimals).replace(".", ",")
    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    const head = new Gtk.Box({ spacing: 8 })
    const value = new Gtk.Label({ label: fmt(init), css_classes: ["glass-lab-value"], valign: Gtk.Align.START })
    head.append(textCol(title, sub)); head.append(value)
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, decimals === 0 ? 1 : 10 ** -decimals)
    scale.set_draw_value(false)
    scale.set_value(init)
    scale.connect("value-changed", () => {
        let v = scale.get_value()
        if (decimals === 0) v = Math.round(v)
        value.set_label(fmt(v))
        cb(v)
    })
    const wheel = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL })
    wheel.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
    wheel.connect("scroll", (_c: Gtk.EventControllerScroll, _dx: number, dy: number) => {
        const adj = scroller.get_vadjustment()
        adj.set_value(adj.get_value() + dy * 48)
        return true
    })
    scale.add_controller(wheel)
    row.append(head); row.append(scale)
    return row
}
function ToggleRow(title: string, sub: string, init: boolean, cb: (v: boolean) => void): Gtk.Widget {
    const row = new Gtk.Box({ spacing: 8 })
    const sw = new Gtk.Switch({ active: init, valign: Gtk.Align.CENTER })
    sw.connect("notify::active", () => cb(sw.active))
    row.append(textCol(title, sub)); row.append(sw)
    return row
}
function DropDownRow(title: string, sub: string, init: string, options: string[], cb: (v: string) => void): Gtk.Widget {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    const dd = Gtk.DropDown.new_from_strings(options)
    dd.set_selected(Math.max(0, options.indexOf(init)))
    dd.connect("notify::selected", () => cb(options[dd.get_selected()]))
    row.append(textCol(title, sub)); row.append(dd)
    return row
}
// Which sections are open, kept across a rebuild of the column; the rest folded away.
const openSections = new Set(["Presets", "Fondo", "Piezas", "Sistema", "Tipo: cristal", "Tipo: denso"])
let stash: LabState | null = null   // A/B: the recipe, while the factory values are shown
/** (Re)builds the controls from `state` — after a preset or a reset every slider moves. */
function fillControls() {
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_start: 16, margin_end: 16,
        margin_top: 16, margin_bottom: 16 })
    // Where the column was scrolled to survives the rebuild.
    const at = scroller.get_vadjustment().get_value()
    scroller.set_child(page)
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { scroller.get_vadjustment().set_value(at); return GLib.SOURCE_REMOVE })
    const rebuild = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { fillControls(); return GLib.SOURCE_REMOVE })

    // A section folds: the column is long, and most of it is not what is being tuned.
    const section = (title: string, rows: Gtk.Widget[], footer = "") => {
        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 10, margin_start: 4 })
        rows.forEach(r => body.append(r))
        if (footer) body.append(new Gtk.Label({ label: footer, xalign: 0, wrap: true, css_classes: ["glass-lab-footer"] }))
        const ex = new Gtk.Expander({ label: title, expanded: openSections.has(title), css_classes: ["glass-lab-section"] })
        ex.set_child(body)
        ex.connect("notify::expanded", () => { if (ex.expanded) openSections.add(title); else openSections.delete(title) })
        page.append(ex)
    }
    const tuningSlider = (key: string, title: string, sub: string, min: number, max: number, decimals = 2) =>
        SliderRow(title, sub, state.tuning[key] ?? D[key], min, max, v => {
            if (Math.abs(v - D[key]) < 1e-6) delete state.tuning[key]; else state.tuning[key] = v
            apply()
        }, { decimals, debounce: 0 })
    const labSlider = (i: number, title: string, sub: string, min: number, max: number, neutral: number, decimals = 2) =>
        SliderRow(title, sub, state.lab[i] + neutral, min, max, v => {
            state.lab[i] = Math.abs(v - neutral) < 1e-6 ? 0 : v - neutral
            apply()
        }, { decimals, debounce: 0 })

    // Presets, A/B, capture.
    const bar = new Gtk.Box({ spacing: 8 })
    const name = new Gtk.Entry({ placeholder_text: "nombre del preset", hexpand: true })
    const save = NidaraButton({ label: "Guardar" })
    save.connect("clicked", () => { const n = name.get_text().trim(); if (n) { savePreset(n); rebuild() } })
    bar.append(name); bar.append(save)
    page.append(bar)
    const names = presetNames()
    if (names.length) section("Presets", [DropDownRow("Cargar", "", "—", ["—", ...names], v => {
        if (v !== "—" && loadPreset(`${PRESETS}/${v}.json`)) { apply(); buildScene(); rebuild() }
    })])
    const ab = NidaraButton({ label: stash ? "A/B: volver a la receta" : "A/B: ver los valores de fábrica" })
    ab.connect("clicked", () => {
        // Only the RECIPE swaps (tuning, glass/scrim/ink switches, LAB hooks): the bench, the
        // backdrop, the system's mode and the export's settings stay as they are. A/B used to
        // swap the whole state without rebuilding the scene, so after «A/B, pick promo, A/B» the
        // screen showed the disc while the state said «todas» — and the export drew «todas».
        const recipe = (from: LabState) => ({ tuning: from.tuning, lab: from.lab, dense: from.dense, elevation: from.elevation,
            flags: { ...from.flags, dark: state.flags.dark } })
        if (stash) { state = { ...state, ...recipe(stash) }; stash = null; ab.set_label("A/B: ver los valores de fábrica") }
        else { stash = state; state = { ...state, ...recipe(factory()) }; ab.set_label("A/B: volver a la receta") }
        apply()
    })
    const reset = NidaraButton({ label: "Volver a fábrica" })
    reset.connect("clicked", () => { const b = state.backdrop; state = factory(); state.backdrop = b; apply(); buildScene(); rebuild() })
    const actions = new Gtk.Box({ spacing: 8 }); actions.append(ab); actions.append(reset)
    page.append(actions)

    const readout = new Gtk.Label({ label: "Pulsa «Medir» para leer el contraste en píxeles.", xalign: 0, wrap: true,
        css_classes: ["glass-lab-readout"], selectable: true })
    const measureBtn = NidaraButton({ label: "Medir" }), exportBtn = NidaraButton({ label: "Exportar imagen" })
    const videoBtn = NidaraButton({ label: "Exportar vídeo" })
    measureBtn.connect("clicked", () => {
        readout.set_label("midiendo…")
        measure(`${GLib.get_tmp_dir()}/glass-lab-${GLib.get_monotonic_time()}`, r =>
            readout.set_label(r.length ? r.map(fmt).join("\n") : "no se pudo capturar (¿Hyalo sin `msg`?)"))
    })
    exportBtn.connect("clicked", () => { readout.set_label("capturando…"); exportNative("image", m => readout.set_label(m)) })
    videoBtn.connect("clicked", () => { readout.set_label("preparando el vídeo…"); exportNative("video", m => readout.set_label(m)) })
    const quit = NidaraButton({ label: "Salir" })
    quit.connect("clicked", () => loop.quit())
    const mrow = new Gtk.Box({ spacing: 8 }); mrow.append(measureBtn); mrow.append(exportBtn); mrow.append(quit)
    const vrow = new Gtk.Box({ spacing: 8 }); vrow.append(videoBtn)
    page.append(mrow); page.append(vrow); page.append(readout)

    section("Fondo", [
        DropDownRow("Fondo", "", state.backdrop, BACKDROPS, v => { state.backdrop = v; apply() }),
        SliderRow("Desplazar", "también: arrastra el fondo con el ratón", state.offset * 100, 0, 100,
            v => { state.offset = v / 100; apply() }, { debounce: 0 }),
        ToggleRow("Movimiento automático", "el fondo pasa despacio por debajo del cristal", state.drift,
            v => { state.drift = v }),
        SliderRow("Velocidad", "× del movimiento; también la del vídeo", state.driftSpeed, 0.25, 4,
            v => { state.driftSpeed = v }, { decimals: 2, debounce: 0 }),
    ])
    section("Exportar", [
        DropDownRow("Formato", "16:9 1920×1080 · 1:1 1080×1080 · 4:5 1080×1350 · 9:16 1080×1920",
            state.promoFormat, Object.keys(FORMATS), v => { state.promoFormat = v as PromoFormat; frameGuide.queue_draw(); backdropArea?.queue_draw() }),
        SliderRow("Tamaño del círculo", "px del archivo exportado; 72 = un icono de la cuadrícula de apps",
            state.promoSize, 32, 1024, v => { state.promoSize = v; sizePromo() }, { decimals: 0, debounce: 0 }),
        SliderRow("Duración del vídeo", "segundos, a 60 fotogramas por segundo", state.videoSeconds, 2, 60,
            v => { state.videoSeconds = v }, { decimals: 0, debounce: 0 }),
    ], "El marco del formato elegido es lo que sale en el archivo, con lo que haya en el banco. «Exportar» lo dibuja aparte al tamaño exacto del formato (un Hyalo invisible de 1080×1920 para un 9:16), nunca al de la ventana; la ventana sigue funcionando mientras. El archivo es la misma escena que el marco, dibujada a más resolución: lo que ves es lo que sale. «promo: logo» deja solo el círculo; su tamaño, en px del archivo.")
    const benchTypes = state.show === "tipos de cristal"
        ? BENCH_PIECES.map(piece => DropDownRow(`Tipo: ${piece}`, "", state.types[piece], [...GLASS_TYPES],
            v => { state.types[piece] = v as GlassType; buildScene() }))
        : []
    section("Piezas", [DropDownRow("En el banco", "«tipos de cristal»: un menú y las tiles del centro de control, cada uno con su tipo",
        state.show, [...SHOWS], v => { state.show = v as Show; buildScene(); rebuild() }), ...benchTypes])
    section("Sistema", [ToggleRow("Modo oscuro", "el del sistema: lo siguen los controles del kit", state.flags.dark !== false,
        v => { state.flags.dark = v; apply() })])

    // ONE set of controls per TYPE of glass: the same rows, each type its own values.
    const store = (type: GlassType) => type === "cristal" ? state.tuning : state.dense
    const neutralOf = (type: GlassType, key: string) =>
        (type === "cristal" ? D : DD)[key] ?? (key === "blurSize" ? GLASS_BLUR.regular.size : GLASS_BLUR.regular.passes)
    const typeSlider = (type: GlassType, key: string, title: string, sub: string, min: number, max: number, decimals = 2) =>
        SliderRow(title, sub, store(type)[key] ?? neutralOf(type, key), min, max, v => {
            if (key === "blurPasses") v = Math.round(v)
            if (Math.abs(v - neutralOf(type, key)) < 1e-6) delete store(type)[key]; else store(type)[key] = v
            apply()
        }, { decimals, debounce: 0 })
    const shadowSlider = (type: GlassType, k: keyof Elevation, title: string, sub: string, max: number, decimals: number) =>
        SliderRow(title, sub, state.elevation[type][k], 0, max, v => { state.elevation[type][k] = v; refreshBench() },
            { decimals, debounce: 0 })
    const typeRows = (type: GlassType) => [
        typeSlider(type, "blurSize", "Escarcha: tamaño", `por pasada; ${GLASS_BLUR.regular.size} = fábrica`, 0.5, 6, 1),
        typeSlider(type, "blurPasses", "Escarcha: pasadas", `${GLASS_BLUR.regular.passes} = fábrica; 3 con tamaño 3 = la referencia`, 1, 5, 0),
        typeSlider(type, "alphaMin", "Tinte mínimo", "sobre fondo oscuro", 0, 1),
        typeSlider(type, type === "cristal" ? "tintLimit" : "alphaMax", "Tinte máximo",
            type === "cristal" ? "sobre fondo claro; lo demás lo pone la sombra de debajo" : "igual al mínimo = tinte uniforme", 0, 1),
        typeSlider(type, "target", "Objetivo de legibilidad", "0,183 = 4,5:1 para texto blanco; 1 = nunca se espesa", 0.05, 1, 3),
        typeSlider(type, "refraction", "Refracción mínima", "px", 0, 40, 0),
        typeSlider(type, "lensing", "Refracción según tamaño", "fracción del lado corto", 0, 0.15, 3),
        typeSlider(type, "rim", "Canto de luz", "", 0, 1.5),
        typeSlider(type, "saturation", "Saturación", "1 = sin cambio", 0.5, 2),
        shadowSlider(type, "alpha", "Sombra alrededor: opacidad", "fuera de la pieza; la dibuja el laboratorio, solo en «tipos de cristal»", 1, 2),
        shadowSlider(type, "blur", "Sombra alrededor: desenfoque", "px, como el blur de CSS", 80, 0),
        shadowSlider(type, "dy", "Sombra alrededor: hacia abajo", "px", 40, 0),
    ]
    section("Tipo: cristal", [
        ...typeRows("cristal"),
        ToggleRow("Sombra bajo el cristal", "la de legibilidad, debajo", state.flags.scrim, v => { state.flags.scrim = v; apply() }),
        typeSlider("cristal", "scrimMax", "Sombra bajo el cristal: máxima", "", 0, 1),
        typeSlider("cristal", "scrimFalloff", "Sombra bajo el cristal: fundido del panel", "px", 0, 400, 0),
        typeSlider("cristal", "scrimEdge", "Sombra bajo el cristal: borde / centro", "1 = uniforme", 0, 1),
        typeSlider("cristal", "scrimSize", "Sombra bajo el cristal: alcance suelta", "fracción del lado corto", 0, 1.5),
    ], "El cristal translúcido. En la referencia: el dock, el centro de control y la etiqueta del dock — sin sombra " +
        "alrededor, separados solo por una línea de 1 px («Línea oscura en el contorno», en «Común»). Tinte oscuro; " +
        "el texto, blanco o por el fondo («Color del texto»).")
    section("Tipo: denso", typeRows("denso"),
        "El mismo cristal con otras propiedades: tinte del color del modo (blanco en claro, oscuro en oscuro), " +
        "espeso, y el texto sigue al modo; sin sombra debajo. En la referencia: menús y paneles grandes, ≈ 0,98 de su " +
        "color, con sombra FUERA desplazada abajo — menú 0,23 · 15 px · 4 px, paneles 0,39 · 38 px · 18 px; en oscuro " +
        "más fuerte (0,27 y 0,68).")

    // What every type shares: the shader's own hooks and the text's colour.
    section("Común: color del texto", [
        ToggleRow("Texto que cambia a oscuro", "apagado: siempre blanco (ink = off)", state.flags.ink,
            v => { state.flags.ink = v; apply() }),
        DropDownRow("Deciden juntas", "qué piezas cambian a la vez", state.ink, ["pieza", "grupo", "panel"],
            v => { state.ink = v as Ink; apply(); buildScene() }),
        tuningSlider("inkDarkAbove", "Umbral a oscuro", "luminancia del punto más oscuro bajo el texto", 0.5, 1),
        tuningSlider("inkLightBelow", "Umbral de vuelta a blanco", "", 0.3, 0.95),
    ])
    section("Común: forma y luz (sombreador)", [
        ToggleRow("Cristal refractivo", "apagado: solo desenfoque", state.flags.glass, v => { state.flags.glass = v; apply() }),
        labSlider(4, "Perfil del bisel", "5 = fábrica; más = se dobla más en el borde y menos dentro", 1, 9, 5),
        labSlider(12, "Ancho máximo del bisel", "px; 80 = fábrica. Por dentro, cristal plano", 20, 600, 80, 0),
        labSlider(11, "Esquinas del bisel ×", "1 = fábrica (sin pliegue); 0 = el pliegue en diagonal", 0, 2, 1),
        labSlider(5, "Refracción ×", "sobre la de fábrica (1)", 0, 3, 1),
        labSlider(6, "Dispersión de color", "0 = fábrica (ninguna); 1 = la de antes", 0, 4, 0),
        labSlider(10, "Grosor del canto ×", "sobre el de fábrica (1 = 3,2 px)", 0.1, 3, 1),
        labSlider(13, "Canto: lado opuesto a la luz ×", "sobre el de fábrica (1)", 0, 3, 1),
        labSlider(14, "Canto: línea en todo el contorno", "0 = fábrica (ninguna); 0,18 = la de antes", 0, 0.4, 0),
        labSlider(9, "Brillo interior", "0 = fábrica (ninguno); 1 = el de antes", 0, 3, 0),
        labSlider(8, "Ángulo de la luz", "grados, 0 = fábrica", -180, 180, 0, 0),
        labSlider(15, "Línea oscura en el contorno", "1 px; 0 = fábrica (ninguna); 0,37 = la referencia", 0, 1, 0),
        labSlider(0, "Comprimir blancos: techo", "0 = apagado; luminancia a la que llega el blanco", 0, 1, 0),
        labSlider(1, "Comprimir blancos: rodilla", "por debajo no cambia nada (0 = 0,15)", 0, 0.6, 0),
        labSlider(2, "Velo oscuro uniforme", "como la capa del 35 % de la variante transparente", 0, 0.7, 0),
    ], "Estos los aplica el sombreador a TODOS los tipos por igual (aún no van por tipo). " +
        "La referencia medida: escarcha 3:3 y, en reposo, una línea oscura (0,37); su canto de luz sí sale en los vídeos. " +
        "El ancho del bisel fija también la fuerza: a 20 el borde desvía 14 px como mucho (55 a 80).")
    section("Aparición", [
        tuningSlider("formationHold", "Formación (congelar)", "0 = apagado, cristal formado; 0,01–0,99 = congelado a esa formación", 0, 1),
    ], "Un cristal que aparece se materializa: su desenfoque, su refracción, su tinte y su canto crecen desde cero, sin fundido (#764). El deslizador congela todas las piezas en un punto de ese crecimiento para juzgarlo; en el escritorio el contenido aparece en la segunda mitad.")
}

// ── Start ───────────────────────────────────────────────────────────────────
const preset = env("GLASS_LAB_PRESET")
if (preset) loadPreset(preset)
if (env("GLASS_LAB_BG")) state.backdrop = env("GLASS_LAB_BG")
if (env("GLASS_LAB_SHOW")) state.show = env("GLASS_LAB_SHOW") as Show
apply()
buildScene()
bgWin.present()
scene.present()
const loop = GLib.MainLoop.new(null, false)
if (SHOT && env("GLASS_LAB_EXPORT")) {
    // Headless export (glass-lab.sh --headless OUT.png --export image|video [--size WxH]): the
    // export, then quit. OUT.progress holds its progress (the window's «Exportar» reads it);
    // OUT.txt its result, which is also what the script waits for.
    const kind = env("GLASS_LAB_EXPORT")
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
        const report = (m: string) => {
            print(m)
            if (m.startsWith("grabando") || m.startsWith("preparando") || m.startsWith("capturando")) {
                writeFile(SHOT.replace(/\.png$/, ".progress"), m)
                return
            }
            writeFile(SHOT.replace(/\.png$/, ".txt"), `${JSON.stringify(state)}\n${m}\n`)
            loop.quit()
        }
        if (kind === "image") exportImage(report); else exportVideo(report)
        return GLib.SOURCE_REMOVE
    })
} else if (SHOT) {
    // Headless: let the glass, the ink and the shadow settle, then one capture and the readings.
    // GLASS_LAB_SHOT_DELAY (ms): wait longer, e.g. to measure the lab's own cost while it drifts.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(env("GLASS_LAB_SHOT_DELAY")) || 3000, () => {
        screenshot(SHOT, ok => {
            if (!ok) { printerr("glass-lab: screenshot failed"); loop.quit(); return }
            measure(SHOT.replace(/\.png$/, ""), r => {
                const text = r.map(fmt).join("\n")
                print(text)
                writeFile(SHOT.replace(/\.png$/, ".txt"), `${JSON.stringify(state)}\n${text}\n${debugLines.join("\n")}\n`)
                loop.quit()
            })
        })
        return GLib.SOURCE_REMOVE
    })
} else {
    // Beside the controls' column, not under it: a margin inside the scene, which spans the output.
    // (Not the layer's margin or exclusive zone: Hyalo lays a layer anchored to both sides over
    // the whole output either way, seen nested 2026-10-05.)
    stageHolder.margin_end = CONTROLS_W
    // A test of the window's «Exportar» without a pointer (GLASS_LAB_TEST_EXPORT=image|video): the
    // native export as the button starts it, its result printed, then quit.
    const test = env("GLASS_LAB_TEST_EXPORT")
    if (test === "image" || test === "video") GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
        exportNative(test, m => { print(`[export] ${m}`); if (!exporting && !m.startsWith("exportando")) loop.quit() })
        return GLib.SOURCE_REMOVE
    })
    fillControls()
    controlsWin.present()
}
loop.run()
