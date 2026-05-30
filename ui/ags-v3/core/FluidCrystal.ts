/**
 * Crystal Token Engine
 * Generates CSS custom properties and @define-color tokens for Crystal Shell's own UI.
 * These tokens are scoped to the AGS/GJS process — external GTK apps are not affected.
 */

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"

// -- COLOR PALETTES ---------------------------------------------------

// Color palettes removed to let Adwaita handle them natively (V3006)

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

export interface FluidCrystalConfig {
  accent: AccentKey
  transparency: number   // Settings window opacity — range [0.10, 0.90]
  shellOpacity: number   // Bar + CC + NC opacity   — range [0.06, 0.75]
  dockOpacity: number    // Dock opacity            — range [0.05, 0.60]
  tintStrength: number
  tintPanels: TintPanels
  qtTheme: string
}

export const DEFAULT_CONFIG: FluidCrystalConfig = {
  accent: "blue",
  transparency: 0.75,
  shellOpacity: 0.20,
  dockOpacity: 0.20,
  tintStrength: 0.0,
  tintPanels: {
    controlCenter: false,
    appGrid: false,
  },
  qtTheme: "Default"
}

// ── CSS TEMPLATES ────────────────────────────────────────────────────
// Glass effects are applied via scoped SCSS per component (e.g. _settings.scss).
// We do NOT use generic GTK selectors to avoid leaking into external apps.

const PANEL_SELECTORS: Record<keyof TintPanels, string[]> = {
  controlCenter: [".cc-panel-structure"],
  appGrid: [".app-grid-content"],
}

// ── LOGIC ────────────────────────────────────────────────────────────

