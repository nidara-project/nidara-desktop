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

// ── ACCENT PALETTE (Apple-style, 9 options) ──────────────────────────
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

// ── PANEL TINT TARGETS ──────────────────────────────────────────────
// Note: Top bar and Dock use Cairo rendering, so CSS tinting doesn't apply
export interface TintPanels {
    controlCenter: boolean
    appGrid: boolean
}

// ── X-RAY GLASS TARGETS (Modular Sledgehammer) ──────────────────────
// Lets the user systematically remove opaque nodes from modern Libadwaita apps
export interface GlassTargets {
    globalWindow: boolean
    headerbars: boolean
    sidebars: boolean
    mainViews: boolean
    cardsAndLists: boolean
    popovers: boolean
    separators: boolean
}

// ── USER-CONFIGURABLE STATE ──────────────────────────────────────────
export interface FluidCrystalConfig {
    enabled: boolean
    accent: AccentKey
    isDark: boolean         // Passed to Libadwaita's color-scheme (NOT used in CSS)
    transparency: number    // 0.0 (solid) → 1.0 (full glass)
    tintStrength: number    // 0.0 → 1.0 (how much accent tints surfaces)
    tintPanels: TintPanels  // Which panels get accent tinting
    glassTargets: GlassTargets // Granular control over which GTK nodes get stripped
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

// ── CSS TEMPLATES FOR SELECTIVE STRIPPING ────────────────────────────
const GLASS_TEMPLATES: Record<keyof GlassTargets, string> = {
    globalWindow: `
/* 1. THE GLASS SHELL (Root Window & Popovers) */
window.background:not(.popup):not(#Z), 
window.background.csd:not(.popup):not(#Z), 
dialog.background:not(.popup):not(#Z),
popover.background > contents:not(#Z),
popover > contents:not(#Z) {
  background-color: @fc_window_bg;
  background-image: none;
}`,
    headerbars: `
/* 2. STRUCTURAL STRIPPING (Headerbars & Toolbars) */
window headerbar:not(#Z):not(#Y):not(#X):not(#W), 
window .titlebar:not(#Z):not(#Y):not(#X):not(#W), 
window actionbar:not(#Z):not(#Y):not(#X):not(#W), 
window searchbar:not(#Z):not(#Y):not(#X):not(#W), 
window toolbar:not(#Z):not(#Y):not(#X):not(#W), 
window tabbar:not(#Z):not(#Y):not(#X):not(#W) {
  background: transparent;
  background-color: transparent;
  background-image: none;
  box-shadow: none;
  border: none;
  border-bottom: none;
}
/* Eliminate horizontal lines under titlebars (e.g. Calculator, Text Editor) */
window headerbar > separator:not(#Z):not(#Y), 
window .titlebar > separator:not(#Z):not(#Y), 
window separator.titlebar:not(#Z):not(#Y),
window > separator.horizontal:not(#Z):not(#Y) {
  background: transparent;
  background-color: transparent;
  background-image: none;
  box-shadow: none;
  border: none;
  min-height: 0;
}`,
    sidebars: `
/* 3. STRUCTURAL STRIPPING (Sidebars) */
window .navigation-sidebar:not(#Z), window .sidebar:not(#Z), window placessidebar:not(#Z) {
  background: alpha(@window_fg_color, 0.03);
  background-color: alpha(@window_fg_color, 0.03);
  background-image: none;
  border: none;
  box-shadow: none;
}`,
    mainViews: `
/* 4. STRUCTURAL STRIPPING (Views & Containers) */
/* This X-Rays the entire GTK routing and view structure universally */
window view:not(#Z), window .view:not(#Z), window textview:not(#Z), window textview > text:not(#Z),
window scrolledwindow:not(#Z), window viewport:not(#Z), window list:not(#Z), window grid:not(#Z),
window stack:not(#Z), window deck:not(#Z), window leaflet:not(#Z), window flap:not(#Z), window paned:not(#Z), window overlay:not(#Z),
window .navigation-sidebar:not(#Z), window .sidebar:not(#Z), window placessidebar:not(#Z),
window notebook:not(#Z), window carousel:not(#Z), window > contents:not(#Z),
window * > .background:not(window):not(dialog):not(popover):not(#Z),
window widget:not(#Z) {
  background-color: transparent;
  background-image: none;
  box-shadow: none;
  border: none;
}`,
    separators: `
/* 4.5 INTERNAL PANEL SEPARATORS */
/* Vertical dividers between sidebars and content panes stay slightly visible for structure */
window separator:not(#Z), window paned > separator:not(#Z), 
popover separator:not(#Z), window > separator.vertical:not(#Z) {
  background-color: alpha(@window_fg_color, 0.10);
  background-image: none;
}`,
    cardsAndLists: `
/* 5. ELEVATED SURFACES (Cards & Boxed Lists) */
window card:not(#Z), window boxed-list:not(#Z), window list.boxed:not(#Z), window .card:not(#Z) {
  background-color: alpha(@window_fg_color, 0.05);
  background-image: none;
  border: 1px solid alpha(@window_fg_color, 0.08);
}`,
    popovers: `
/* (Popovers are handled in the Glass Shell to avoid duplicate complexity) */
`
}

const FORCE_ACCENT_CSS = `
/* 7. BRUTE-FORCE ACCENT INJECTION */
/* Overrides external compiled SASS themes that hardcode static hex values instead of using GTK named colors */
window .suggested-action:not(#Z), window .accent:not(#Z), window selection:not(#Z), window .selection:not(#Z), window button.suggested-action:not(#Z), window switch:checked:not(#Z), window scale highlight:not(#Z), window entry selection:not(#Z), window spinbutton selection:not(#Z), window label selection:not(#Z),
window row:selected:not(#Z), window child:selected:not(#Z), window .selected:not(#Z),
* toast:not(#Z):not(#Y):not(#X):not(#W), * .toast:not(#Z):not(#Y):not(#X):not(#W), * .app-notification:not(#Z):not(#Y):not(#X):not(#W), * snackbar:not(#Z):not(#Y):not(#X):not(#W),
* .floating-bar:not(#Z):not(#Y):not(#X):not(#W), .floating-bar:not(#Z):not(#Y):not(#X):not(#W) > widget,
toast:not(#Z):not(#Y):not(#X):not(#W) > widget, .toast:not(#Z):not(#Y):not(#X):not(#W) > widget, toast * > .background:not(#Z),
* check:checked:not(#Z):not(#Y):not(#X):not(#W), * radio:checked:not(#Z):not(#Y):not(#X):not(#W),
* button.circular:checked:not(#Z):not(#Y):not(#X):not(#W), * button.tick:checked:not(#Z):not(#Y):not(#X):not(#W),
popover.menu button:hover:not(#Z), popover.menu modelbutton:hover:not(#Z), popover.menu menuitem:hover:not(#Z), 
popover.menu button:active:not(#Z), popover.menu modelbutton:active:not(#Z), popover.menu menuitem:active:not(#Z),
popover.menu button:selected:not(#Z), popover.menu modelbutton:selected:not(#Z), popover.menu menuitem:selected:not(#Z) {
  background-color: @accent_bg_color;
  color: @accent_fg_color;
}

/* 7.5 THE UNIVERSAL GTK ACCENT MAP (Sledgehammer Vectors) */
/* 
   By targeting the absolute base semantic nodes of GTK with 400-point specificity, 
   we seize control of all interactive colored elements universally across ANY theme.
*/

/* Checkboxes, Radios, and Switches */
check:checked:not(#Z):not(#Y):not(#X):not(#W), 
radio:checked:not(#Z):not(#Y):not(#X):not(#W),
switch:checked:not(#Z):not(#Y):not(#X):not(#W) {
  background-image: none;
  background: none;
  background-color: @accent_bg_color;
  border-color: @accent_bg_color;
}

/* Base Primary Buttons */
button.suggested-action:not(#Z):not(#Y):not(#X):not(#W),
button.primary:not(#Z):not(#Y):not(#X):not(#W) {
  background-image: none;
  background-color: @accent_bg_color;
  color: @accent_fg_color;
  border-color: alpha(@window_fg_color, 0.1);
}

/* Selected List Rows & TreeViews */
row:selected:not(#Z):not(#Y):not(#X):not(#W),
treeview:selected:not(#Z):not(#Y):not(#X):not(#W),
infobar.info:not(#Z):not(#Y):not(#X):not(#W) {
  background-image: none;
  background-color: alpha(@accent_bg_color, 0.2);
  color: @window_fg_color;
}

/* Progressbars and Scales/Sliders */
progressbar > trough > progress:not(#Z):not(#Y):not(#X),
scale > trough > highlight:not(#Z):not(#Y):not(#X),
levelbar > trough > block.filled:not(#Z):not(#Y):not(#X) {
  background-image: none;
  background-color: @accent_bg_color;
  border-color: alpha(@window_fg_color, 0.1);
}

/* Tooltips & Toasts Wrapper */
toast:not(#Z):not(#Y):not(#X):not(#W), 
.toast:not(#Z):not(#Y):not(#X):not(#W), 
toast:not(#Z):not(#Y):not(#X):not(#W) > widget,
.floating-bar:not(#Z):not(#Y):not(#X):not(#W), 
.floating-bar:not(#Z):not(#Y):not(#X):not(#W) > widget {
  background-image: none;
  background: none;
  background-color: @accent_bg_color;
  color: @accent_fg_color;
}

/* 8. INPUT FIELD FOCUS RING FIX (Universal Text Entries) */
entry:focus:not(#Z):not(#Y):not(#X):not(#W),
entry:focus-within:not(#Z):not(#Y):not(#X):not(#W),
textview:focus:not(#Z):not(#Y):not(#X):not(#W),
#NautilusPathBar entry:focus:not(#Z):not(#Y) {
  background-image: none;
  background-color: rgba(255, 255, 255, 0.05);
  box-shadow: 0 5px 12px rgba(0, 0, 0, 0.2), inset 0 0 0 2px @accent_bg_color;
}
`

// ── PANEL CSS SELECTORS ──────────────────────────────────────────────
const PANEL_SELECTORS: Record<keyof TintPanels, string[]> = {
    controlCenter: [".cc-panel-structure"],
    appGrid: [".app-grid-content"],
}

/**
 * Generate dynamic CSS for panel accent tinting.
 * This CSS is loaded into a CssProvider for real-time updates.
 */
export function generateTintCss(config: FluidCrystalConfig): string {
    const accent = ACCENT_PALETTE[config.accent].color
    const strength = config.tintStrength

    if (strength <= 0) return "/* No tint applied */"

    // Convert hex accent to rgba for alpha compositing
    const r = parseInt(accent.slice(1, 3), 16)
    const g = parseInt(accent.slice(3, 5), 16)
    const b = parseInt(accent.slice(5, 7), 16)
    const alpha = (strength * 0.3).toFixed(3) // Max 30% tint to keep it subtle

    let css = `/* ── Fluid Crystal Panel Tint ── */\n`
    css += `/* Accent: ${accent} | Strength: ${(strength * 100).toFixed(0)}% */\n\n`

    for (const [panel, selectors] of Object.entries(PANEL_SELECTORS)) {
        if (!config.tintPanels[panel as keyof TintPanels]) continue

        for (const sel of selectors) {
            css += `${sel} {\n`
            css += `    background-color: rgba(${r}, ${g}, ${b}, ${alpha});\n`
            css += `}\n\n`
        }
    }

    return css
}

// ── ADWAITA COLOR PALETTE (always included) ──────────────────────────
const ADWAITA_PALETTE = `@define-color blue_1 #99c1f1;
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

// ── TOKEN GENERATION ─────────────────────────────────────────────────

/**
 * Generate the @define-color header block.
 * 
 * KEY PRINCIPLE: We do NOT define surface colors (window_bg, view_bg, headerbar_bg, etc.)
 * Those are managed by Libadwaita based on color-scheme and switch in real-time.
 * 
 * We ONLY define:
 *  - Accent colors (user's choice)
 *  - Semantic colors (destructive, success, warning, error)
 *  - Transparency derivatives (sidebar, popover, dialog — referencing Libadwaita's dynamic colors)
 */
function generateTokenHeader(config: FluidCrystalConfig): string {
    const accent = ACCENT_PALETTE[config.accent].color
    const t = config.transparency

    const lines: string[] = [
        `/* ── FLUID CRYSTAL — Generated Theme ── */`,
        `/* Accent: ${ACCENT_PALETTE[config.accent].name} | Transparency: ${(t * 100).toFixed(0)}% */`,
        `/* Dark/Light mode: Managed by Libadwaita (color-scheme) */`,
        ``,
        ADWAITA_PALETTE,
        ``,
        `/* ── Accent Colors (Fluid Crystal) ── */`,
        `@define-color accent_bg_color ${accent};`,
        `@define-color accent_fg_color #ffffff;`,
        `@define-color accent_color ${accent};`,
        ``,
        `/* ── Semantic Colors ── */`,
        `@define-color destructive_bg_color #ED5F5D;`,
        `@define-color destructive_fg_color #ffffff;`,
        `@define-color destructive_color #ED5F5D;`,
        `@define-color success_bg_color #79B757;`,
        `@define-color success_fg_color #ffffff;`,
        `@define-color success_color #79B757;`,
        `@define-color warning_bg_color #E9873A;`,
        `@define-color warning_fg_color #ffffff;`,
        `@define-color warning_color #E9873A;`,
        `@define-color error_bg_color #ED5F5D;`,
        `@define-color error_fg_color #ffffff;`,
        `@define-color error_color #ED5F5D;`,
        ``,
        `/* ── Transparency Core Override (Fluid Crystal X-Ray Shell) ── */`,
        `@define-color fc_window_bg alpha(@window_bg_color, ${(0.96 * t).toFixed(2)});`,
        ``,
        `/* ── CSS Custom Properties for accent palette ── */`,
    ]

    // Add CSS custom properties for accent palette (for apps that use them)
    lines.push(`:root {`)
    for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
        lines.push(`  --accent-${key}: ${color};`)
    }
    lines.push(`  --accent-color: ${accent};`)
    lines.push(`  --accent-bg-color: ${accent};`)
    lines.push(`  --accent-fg-color: #ffffff;`)
    lines.push(`}`)
    lines.push(``)

    return lines.join("\n")
}

