/**
 * Fluid Crystal Token Engine 🔮
 * Single source of truth for all theme colors.
 * 
 * Architecture:
 *  - Dark/Light mode: Managed by Libadwaita via color-scheme (real-time)
 *  - Accent, transparency, tint: Managed by Fluid Crystal via @define-color (restart for external apps)
 *  - Surface colors (window_bg, view_bg, etc.): NOT overridden — Libadwaita handles them dynamically
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

// ── COLOR PALETTES ───────────────────────────────────────────────────

export const ADWAITA_PALETTE = `@define-color blue_1 #99c1f1;
@define-color blue_2 #62a0ea;
@define-color blue_3 #3584e4;
@define-color blue_4 #1c71d8;
@define-color blue_5 #1a5fb4;
@define-color green_1 #8ff0a4;
@define-color green_2 #57e389;
@define-color green_3 #33d17a;
@define-color green_4 #2ec27e;
@define-color green_5 #26a269;
@define-color yellow_1 #f9f06b;
@define-color yellow_2 #f8e45c;
@define-color yellow_3 #f6d32d;
@define-color yellow_4 #f5c211;
@define-color yellow_5 #e5a50a;
@define-color orange_1 #ffbe6f;
@define-color orange_2 #ffa348;
@define-color orange_3 #ff7800;
@define-color orange_4 #e66100;
@define-color orange_5 #c64600;
@define-color red_1 #f66151;
@define-color red_2 #ed333b;
@define-color red_3 #e01b24;
@define-color red_4 #c01c28;
@define-color red_5 #a51d2d;
@define-color purple_1 #dc8add;
@define-color purple_2 #c061cb;
@define-color purple_3 #9141ac;
@define-color purple_4 #813d9c;
@define-color purple_5 #613583;
@define-color brown_1 #cdab8f;
@define-color brown_2 #b5835a;
@define-color brown_3 #986a44;
@define-color brown_4 #865e3c;
@define-color brown_5 #63452c;
@define-color light_1 #ffffff;
@define-color light_2 #f6f5f4;
@define-color light_3 #deddda;
@define-color light_4 #c0bfbc;
@define-color light_5 #9a9996;
@define-color dark_1 #77767b;
@define-color dark_2 #5e5c64;
@define-color dark_3 #3d3846;
@define-color dark_4 #241f31;
@define-color dark_5 #000000;`

export const ACCENT_PALETTE = {
    blue: { color: "#0088FF", name: "Blue" },
    teal: { color: "#2190a4", name: "Teal" },
    green: { color: "#79B757", name: "Green" },
    yellow: { color: "#F3BA4B", name: "Yellow" },
    orange: { color: "#E9873A", name: "Orange" },
    red: { color: "#ED5F5D", name: "Red" },
    pink: { color: "#E55E9C", name: "Pink" },
    purple: { color: "#9A57A3", name: "Purple" },
    slate: { color: "#6f8396", name: "Slate" },
} as const

export type AccentKey = keyof typeof ACCENT_PALETTE

// ── TYPES & INTERFACES ──────────────────────────────────────────────

export interface TintPanels {
    controlCenter: boolean
    appGrid: boolean
}

export interface GlassTargets {
    globalWindow: boolean
    headerbars: boolean
    sidebars: boolean
    mainViews: boolean
    cardsAndLists: boolean
    popovers: boolean
    separators: boolean
}

export interface FluidCrystalConfig {
    enabled: boolean
    accent: AccentKey
    isDark: boolean
    transparency: number
    tintStrength: number
    tintPanels: TintPanels
    glassTargets: GlassTargets
}

export const DEFAULT_CONFIG: FluidCrystalConfig = {
    enabled: true,
    accent: "blue",
    isDark: true,
    transparency: 0.75,
    tintStrength: 0.0,
    tintPanels: {
        controlCenter: false,
        appGrid: false,
    },
    glassTargets: {
        globalWindow: true,
        headerbars: true,
        sidebars: true,
        mainViews: true,
        cardsAndLists: false,
        popovers: true,
        separators: true,
    }
}

// ── CSS TEMPLATES ────────────────────────────────────────────────────

const GLASS_TEMPLATES: Record<keyof GlassTargets, string> = {
    globalWindow: `
window.background:not(.popup), 
window.background.csd:not(.popup), 
dialog.background:not(.popup),
popover.background > contents,
popover > contents {
  background-color: @fc_window_bg;
  background-image: none;
}

window.background:backdrop:not(.popup), 
window.background.csd:backdrop:not(.popup), 
dialog.background:backdrop:not(.popup) {
  background-color: @fc_window_bg_backdrop;
}`,
    headerbars: `
window headerbar, window .titlebar, window actionbar, 
window searchbar, window toolbar, window tabbar {
  background: transparent;
  background-color: transparent;
  background-image: none;
  box-shadow: none;
  border: none;
  border-bottom: 1px solid alpha(@window_fg_color, 0.05);
}`,
    sidebars: `
window .navigation-sidebar, 
window .sidebar, 
window placessidebar,
window.csd > contents > box > stack > box > scrolledwindow { /* Covers some Settings sidebars */
  background-color: alpha(@window_fg_color, 0.04);
  background-image: none;
  border-none;
  border-right: 1px solid alpha(@window_fg_color, 0.05);
}