function generateTokenHeader(config: FluidCrystalConfig, isDark: boolean): string {
  const accent = ACCENT_PALETTE[config.accent].color
  const t = config.transparency
  const baseAlpha = (1.0 - t).toFixed(2)
  // Light mode floor: dark text needs at least 0.40 white opacity to pass WCAG AAA
  // even on a pure black wallpaper (worst case), including inner surface-raised overlays.
  const bgAlpha = (!isDark && parseFloat(baseAlpha) < 0.40) ? "0.40" : baseAlpha

  const baseBg = isDark ? "#242424" : "#fafafa"
  const popoverBg = isDark ? "#303030" : "#ffffff"
  // Popovers need alpha ≥ 0.32 so Hyprland's popups_ignorealpha=0.30 applies blur.
  const popoverAlpha = Math.max(parseFloat(bgAlpha), 0.38).toFixed(2)
  const popoverBorder = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)"

  const lines = [
    `/* Crystal Shell Token Engine */`,
    `@define-color accent_bg_color ${accent};`,
    `@define-color accent_fg_color #ffffff;`,
    `@define-color accent_color ${accent};`,
    `@define-color fc_window_bg alpha(${baseBg}, ${bgAlpha});`,
    `@define-color fc_window_bg_backdrop alpha(${baseBg}, ${bgAlpha});`,
    `@define-color fc_popover_bg alpha(${popoverBg}, ${popoverAlpha});`,
    `@define-color fc_popover_border ${popoverBorder};`,
    `@define-color sidebar_bg_color transparent;`,
    `@define-color sidebar_backdrop_color transparent;`,
    `* {`,
    `  --fc-transparency: ${t.toFixed(2)};`,
    `  --fc-accent: ${accent};`,
  ]

  for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
    lines.push(`  --accent-${key}: ${color};`)
  }
  lines.push(`  --accent-color: ${accent};`)
  lines.push(`  --accent-bg-color: ${accent};`)
  lines.push(`  --accent-fg-color: #ffffff;`)

  const whiteOrBlack = isDark ? "#ffffff" : "#000000"
  const r = parseInt(accent.slice(1, 3), 16)
  const g = parseInt(accent.slice(3, 5), 16)
  const b = parseInt(accent.slice(5, 7), 16)
  const fg = isDark ? "255, 255, 255" : "0, 0, 0"
  const bg = isDark ? "36, 36, 36" : "250, 250, 250"
  const pbR = parseInt(popoverBg.slice(1, 3), 16)
  const pbG = parseInt(popoverBg.slice(3, 5), 16)
  const pbB = parseInt(popoverBg.slice(5, 7), 16)

  // Dock item hover/plate tokens — scaled by dockOpacity
  const d = config.dockOpacity
  const dBase   = (d * 0.50).toFixed(3)
  const dRaised = d.toFixed(3)

  // Material vibrancy ladder — relative to the user's transparency choice so
  // it respects the opacity sliders AND the light-mode WCAG floor (bgAlpha).
  // lower z → thicker; higher z → thinner. Clamped to keep blur visible / text legible.
  const ba = parseFloat(bgAlpha)
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  const matThin    = clamp(ba * 0.60, 0.16, 0.45).toFixed(3)
  const matRegular = clamp(ba,        0.20, 0.60).toFixed(3)
  const matThick   = clamp(ba * 1.35, 0.40, 0.92).toFixed(3)
  const matChrome  = clamp(ba * 1.70, 0.55, 0.96).toFixed(3)

  // Shadows: "whisper" range, heavier in dark (less ambient contrast).
  const sh = isDark
    ? {
        sm: "0 1px 2px rgba(0,0,0,0.20), 0 1px 1px rgba(0,0,0,0.16)",
        md: "0 2px 8px rgba(0,0,0,0.28), 0 1px 2px rgba(0,0,0,0.18)",
        lg: "0 8px 24px rgba(0,0,0,0.40), 0 2px 6px rgba(0,0,0,0.24)",
        popover: "0 10px 32px rgba(0,0,0,0.50), 0 2px 8px rgba(0,0,0,0.30)",
      }
    : {
        sm: "0 1px 2px rgba(0,0,0,0.06), 0 1px 1px rgba(0,0,0,0.04)",
        md: "0 2px 8px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)",
        lg: "0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)",
        popover: "0 10px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)",
      }
  // Rim-of-light edge: faint white top hairline on glass.
  const edge = isDark ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(255,255,255,0.50)"

  lines.push(
    `  --crystal-accent: ${accent};`,
    `  --crystal-accent-rgb: ${r}, ${g}, ${b};`,
    `  --crystal-accent-fg: #ffffff;`,
    `  --crystal-accent-60: rgba(${r}, ${g}, ${b}, 0.6);`,
    `  --crystal-accent-30: rgba(${r}, ${g}, ${b}, 0.3);`,
    `  --crystal-accent-10: rgba(${r}, ${g}, ${b}, 0.1);`,
    `  --crystal-accent-08: rgba(${r}, ${g}, ${b}, 0.08);`,
    `  --crystal-bg: rgba(${bg}, ${bgAlpha});`,
    `  --crystal-bg-backdrop: rgba(${bg}, ${bgAlpha});`,
    `  --crystal-surface-back: rgba(${fg}, 0.04);`,
    `  --crystal-surface: rgba(${fg}, 0.08);`,
    `  --crystal-surface-hover: rgba(${fg}, 0.12);`,
    `  --crystal-surface-active: rgba(${fg}, 0.16);`,
    `  --crystal-surface-raised: rgba(${fg}, 0.20);`,
    `  --crystal-dock-surface: rgba(${fg}, ${dBase});`,
    `  --crystal-dock-surface-raised: rgba(${fg}, ${dRaised});`,
    `  --crystal-text: ${whiteOrBlack};`,
    `  --crystal-text-dim: rgba(${fg}, 0.6);`,
    `  --crystal-text-disabled: rgba(${fg}, 0.3);`,
    `  --crystal-danger: #ff3b30;`,
    `  --crystal-danger-rgb: 255, 59, 48;`,
    `  --crystal-success: #30d158;`,
    `  --crystal-warning: #f3ba4b;`,
    `  --crystal-warning-rgb: 243, 186, 75;`,
    `  --crystal-popover-bg: rgba(${pbR}, ${pbG}, ${pbB}, ${popoverAlpha});`,
    `  --crystal-popover-border: ${popoverBorder};`,
    `  --crystal-material-thin: rgba(${bg}, ${matThin});`,
    `  --crystal-material-regular: rgba(${bg}, ${matRegular});`,
    `  --crystal-material-thick: rgba(${bg}, ${matThick});`,
    `  --crystal-material-chrome: rgba(${bg}, ${matChrome});`,
    `  --crystal-edge: ${edge};`,
    `  --crystal-shadow-sm: ${sh.sm};`,
    `  --crystal-shadow-md: ${sh.md};`,
    `  --crystal-shadow-lg: ${sh.lg};`,
    `  --crystal-shadow-popover: ${sh.popover};`,
    `}`,
    isDark ? `` : `.cs-icon { -gtk-icon-filter: none; }`,
  )
  return lines.join("\n")
}

