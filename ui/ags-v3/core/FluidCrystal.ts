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

// V840: AGS SAFE EXCLUSION 
// We explicitly stop GTK from painting generic window styles onto our AGS panels.
// Using a single class (.fc-ignore) is significantly more efficient than a long list of :not() selectors.
const AGS_EXCLUDE = `:not(.fc-ignore)`

const GLASS_TEMPLATES: Record<keyof GlassTargets, string> = {
  globalWindow: `
window.background:APP_OVERRIDE:not(.popup), 
window.background.csd:APP_OVERRIDE:not(.popup), 
dialog.background:APP_OVERRIDE:not(.popup) {
  background-color: @fc_window_bg;
  background-image: none;
}

window.background:backdrop:APP_OVERRIDE:not(.popup), 
window.background.csd:backdrop:APP_OVERRIDE:not(.popup), 
dialog.background:backdrop:APP_OVERRIDE:not(.popup) {
  background-color: @fc_window_bg_backdrop;
}
`,
  headerbars: `
window.background:APP_OVERRIDE headerbar, 
window.background:APP_OVERRIDE .titlebar {
  background-color: transparent;
}`,
  sidebars: `
window.background:APP_OVERRIDE .navigation-sidebar, 
window.background:APP_OVERRIDE .sidebar, 
window.background:APP_OVERRIDE placessidebar,
window.background:APP_OVERRIDE .sidebar-pane {
  background-color: transparent;
}

window.background:APP_OVERRIDE .navigation-sidebar:backdrop, 
window.background:APP_OVERRIDE .sidebar:backdrop, 
window.background:APP_OVERRIDE placessidebar:backdrop,
window.background:APP_OVERRIDE .sidebar-pane:backdrop {
  background-color: transparent;
}`,
  mainViews: `
window.background:APP_OVERRIDE view, window.background:APP_OVERRIDE .view, 
window.background:APP_OVERRIDE textview, window.background:APP_OVERRIDE textview > text,
window.background:APP_OVERRIDE scrolledwindow, window.background:APP_OVERRIDE viewport, 
window.background:APP_OVERRIDE list, window.background:APP_OVERRIDE grid,
window.background:APP_OVERRIDE stack, window.background:APP_OVERRIDE notebook, 
window.background:APP_OVERRIDE carousel, 
window.background:APP_OVERRIDE calendar {
  background-color: transparent;
}
`,
  separators: ``,
  cardsAndLists: `
window.background:APP_OVERRIDE card, 
window.background:APP_OVERRIDE boxed-list, 
window.background:APP_OVERRIDE list.boxed {
  background-color: transparent;
}`,
  popovers: `
popover > contents,
popover.background > contents,
.menu,
.background.popup,
tooltip > box.background {
  background-color: @fc_popover_bg;
}
`
}