/**
 * Generate a complete GTK4 CSS file by combining token header + Sledgehammer.
 * ONE file works for BOTH dark and light modes.
 * Used for: ~/.config/gtk-4.0/gtk.css (system apps like Nautilus)
 */
export function generateGtkCss(config: FluidCrystalConfig, baseThemeCssPath?: string): string {
    // We construct a Universal Glass Overlay: a minimal, non-destructive CSS payload 
    // that targets the absolute base roots of GTK applications. It strips the solid
    // base layers and replaces them with our calculated @fc_window_bg tokens.
    // The rest of the styling (buttons, fonts, metrics) is deferred gracefully to 
    // whatever GTK theme the user has currently selected in GNOME Tweaks/nwg-look!

    let importStatement = ""
    if (baseThemeCssPath) {
        // BUG FIX: @import MUST be the first line of a GTK CSS file, otherwise our variables are ignored.
        importStatement = `@import url("file://${baseThemeCssPath}");\n\n`
    }

    let overlayTemplate = `/* ── FLUID CRYSTAL MODULAR X-RAY ENGINE ── */\n`

    // Dynamically punch through the GTK layers based on the user's switches
    for (const [key, enabled] of Object.entries(config.glassTargets)) {
        if (enabled) {
            overlayTemplate += GLASS_TEMPLATES[key as keyof GlassTargets] + "\n"
        }
    }

    // Unconditionally append the brute-force accent color override
    overlayTemplate += "\n" + FORCE_ACCENT_CSS + "\n"

    // Generate output with the mathematically correct CSS cascade priority:
    // 1. @import Base Theme
    // 2. Token Definitions
    // 3. Fluid Crystal X-Ray Templates
    return importStatement + generateTokenHeader(config) + "\n" + overlayTemplate
}

