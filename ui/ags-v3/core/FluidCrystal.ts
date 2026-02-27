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

// ── USER-CONFIGURABLE STATE ──────────────────────────────────────────
export interface FluidCrystalConfig {
    accent: AccentKey
    isDark: boolean         // Passed to Libadwaita's color-scheme (NOT used in CSS)
    transparency: number    // 0.0 (solid) → 1.0 (full glass)
    tintStrength: number    // 0.0 → 1.0 (how much accent tints surfaces)
}

export const DEFAULT_CONFIG: FluidCrystalConfig = {
    accent: "blue",
    isDark: true,
    transparency: 0.75,
    tintStrength: 0.0,
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
        `/* ── Transparency Overrides (reference Libadwaita's dynamic colors) ── */`,
        `/* These add transparency ON TOP of whatever dark/light colors Libadwaita provides */`,
        `@define-color sidebar_bg_color alpha(@window_bg_color, ${(0.96 * t).toFixed(2)});`,
        `@define-color sidebar_backdrop_color alpha(@window_bg_color, ${(0.96 * t).toFixed(2)});`,
        `@define-color sidebar_shade_color rgba(0, 0, 0, 0.25);`,
        `@define-color sidebar_border_color alpha(@window_fg_color, 0.08);`,
        `@define-color dialog_bg_color alpha(@view_bg_color, ${(0.96 * t).toFixed(2)});`,
        `@define-color popover_bg_color alpha(@window_bg_color, ${(0.96 * t).toFixed(2)});`,
        `@define-color popover_shade_color rgba(0, 0, 0, 0.25);`,
        ``,
        `/* ── CSS Custom Properties for accent palette ── */`,
    ]

    // Add CSS custom properties for accent palette (for apps that use them)
    lines.push(`:root {`)
    for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
        lines.push(`  --accent-${key}: ${color};`)
    }
    lines.push(`  --accent-color: @accent_bg_color;`)
    lines.push(`  --accent-bg-color: @accent_bg_color;`)
    lines.push(`  --accent-fg-color: @accent_fg_color;`)
    lines.push(`}`)
    lines.push(``)

    return lines.join("\n")
}

/**
 * Generate a complete GTK4 CSS file by combining token header + template body.
 * ONE file works for BOTH dark and light modes.
 * Used for: ~/.config/gtk-4.0/gtk.css (system apps like Nautilus)
 */
export function generateGtkCss(config: FluidCrystalConfig): string {
    const projectDir = GLib.getenv("DISTROIA_DIR") || `${GLib.get_home_dir()}/Dev/Distroia`
    const themeDir = `${projectDir}/themes/fluid-crystal`

    // We use the dark template as base since it has color-mix() and @define-color references
    // that resolve dynamically against Libadwaita's colors
    const template = readFile(`${themeDir}/template-dark.css`) || ""

    return generateTokenHeader(config) + "\n" + template
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
export function writeGeneratedTheme(config: FluidCrystalConfig): void {
    const css = generateGtkCss(config)
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