const FORCE_ACCENT_CSS = `
/* ================================================================
   10. GTK GOD MODE (OMNI-TARGET SPECIFICITY ENGINE)
   Absolute domination over every single GTK3/GTK4 node known to man.
   ================================================================ */

/* --- 1. THE CHECKED STATE (Toggles, Radios, Checks, Switches, Buttons) --- */
check:checked:APP_OVERRIDE, 
radio:checked:APP_OVERRIDE, 
check:indeterminate:APP_OVERRIDE, 
radio:indeterminate:APP_OVERRIDE,
.view.check:checked:APP_OVERRIDE,
.cell.check:checked:APP_OVERRIDE,
treeview.view check:checked:APP_OVERRIDE,
columnview row check:checked:APP_OVERRIDE,
row check:checked:APP_OVERRIDE,
button:checked:APP_OVERRIDE,
button.toggle:checked:APP_OVERRIDE,
button.circular:checked:APP_OVERRIDE,
button.flat:checked:APP_OVERRIDE,
tab:checked:APP_OVERRIDE {
}

switch:checked:APP_OVERRIDE {
  background-color: @accent_bg_color;
  background-image: none;
}
switch:checked:hover:APP_OVERRIDE {
  background-color: mix(@accent_bg_color, white, 0.1);
}
switch:checked:active:APP_OVERRIDE {
  background-color: mix(@accent_bg_color, black, 0.1);
}
switch:checked > slider:APP_OVERRIDE {
  background-color: white;
}

/* --- 2. THE SELECTED STATE (Rows, Grids, Trees, Flowboxes, Text, Menus) --- */
selection:APP_OVERRIDE,
.selected:APP_OVERRIDE,
row:selected:APP_OVERRIDE,
tab:selected:APP_OVERRIDE,
flowboxchild:selected:APP_OVERRIDE,
child:selected:APP_OVERRIDE,
menuitem:hover:APP_OVERRIDE,
.menu menuitem:hover:APP_OVERRIDE,
popover menuitem:hover:APP_OVERRIDE,
popover .menuitem:hover:APP_OVERRIDE,
popover .emoji-picker emoji:hover:APP_OVERRIDE,
popover .emoji-picker emoji:focus:APP_OVERRIDE,
treeview.view:selected:APP_OVERRIDE,
columnview.view:selected:APP_OVERRIDE,
iconview:selected:APP_OVERRIDE,
calendar > grid > label.day-number:selected:APP_OVERRIDE,
label:selected:APP_OVERRIDE,
entry > selection:APP_OVERRIDE,
textview > selection:APP_OVERRIDE,
spinbutton > selection:APP_OVERRIDE,
modelbutton.flat:selected:APP_OVERRIDE {
  background-color: @accent_bg_color;
  background-image: none;
  color: @accent_fg_color;
}

/* --- 3. THE SUGGESTED & ACTIVE STATE (Primary Buttons, Highlights) --- */
.suggested-action:APP_OVERRIDE,
.accent:APP_OVERRIDE,
button.suggested-action:APP_OVERRIDE,
button.text-button.suggested-action:APP_OVERRIDE,
button.image-button.suggested-action:APP_OVERRIDE,
infobar.info > revealer > box button:APP_OVERRIDE,
infobar.question > revealer > box button:APP_OVERRIDE,
modelbutton.flat:active:APP_OVERRIDE {
  background-color: @accent_bg_color;
  background-image: none;
  color: @accent_fg_color;
}

/* --- HOVER STATES FOR SELECTIONS & ACTIONS --- */
.suggested-action:hover:APP_OVERRIDE,
.accent:hover:APP_OVERRIDE,
selection:hover:APP_OVERRIDE,
.selected:hover:APP_OVERRIDE,
row:selected:hover:APP_OVERRIDE,
tab:selected:hover:APP_OVERRIDE,
tab:checked:hover:APP_OVERRIDE,
button.suggested-action:hover:APP_OVERRIDE,
button.toggle:checked:hover:APP_OVERRIDE,
button:checked:hover:APP_OVERRIDE,
infobar.info > revealer > box button:hover:APP_OVERRIDE {
  background-color: mix(@accent_bg_color, white, 0.1);
}

/* --- ACTIVE STATES FOR SELECTIONS & ACTIONS --- */
.suggested-action:active:APP_OVERRIDE,
.accent:active:APP_OVERRIDE,
selection:active:APP_OVERRIDE,
.selected:active:APP_OVERRIDE,
row:selected:active:APP_OVERRIDE,
tab:selected:active:APP_OVERRIDE,
tab:checked:active:APP_OVERRIDE,
button.suggested-action:active:APP_OVERRIDE,
button.suggested-action:checked:APP_OVERRIDE,
button.toggle:checked:active:APP_OVERRIDE,
button:checked:active:APP_OVERRIDE,
infobar.info > revealer > box button:active:APP_OVERRIDE {
  background-color: mix(@accent_bg_color, black, 0.1);
}

/* --- 4. GAUGES, SCALES & LEVELS (Sliders, Volume, Brightness, Meters) --- */
scale highlight:APP_OVERRIDE,
scale fill:APP_OVERRIDE,
scale.vertical highlight:APP_OVERRIDE,
progressbar > trough > progress:APP_OVERRIDE,
levelbar > trough > block.filled:APP_OVERRIDE,
levelbar > trough > block.high:APP_OVERRIDE,
levelbar > trough > block.low:APP_OVERRIDE,
levelbar block.filled:APP_OVERRIDE,
levelbar block.high:APP_OVERRIDE,
levelbar block.low:APP_OVERRIDE {
  background-color: @accent_bg_color;
  background-image: none;
}

/* --- 5. THE FOCUS RINGS (Entries, Textboxes, Spinners, Search) --- */
entry:focus-within:APP_OVERRIDE,
entry:focus:APP_OVERRIDE,
entry:drop(active):APP_OVERRIDE,
textview:focus-within:APP_OVERRIDE,
textview:focus:APP_OVERRIDE,
spinbutton:focus-within:APP_OVERRIDE,
spinbutton:focus:APP_OVERRIDE,
searchbar entry:focus-within:APP_OVERRIDE,
.linked entry:focus-within:APP_OVERRIDE,
combobox entry:focus-within:APP_OVERRIDE {
  outline: none;
}

/* --- 6. TYPOGRAPHY & FOREGROUNDS (Links, Symbols, Colored Text) --- */
link:APP_OVERRIDE,
button.link:APP_OVERRIDE,
link:visited:APP_OVERRIDE,
button.link:visited:APP_OVERRIDE,
.symbolic.accent:APP_OVERRIDE,
image.accent:APP_OVERRIDE,
label.accent:APP_OVERRIDE,
entry.error:focus-within:APP_OVERRIDE,
entry.warning:focus-within:APP_OVERRIDE {
  color: @accent_bg_color;
}

link:hover:APP_OVERRIDE,
button.link:hover:APP_OVERRIDE,
link:active:APP_OVERRIDE,
button.link:active:APP_OVERRIDE {
  color: mix(@accent_bg_color, white, 0.1);
}

/* ================================================================
   11. BACKDROP & INACTIVE FALLBACKS
   When windows lose focus, the accent elegantly fades to glass.
   ================================================================ */

.suggested-action:backdrop:APP_OVERRIDE,
.accent:backdrop:APP_OVERRIDE,
selection:backdrop:APP_OVERRIDE,
.selected:backdrop:APP_OVERRIDE,
row:selected:backdrop:APP_OVERRIDE,
tab:selected:backdrop:APP_OVERRIDE,
button.toggle:checked:backdrop:APP_OVERRIDE,
button:checked:backdrop:APP_OVERRIDE,
menuitem:hover:backdrop:APP_OVERRIDE {
  background-color: alpha(@accent_bg_color, 0.3);
  color: alpha(@accent_fg_color, 0.7);
}

check:checked:backdrop:APP_OVERRIDE,
radio:checked:backdrop:APP_OVERRIDE,
check:indeterminate:backdrop:APP_OVERRIDE,
radio:indeterminate:backdrop:APP_OVERRIDE,
switch:checked:backdrop:APP_OVERRIDE {
  background-color: alpha(@accent_bg_color, 0.3);
  color: alpha(@accent_fg_color, 0.5);
}

scale highlight:backdrop:APP_OVERRIDE,
scale fill:backdrop:APP_OVERRIDE,
progressbar > trough > progress:backdrop:APP_OVERRIDE,
levelbar block.filled:backdrop:APP_OVERRIDE,
levelbar block.high:backdrop:APP_OVERRIDE {
  background-color: alpha(@accent_bg_color, 0.4);
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
  const backdropAlpha = baseAlpha
  const popoverAlpha = baseAlpha // Match window transparency as requested

  // Libadwaita Base Colors
  const baseBg = config.isDark ? "#242424" : "#fafafa"
  const viewBg = config.isDark ? "#1e1e1e" : "#ffffff"
  const headerBg = config.isDark ? "#303030" : "#ebebeb"
  const popoverBg = config.isDark ? "#303030" : "#ffffff"
  const sidebarBg = config.isDark ? "#242424" : "#f6f5f4"

  const lines = [
    `/* Fluid Crystal Generated Tokens (V2650) */`,
    ADWAITA_PALETTE,
    `@define-color accent_bg_color ${accent};`,
    `@define-color accent_fg_color #ffffff;`,
    `@define-color accent_color ${accent};`,
    `@define-color fc_window_bg alpha(${baseBg}, ${baseAlpha});`,
    `@define-color fc_window_bg_backdrop alpha(${baseBg}, ${backdropAlpha});`,
    `@define-color fc_popover_bg alpha(${popoverBg}, ${popoverAlpha});`,
    `@define-color destructive_bg_color #ED5F5D;`,
    `@define-color success_bg_color #79B757;`,
  ]

  if (config.enabled) {
    lines.push(
      `/* THEME TRANSPARENCY DEFINITIONS (ENGINE ACTIVE) */`,
      `@define-color card_bg_color transparent;`,
      `@define-color window_bg_color @fc_window_bg;`,
      `@define-color view_bg_color transparent;`,
      `@define-color headerbar_bg_color transparent;`,
      `@define-color popover_bg_color @fc_popover_bg;`,
      `@define-color sidebar_bg_color transparent;`
    )
  } else {
    lines.push(
      `/* THEME TRANSPARENCY DEFINITIONS (ENGINE INACTIVE) */`,
      `/* We STOP overriding internal GTK colors to allow native theme inheritance. */`
    )
  }

  lines.push(
    `:root {`,
    `  --fc-transparency: ${t};`,
    `  --fc-accent: ${accent};`,
  )
  for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
    lines.push(`  --accent-${key}: ${color};`)
  }
  lines.push(`  --accent-color: ${accent};`)
  lines.push(`  --accent-bg-color: ${accent};`)
  lines.push(`  --accent-fg-color: #ffffff;`)
  lines.push(`}`)
  return lines.join("\n")
}