/**
 * Generate ONLY the token definitions CSS (no MacTahoe template body).
 * Used for: AGS CssProvider (our dock, panel, settings — styled by our SCSS, not MacTahoe)
 */
export function generateTokensCss(config: FluidCrystalConfig): string {
    return generateTokenHeader(config)
}

/**
 * Write generated CSS to the Fluid Crystal output directory.
 * ONE file for both modes — Libadwaita handles dark/light switching.
 */
export function writeGeneratedTheme(config: FluidCrystalConfig, baseThemeCssPath?: string): void {
    const css = generateGtkCss(config, baseThemeCssPath)
    const projectDir = GLib.getenv("DISTROIA_DIR") || `${GLib.get_home_dir()}/Dev/Distroia`
    const outDir = `${projectDir}/themes/fluid-crystal/gtk-4.0`

    // Same CSS for both — dark/light is handled by Libadwaita's color-scheme
    writeFile(`${outDir}/gtk.css`, css)
    writeFile(`${outDir}/gtk-dark.css`, css)

    console.log(`[FluidCrystal] Generated theme (accent: ${config.accent}, transparency: ${(config.transparency * 100).toFixed(0)}%) → ${outDir}`)
}

/**
 * Install Fluid Crystal as the active GTK4 theme by creating symlinks.
 * Also cleans up leftover files from external themes (MacTahoe, WhiteSur, etc.)
 */