export function generateTokensCss(config: FluidCrystalConfig, isDark: boolean): string {
  return generateTokenHeader(config, isDark)
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

// generateQtColors removed to simplify and avoid legibility issues.
// We now rely on Kvantum's native theme variants (KvGnome/KvGnomeDark).

/**
 * Helper to update INI-style config files (section [Appearance], etc)
 */
function updateIniValue(content: string, section: string, key: string, value: string): string {
  const sectionHeader = `[${section}]`
  const percentSectionHeader = `[%${section}]`
  
  if (!content.includes(sectionHeader) && !content.includes(percentSectionHeader)) {
    return `${content}\n${sectionHeader}\n${key}=${value}\n`
  }
  
  const lines = content.split("\n")
  let currentSection = ""
  let found = false
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line
    }
    
    if ((currentSection === sectionHeader || currentSection === percentSectionHeader) && line.startsWith(`${key}=`)) {
      lines[i] = `${key}=${value}`
      found = true
      // Continue searching to remove duplicates if they exist
    }
  }
  
  if (!found) {
    // Insert after the first matching section header found
    const index = lines.findIndex(l => {
        const trimmed = l.trim()
        return trimmed === sectionHeader || trimmed === percentSectionHeader
    })
    if (index !== -1) {
        lines.splice(index + 1, 0, `${key}=${value}`)
    } else {
        lines.push(sectionHeader, `${key}=${value}`)
    }
  }
  
  return lines.join("\n")
}

/**
 * Basic INI reader
 */
function readIniValue(content: string, section: string, key: string): string {
    const sectionHeader = `[${section}]`
    const percentHeader = `[%${section}]`
    const lines = content.split("\n")
    let inSection = false
    
    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === sectionHeader || trimmed === percentHeader) {
            inSection = true
            continue
        }
        if (inSection && trimmed.startsWith("[") && trimmed.endsWith("]")) {
            inSection = false
        }
        
        if (inSection && trimmed.startsWith(`${key}=`)) {
            return trimmed.split("=")[1].trim()
        }
    }
    return ""
}

/**
 * Get the current Kvantum theme from system config
 */
export function getSystemQtTheme(): string {
    try {
        const home = GLib.get_home_dir()
        const path = `${home}/.config/Kvantum/kvantum.kvconfig`
        const content = readFile(path)
        if (!content) return ""
        return readIniValue(content, "General", "theme")
    } catch (e) {
        return ""
    }
}

/**
 * Find the actual .kvconfig file for a theme name
 */