export function generateTokensCss(config: FluidCrystalConfig): string {
  return generateTokenHeader(config)
}

export function generateMasterCss(config: FluidCrystalConfig, baseThemeCssPath?: string): string {
  let css = `
/* =====================================================================
 * FLUID CRYSTAL MASTER (V2650: The Crystal Hybrid)
 * Structural blueprint + Base Theme Integration.
 * ===================================================================== */
`
  if (baseThemeCssPath) {
    css += `@import url("file://${baseThemeCssPath}");\n`
  }

  css += `@import url("_tokens.css");\n\n`

  css += `/* Overlay Structural Logic */\n`
  const activeTargets = Object.entries(config.glassTargets)
    .filter(([_, enabled]) => enabled)
    .map(([key, _]) => GLASS_TEMPLATES[key as keyof GlassTargets])

  const combinedGlass = activeTargets.join("\n\n").split(":APP_OVERRIDE").join(AGS_EXCLUDE)
  css += combinedGlass

  css += `\n\n` + FORCE_ACCENT_CSS.split(":APP_OVERRIDE").join(AGS_EXCLUDE)

  return css
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

/**
 * High-Speed Token Sync (No GSettings flickers)
 */
export function writeTokens(config: FluidCrystalConfig): void {
  const configDir = `${GLib.get_user_config_dir()}/gtk-4.0`
  const tokens = generateTokensCss(config)
  writeFile(`${configDir}/_tokens.css`, tokens)
}

/**
 * Full Theme Writing (Only on theme change or glass target toggle)
 */
export function writeGeneratedTheme(config: FluidCrystalConfig, baseThemeCssPath?: string): void {
  const configDir = `${GLib.get_user_config_dir()}/gtk-4.0`

  // 1. Write the dynamic tokens
  writeTokens(config)

  // 2. Write the structural master
  const master = generateMasterCss(config, baseThemeCssPath)
  writeFile(`${configDir}/gtk.css`, master)
  writeFile(`${configDir}/gtk-dark.css`, master)
}

export function installFluidCrystalSymlinks(): void {
  const projectDir = GLib.getenv("DISTROIA_DIR") || `${GLib.get_home_dir()}/Dev/Distroia`
  const themeAssetsDir = `${projectDir}/ui/ags-v3/assets/fluid-crystal`
  const configDir = `${GLib.get_user_config_dir()}/gtk-4.0`

  const targets = ["assets", "windows-assets"]

  for (const name of targets) {
    try {
      const source = `${themeAssetsDir}/${name}`
      const link = `${configDir}/${name}`
      const file = Gio.File.new_for_path(link)

      if (file.query_exists(null)) {
        file.delete(null)
      }

      const sourceFile = Gio.File.new_for_path(source)
      if (sourceFile.query_exists(null)) {
        file.make_symbolic_link(source, null)
      }
    } catch (e) {
      console.warn(`[FluidCrystal] Could not link ${name}: ${e}`)
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