export function installFluidCrystalSymlinks(): void {
    const projectDir = GLib.getenv("DISTROIA_DIR") || `${GLib.get_home_dir()}/Dev/Distroia`
    const outDir = `${projectDir}/themes/fluid-crystal/gtk-4.0`
    const gtkDir = `${GLib.get_home_dir()}/.config/gtk-4.0`

    // Clean up leftover files from external themes (MacTahoe leaves these)
    const leftovers = ["gtk-Dark.css", "gtk-Light.css"]
    for (const name of leftovers) {
        try {
            const file = Gio.File.new_for_path(`${gtkDir}/${name}`)
            if (file.query_exists(null)) {
                file.delete(null)
                console.log(`[FluidCrystal] Cleaned up leftover: ${name}`)
            }
        } catch (e) { }
    }

    // Note: windows-assets/ is bundled in our theme dir, no cleanup needed

    // Remove existing symlinks/files for our targets
    const targets = ["gtk.css", "gtk-dark.css"]
    for (const name of targets) {
        const path = `${gtkDir}/${name}`
        try {
            const file = Gio.File.new_for_path(path)
            if (file.query_exists(null)) {
                file.delete(null)
            }
        } catch (e) {
            console.warn(`[FluidCrystal] Could not remove ${path}: ${e}`)
        }
    }

    // Create CSS symlinks
    for (const name of targets) {
        try {
            const link = Gio.File.new_for_path(`${gtkDir}/${name}`)
            link.make_symbolic_link(`${outDir}/${name}`, null)
        } catch (e) {
            console.warn(`[FluidCrystal] Could not create symlink for ${name}: ${e}`)
        }
    }

    // Create symlinks for asset directories in ~/.config/gtk-4.0/
    // GTK resolves url() paths relative to the SYMLINK location, not the target
    const assetDirs = ["assets", "windows-assets"]
    for (const dirName of assetDirs) {
        const linkPath = `${gtkDir}/${dirName}`
        const targetPath = `${outDir}/${dirName}`
        try {
            const link = Gio.File.new_for_path(linkPath)
            if (link.query_exists(null)) {
                const info = link.query_info("standard::is-symlink", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
                if (info.get_is_symlink()) {
                    // Replace existing symlink
                    link.delete(null)
                    link.make_symbolic_link(targetPath, null)
                }
                // If it's a real directory, leave it as-is
            } else {
                link.make_symbolic_link(targetPath, null)
            }
        } catch (e) {
            console.warn(`[FluidCrystal] Could not handle ${dirName} symlink: ${e}`)
        }
    }

    console.log(`[FluidCrystal] Installed symlinks → ${gtkDir}`)
}

// ── CONFIG PERSISTENCE ───────────────────────────────────────────────

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
    } catch (e) {
        // First run or corrupted — use defaults
    }
    return { ...DEFAULT_CONFIG }
}
