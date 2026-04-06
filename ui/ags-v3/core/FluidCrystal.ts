/**
 * Fluid Crystal Token Engine
 * Single source of truth for all theme colors.
 * 
 * Architecture:
 *  - Dark/Light mode: Managed by Libadwaita via color-scheme (real-time)
 *  - Accent, transparency, tint: Managed by Fluid Crystal via @define-color (restart for external apps)
 *  - Surface colors (window_bg, view_bg, etc.): NOT overridden - Libadwaita handles them dynamically
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
  enabled: boolean
  accent: AccentKey
  isDark: boolean
  transparency: number
  tintStrength: number
  tintPanels: TintPanels
  qtTheme: string
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

function generateTokenHeader(config: FluidCrystalConfig): string {
  const accent = ACCENT_PALETTE[config.accent].color
  const t = config.transparency
  // Base window glass logic based on user transparency setting
  const baseAlpha = (1.0 - t).toFixed(2)
  const backdropAlpha = baseAlpha
  const popoverAlpha = baseAlpha // Match window transparency as requested

  // Libadwaita Base Colors
  const baseBg = config.isDark ? "#242424" : "#fafafa"
  const viewBg = config.isDark ? "#1e1e1e" : "#ffffff"
  const headerBg = config.isDark ? "#303030" : "#ebebeb"
  const popoverBg = config.isDark ? "#303030" : "#ffffff"
  const sidebarBg = config.isDark ? "#242424" : "#f6f5f4"

  const lines = [
    `/* Fluid Crystal Generated Tokens: Process-Local Isolation */`,
    `@define-color accent_bg_color ${accent};`,
    `@define-color accent_fg_color #ffffff;`,
    `@define-color accent_color ${accent};`,
    `@define-color fc_window_bg alpha(${baseBg}, ${baseAlpha});`,
    `@define-color fc_window_bg_backdrop alpha(${baseBg}, ${backdropAlpha});`,
    `@define-color fc_popover_bg alpha(${popoverBg}, ${popoverAlpha});`,
  ]

  if (config.enabled) {
    lines.push(
      `/* ENGINE ACTIVE */`,
      // NOTE: These @define-color tokens ONLY affect the AGS GJS process.
      // GTK apps (Nautilus, terminal, etc.) run in their own process with
      // their own CSS providers — they are NOT affected by these overrides.
      `@define-color sidebar_bg_color transparent;`,
      `@define-color sidebar_backdrop_color transparent;`
    )
  } else {
    lines.push(
      `/* ENGINE INACTIVE */`
    )
  }

  lines.push(
    `* {`,
    `  --fc-transparency: ${t.toFixed(2)};`,
    `  --fc-accent: ${accent};`,
  )
  for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
    lines.push(`  --accent-${key}: ${color};`)
  }
  lines.push(`  --accent-color: ${accent};`)
  lines.push(`  --accent-bg-color: ${accent};`)
  lines.push(`  --accent-fg-color: #ffffff;`)

  // V3000: Crystal Design System Tokens
  const whiteOrBlack = config.isDark ? "#ffffff" : "#000000"
  const r = parseInt(accent.slice(1, 3), 16)
  const g = parseInt(accent.slice(3, 5), 16)
  const b = parseInt(accent.slice(5, 7), 16)
  
  lines.push(
    `  --crystal-accent: ${accent};`,
    `  --crystal-accent-rgb: ${r}, ${g}, ${b};`,
    `  --crystal-accent-fg: #ffffff;`,
    `  --crystal-accent-60: rgba(${r}, ${g}, ${b}, 0.6);`,
    `  --crystal-accent-30: rgba(${r}, ${g}, ${b}, 0.3);`,
    `  --crystal-accent-10: rgba(${r}, ${g}, ${b}, 0.1);`,
    `  --crystal-accent-08: rgba(${r}, ${g}, ${b}, 0.08);`,
    `  --crystal-bg: rgba(${config.isDark ? "36, 36, 36" : "250, 250, 250"}, ${baseAlpha});`,
    `  --crystal-bg-backdrop: rgba(${config.isDark ? "36, 36, 36" : "250, 250, 250"}, ${backdropAlpha});`,
    `  --crystal-surface-back: rgba(${config.isDark ? "255, 255, 255" : "0, 0, 0"}, 0.04);`,
    `  --crystal-surface: rgba(${config.isDark ? "255, 255, 255" : "0, 0, 0"}, 0.08);`,
    `  --crystal-surface-hover: rgba(${config.isDark ? "255, 255, 255" : "0, 0, 0"}, 0.12);`,
    `  --crystal-surface-active: rgba(${config.isDark ? "255, 255, 255" : "0, 0, 0"}, 0.16);`,
    `  --crystal-surface-raised: rgba(${config.isDark ? "255, 255, 255" : "0, 0, 0"}, 0.20);`,
    `  --crystal-text: ${whiteOrBlack};`,
    `  --crystal-text-dim: rgba(${config.isDark ? "255, 255, 255" : "0, 0, 0"}, 0.6);`,
    `  --crystal-text-disabled: rgba(${config.isDark ? "255, 255, 255" : "0, 0, 0"}, 0.3);`,
    `}`
  )
  return lines.join("\n")
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

const CONFIG_PATH = `${GLib.get_home_dir()}/.config/crystal-shell/fluid-crystal.json`

export function saveConfig(config: FluidCrystalConfig): void {
  const dir = `${GLib.get_home_dir()}/.config/crystal-shell`
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