function findThemeConfig(themeName: string): string | null {
    if (!themeName || themeName === "Default") return null
    
    const paths = [`${GLib.get_home_dir()}/.config/Kvantum`, "/usr/share/Kvantum"]
    const filename = `${themeName}.kvconfig`

    for (const p of paths) {
        if (!GLib.file_test(p, GLib.FileTest.EXISTS)) continue
        
        try {
            const dir = Gio.File.new_for_path(p)
            const enumerator = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
            let info
            while ((info = enumerator.next_file(null))) {
                const name = info.get_name()
                if (name.endsWith("#")) continue
                
                const fullPath = `${p}/${name}`
                
                // Case 1: The theme is a direct .kvconfig file in the root Kvantum folder
                if (name === filename) return fullPath
                
                // Case 2: The theme is inside a subdirectory
                if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                    const themeDir = Gio.File.new_for_path(fullPath)
                    try {
                        const subEnum = themeDir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
                        let subInfo
                        while ((subInfo = subEnum.next_file(null))) {
                            if (subInfo.get_name() === filename) {
                                return `${fullPath}/${filename}`
                            }
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }
    return null
}

/**
 * Update qt5ct and Kvantum settings to use the Fluid Crystal scheme
 */
export function writeQtSettings(config: FluidCrystalConfig, iconTheme?: string): void {
  try {
    const home = GLib.get_home_dir()
    const target = config.qtTheme.replace(/#/g, "")
    const opacity = Math.round(config.transparency * 100) 
    
    // 1. Update Kvantum Global Config 
    const kvConfigPath = `${home}/.config/Kvantum/kvantum.kvconfig`
    let kvContent = "[General]\n"
    try { kvContent = readFile(kvConfigPath) || "[General]\n" } catch (ex) {}
    
    kvContent = updateIniValue(kvContent, "General", "theme", target)
    kvContent = updateIniValue(kvContent, "General", "reduce_window_opacity", opacity.toString())
    kvContent = updateIniValue(kvContent, "General", "reduce_menu_opacity", opacity.toString())
    kvContent = updateIniValue(kvContent, "General", "translucent_windows", "true")
    kvContent = updateIniValue(kvContent, "Hacks", "respect_darkness", "false")
    try {
      const existing = readFile(kvConfigPath)
      if (existing === kvContent) {
          // Already in sync
      } else {
        writeFile(kvConfigPath, kvContent)
      }
    } catch (e) {
      writeFile(kvConfigPath, kvContent)
    }

    // Deep transparency sync (handles theme-level overrides)
    const activeConfigPath = findThemeConfig(target)
    if (activeConfigPath && activeConfigPath.includes(home)) {
        // Only update if it's a user theme (writable)
        let themeContent = readFile(activeConfigPath)
        if (themeContent) {
            // Force the theme's own opacity fields to match our slider
            themeContent = updateIniValue(themeContent, "General", "reduce_window_opacity", opacity.toString())
            themeContent = updateIniValue(themeContent, "General", "reduce_menu_opacity", opacity.toString())
            themeContent = updateIniValue(themeContent, "General", "translucent_windows", "true")
            
            try {
              const existing = readFile(activeConfigPath)
              if (existing !== themeContent) {
                writeFile(activeConfigPath, themeContent)
                console.log(`[FluidCrystal] Deep Qt Sync: ${activeConfigPath} updated.`)
              }
            } catch (e) {
              writeFile(activeConfigPath, themeContent)
            }
        }
    }

    // Sync icon theme to Qt (qt5ct/qt6ct) and kdeglobals
    if (iconTheme) {
      const ctConfigs = [`${home}/.config/qt6ct/qt6ct.conf`, `${home}/.config/qt5ct/qt5ct.conf`]
      for (const path of ctConfigs) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
          let content = readFile(path)
          content = updateIniValue(content, "Appearance", "icon_theme", iconTheme)
          try {
            const existing = readFile(path)
            if (existing !== content) writeFile(path, content)
          } catch (e) {
            writeFile(path, content)
          }
        }
      }

      // KDE Globals (Dolphin icons love this file)
      const kdeGlobalsPath = `${home}/.config/kdeglobals`
      let kdeContent = "[Icons]\n"
      try { kdeContent = readFile(kdeGlobalsPath) || "[Icons]\n" } catch (ex) {}
      kdeContent = updateIniValue(kdeContent, "Icons", "Theme", iconTheme)
      try {
        const existing = readFile(kdeGlobalsPath)
        if (existing !== kdeContent) writeFile(kdeGlobalsPath, kdeContent)
      } catch (e) {
        writeFile(kdeGlobalsPath, kdeContent)
      }
    }

    console.log(`[FluidCrystal] Qt Sync: Theme=${target}, IconTheme=${iconTheme || "N/A"}`)
  } catch (e) {
    console.error(`[FluidCrystal] Failed to write Qt settings: ${e}`)
  }
}