window .navigation-sidebar:backdrop, 
window .sidebar:backdrop, 
window placessidebar:backdrop,
window.csd > contents > box > stack > box > scrolledwindow:backdrop {
  background-color: transparent;
  border-color: transparent;
}`,
    mainViews: `
/* V833: TRULY SCOPED APP OVERRIDES
   Instead of violently fighting AGS with '!important' or ':not(#id)' hacks, 
   we simply restrict the opacity rules to the APPS that really need them, 
   leaving the base GTK 'window' layer blank so AGS can be naturally transparent.
*/

/* Nautilus Depth System */
.nautilus-window view, .nautilus-window .view,
.nautilus-window textview, .nautilus-window textview > text,
.nautilus-window scrolledwindow, .nautilus-window viewport,
.nautilus-window list, .nautilus-window grid,
.nautilus-window stack, .nautilus-window deck,
.nautilus-window leaflet, .nautilus-window flap,
.nautilus-window paned, .nautilus-window overlay,
.nautilus-window notebook, .nautilus-window carousel,
.nautilus-window > contents,
.nautilus-window flap,
.nautilus-window > deck > box > paned > separator {
  background-color: alpha(@window_bg_color, 0.65); /* Opaque for readability */
  background-image: none;
  box-shadow: none;
  border: none;
}

.nautilus-window view:backdrop, .nautilus-window .view:backdrop {
  background-color: transparent;
}

/* Settings Depth System (Optional generic fallback for non-AGS windows) */
window.csd:not(.popup):not(.osd) > contents > box > stack > stack > stack > box > scrolledwindow > viewport > clamp > box > box > list {
  background-color: alpha(@window_bg_color, 0.65);
}
`,
    separators: `
window separator, window paned > separator, 
popover separator, window > separator.vertical {
  background-color: alpha(@window_fg_color, 0.10);
  background-image: none;
}`,
    cardsAndLists: `
window card, window boxed-list, window list.boxed, window .card {
  background-color: alpha(@window_fg_color, 0.05);
  background-image: none;
  border: 1px solid alpha(@window_fg_color, 0.08);
}`,
    popovers: `
popover.background > contents,
popover > contents,
.menu,
.background.popup {
  background-color: @fc_popover_bg;
  background-image: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  border: 1px solid alpha(@window_fg_color, 0.1);
}`
}

const FORCE_ACCENT_CSS = `
/* 10. UNIVERSAL GTK ACCENT DICTIONARY (Phase 10: The Absolute Complete Map) */

/* Block A: General Selection & Basic Interactives (400-600 points) */
:not(:disabled):not(:backdrop) .suggested-action,
:not(:disabled):not(:backdrop) .accent,
:not(:disabled):not(:backdrop) selection,
:not(:disabled):not(:backdrop) .selected,
:not(:disabled):not(:backdrop) row:selected,
:not(:disabled):not(:backdrop) button.suggested-action,
:not(:disabled):not(:backdrop) menuitem:hover,
:not(:disabled):not(:backdrop) .menu menuitem:hover {
  background-color: @accent_bg_color;
  background-image: none;
  border-color: @accent_bg_color;
  color: @accent_fg_color;
}

/* Block B: Checkboxes & Trees (The "Otto" Universal Fix) */
:not(:disabled):not(:backdrop) check:checked,
:not(:disabled):not(:backdrop) radio:checked,
:not(:disabled):not(:backdrop) treeview.view check:checked,
:not(:disabled):not(:backdrop) columnview row check:checked,
:not(:disabled):not(:backdrop) row check:checked,
:not(:disabled):not(:backdrop) check:indeterminate,
:not(:disabled):not(:backdrop) .view.check:checked,
:not(:disabled):not(:backdrop) .cell.check:checked {
  background-color: @accent_bg_color;
  background-image: none;
  border-color: @accent_bg_color;
  color: @accent_fg_color;
  -gtk-icon-source: builtin;
}

/* Block C: Switches */
:not(:disabled):not(:backdrop) switch:checked {
  background-color: @accent_bg_color;
  background-image: none;
  border-color: @accent_bg_color;
}
:not(:disabled):not(:backdrop) switch:checked > slider {
  background-color: white;
  border: 1px solid alpha(black, 0.1);
}

/* Block D: Scales & Progress */
:not(:disabled):not(:backdrop) scale highlight,
:not(:disabled):not(:backdrop) progressbar > trough > progress,
:not(:disabled):not(:backdrop) levelbar > trough > block,
:not(:disabled):not(:backdrop) scale.vertical highlight {
  background-color: @accent_bg_color;
  background-image: none;
}

/* Block E: Entries & Search */
:not(:disabled):not(:backdrop) entry:focus,
:not(:disabled):not(:backdrop) searchbar entry:focus,
:not(:disabled):not(:backdrop) .linked entry:focus {
  border-color: @accent_bg_color;
  box-shadow: inset 0 0 0 1px @accent_bg_color;
}

/* Block F: Icons & Miscellaneous Symbols */
:not(:disabled):not(:backdrop) .symbolic.accent,
:not(:disabled):not(:backdrop) image.accent,
:not(:disabled):not(:backdrop) .titlebutton.close:hover {
  color: @accent_bg_color;
}

/* Block G: Backdrop Fallbacks (Subdued Accents) */
:backdrop .suggested-action,
:backdrop .selected,
:backdrop check:checked,
:backdrop switch:checked {
  background-color: alpha(@window_fg_color, 0.15);
  border-color: transparent;
  color: alpha(@window_fg_color, 0.5);
}
`

const PANEL_SELECTORS: Record<keyof TintPanels, string[]> = {
    controlCenter: [".cc-panel-structure"],
    appGrid: [".app-grid-content"],
}

// ── LOGIC ────────────────────────────────────────────────────────────

function generateTokenHeader(config: FluidCrystalConfig): string {
    const accent = ACCENT_PALETTE[config.accent].color
    const t = config.transparency
    // Base window glass logic based on user transparency setting
    const baseAlpha = (1.0 - t).toFixed(2)
    const backdropAlpha = Math.min(1.0, 1.0 - t * 0.5 + 0.2).toFixed(2)
    const popoverAlpha = (1.0 - t * 0.3).toFixed(2)

    const lines = [
        `/* Fluid Crystal Generated Settings */`,
        ADWAITA_PALETTE,
        `@define-color accent_bg_color ${accent};`,
        `@define-color accent_fg_color #ffffff;`,
        `@define-color accent_color ${accent};`,
        `@define-color fc_window_bg alpha(@window_bg_color, ${baseAlpha});`,
        `@define-color fc_window_bg_backdrop alpha(@window_bg_color, ${backdropAlpha});`,
        `@define-color fc_popover_bg alpha(@window_bg_color, ${popoverAlpha});`,
        `@define-color destructive_bg_color #ED5F5D;`,
        `@define-color success_bg_color #79B757;`,
        `:root {`,
    ]
    for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
        lines.push(`  --accent-${key}: ${color};`)
    }
    lines.push(`  --accent-color: ${accent};`)
    lines.push(`  --accent-bg-color: ${accent};`)
    lines.push(`  --accent-fg-color: #ffffff;`)
    lines.push(`}`)
    return lines.join("\n")
}

export function generateGtkCss(config: FluidCrystalConfig, baseThemeCssPath?: string): string {
    let importStatement = baseThemeCssPath ? `@import url("file://${baseThemeCssPath}");\n\n` : ""
    let overlayTemplate = `/* Overlay */\n`
    for (const [key, enabled] of Object.entries(config.glassTargets)) {
        if (enabled && GLASS_TEMPLATES[key as keyof GlassTargets]) {
            overlayTemplate += GLASS_TEMPLATES[key as keyof GlassTargets] + "\n"
        }
    }
    overlayTemplate += "\n" + FORCE_ACCENT_CSS
    return importStatement + generateTokenHeader(config) + "\n" + overlayTemplate
}

export function generateTokensCss(config: FluidCrystalConfig): string {
    return generateTokenHeader(config)
}

export function generateTintCss(config: FluidCrystalConfig): string {
    const accent = ACCENT_PALETTE[config.accent].color
    const strength = config.tintStrength
    if (strength <= 0) return "/* No tint */"
    const r = parseInt(accent.slice(1, 3), 16)
    const g = parseInt(accent.slice(3, 5), 16)
    const b = parseInt(accent.slice(5, 7), 16)
    const alpha = (strength * 0.3).toFixed(3)
    let css = `/* Tint */\n`
    for (const [panel, selectors] of Object.entries(PANEL_SELECTORS)) {
        if (!config.tintPanels[panel as keyof TintPanels]) continue
        for (const sel of selectors) {
            css += `${sel} { background-color: rgba(${r}, ${g}, ${b}, ${alpha}); }\n`
        }
    }
    return css
}

export function writeGeneratedTheme(config: FluidCrystalConfig, baseThemeCssPath?: string): void {
    const css = generateGtkCss(config, baseThemeCssPath)
    const projectDir = GLib.getenv("DISTROIA_DIR") || `${GLib.get_home_dir()}/Dev/Distroia`
    const outDir = `${projectDir}/themes/fluid-crystal/gtk-4.0`
    writeFile(`${outDir}/gtk.css`, css)
    writeFile(`${outDir}/gtk-dark.css`, css)
}

export function installFluidCrystalSymlinks(): void {
    const projectDir = GLib.getenv("DISTROIA_DIR") || `${GLib.get_home_dir()}/Dev/Distroia`
    const outDir = `${projectDir}/themes/fluid-crystal/gtk-4.0`
    const gtkDir = `${GLib.get_home_dir()}/.config/gtk-4.0`
    const targets = ["gtk.css", "gtk-dark.css"]

    // Ensure the config directory exists
    const configDir = Gio.File.new_for_path(gtkDir)
    if (!configDir.query_exists(null)) {
        configDir.make_directory_with_parents(null)
    }

    for (const name of targets) {
        try {
            const file = Gio.File.new_for_path(`${gtkDir}/${name}`)
            if (file.query_exists(null)) {
                // Check if it's already the correct symlink to avoid redundant ops
                const info = file.query_info("standard::is-symlink,standard::symlink-target", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
                if (info.get_is_symlink() && info.get_symlink_target() === `${outDir}/${name}`) {
                    continue
                }
                file.delete(null)
            }
            file.make_symbolic_link(`${outDir}/${name}`, null)
        } catch (e) {
            console.warn(`[FluidCrystal] Could not handle ${name} symlink: ${e}`)
        }
    }
}

const CONFIG_PATH = `${GLib.get_home_dir()}/.config/distroia/fluid-crystal.json`

export function saveConfig(config: FluidCrystalConfig): void {
    const dir = `${GLib.get_home_dir()}/.config/distroia`
    GLib.mkdir_with_parents(dir, 0o755)
    writeFile(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function loadConfig(): FluidCrystalConfig {
    try {
        const data = readFile(CONFIG_PATH)
        if (data) return { ...DEFAULT_CONFIG, ...JSON.parse(data) }
    } catch (e) { }
    return { ...DEFAULT_CONFIG }
}
