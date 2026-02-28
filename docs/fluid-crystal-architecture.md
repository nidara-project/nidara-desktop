# Fluid Crystal — Theme System Architecture

> Unified theming for Distroia: GTK4 apps, Libadwaita, and AGS shell components.

## Overview

```
┌─────────────────────────────────────────────────────┐
│                  fluid-crystal.json                  │
│         (accent, isDark, transparency, tint)         │
└──────────┬──────────────────┬───────────────────────┘
           │                  │
     ┌─────▼─────┐    ┌──────▼──────┐
     │ GTK4 CSS  │    │ AGS SCSS +  │
     │ (external │    │ CssProvider │
     │  apps)    │    │ (shell UI)  │
     └─────┬─────┘    └──────┬──────┘
           │                  │
    Nautilus, Loupe,     Bar, CC, Dock,
    Chrome, etc.         Settings, Grid
```

## Key Files

| File | Purpose |
|---|---|
| `core/FluidCrystal.ts` | Token engine: generates CSS from config, manages palette |
| `core/ThemeManager.ts` | Orchestrator: GSettings, symlinks, CssProviders, config I/O |
| `styles/_tokens.scss` | SCSS fallbacks (build-time); runtime overridden by CssProvider |
| `themes/fluid-crystal/` | Generated GTK4 CSS output + window button assets |
| `~/.config/distroia/fluid-crystal.json` | Persisted user config |

## How Each Feature Works

### 1. Dark / Light Mode

**Managed by Libadwaita**, not by us.

```
ThemeManager.setDarkMode(true)
  → GSettings: color-scheme = "prefer-dark"
  → Libadwaita handles all surface colors (window_bg, view_bg, etc.)
  → Apps react in real-time (Nautilus, Loupe, Chrome)
```

We do **NOT** override `window_bg_color` or `view_bg_color` — Libadwaita manages those dynamically. This is why dark/light mode works in real-time for external apps.

### 2. Accent Color

**9 colors** defined in `ACCENT_PALETTE` (blue, teal, green, yellow, orange, red, pink, purple, slate).

Two delivery mechanisms:

#### For external GTK4 apps (restart required):
```
FluidCrystal.ts → generateTokensCss(config)
  → @define-color accent_bg_color #0088FF;
  → Written to themes/fluid-crystal/gtk-4.0/gtk.css
  → Symlinked to ~/.config/gtk-4.0/gtk.css
```

#### For AGS shell (real-time):
```
ThemeManager.themeProvider (CssProvider, PRIORITY_USER)
  → Loads @define-color accent_bg_color ...
  → SCSS references it via #{"@accent_bg_color"} passthrough
```

**SCSS escape pattern**: GTK named colors (`@name`) conflict with SCSS `@` directives. Solution:
```scss
// WRONG — SCSS tries to parse as directive
color: @accent_bg_color;

// CORRECT — passes through literally to compiled CSS
color: #{"@accent_bg_color"};
background: #{"alpha(@accent_bg_color, 0.5)"};
```

### 3. Panel Tinting

**Dynamic CssProvider** (`ThemeManager.tintProvider`, PRIORITY_USER + 1).

Generates CSS rules that apply `rgba(accent, strength * 0.3)` as background-color on selected panels.

**Tintable panels** (CSS backgrounds):
- `.cc-panel-structure` — Control Center ✅
- `.app-grid-content` — App Grid ✅

**Not tintable** (Cairo-drawn backgrounds):
- Top Bar — Cairo pills
- Dock — Cairo background

Config:
```json
{
  "tintStrength": 0.5,
  "tintPanels": { "controlCenter": true, "appGrid": false }
}
```

### 4. Transparency

Stored in config as `transparency: 0.0–1.0`. Currently a placeholder for future integration with Hyprland blur rules and surface alpha.

### 5. GTK Theme Switching (non-FC themes)

When user selects a theme other than "FluidCrystal":
```
ThemeManager.setGtkTheme("MacTahoe")
  → GSettings: gtk-theme = "MacTahoe"
  → Removes FC symlinks from ~/.config/gtk-4.0/
  → Registers external theme's CSS via Gtk.CssProvider
```

The "Fluid Crystal" section in Settings only appears when FC is the active theme.

## CssProvider Priority Stack

```
PRIORITY_FALLBACK (1)     — GTK defaults
PRIORITY_THEME (200)      — System theme
PRIORITY_APPLICATION (600) — AGS compiled SCSS (style.css)
PRIORITY_USER (800)       — FC tokens (@define-color) ← themeProvider
PRIORITY_USER+1 (801)     — FC tint CSS ← tintProvider
PRIORITY_USER+1 (801)     — Accent circle CSS (Appearance page)
```

## Symlink Layout (when FC is active)

```
~/.config/gtk-4.0/
├── gtk.css          → ~/Dev/Distroia/themes/fluid-crystal/gtk-4.0/gtk.css
├── gtk-dark.css     → (same target)
├── assets/          → ~/Dev/Distroia/themes/fluid-crystal/gtk-4.0/assets/
└── windows-assets/  → ~/Dev/Distroia/themes/fluid-crystal/gtk-4.0/windows-assets/
```

GTK resolves `url()` paths relative to the symlink location, so `assets/` and `windows-assets/` must also be symlinked.

## Config File Format

`~/.config/distroia/fluid-crystal.json`:
```json
{
  "accent": "blue",
  "isDark": true,
  "transparency": 0.75,
  "tintStrength": 0.0,
  "tintPanels": {
    "controlCenter": false,
    "appGrid": false
  }
}
```

## Cairo vs CSS Components

| Component | Background | Accent follow? |
|---|---|---|
| CC Toggle buttons | Cairo (drawSquircle) | ✅ Reads `ACCENT_PALETTE[Theme.accentColor]` |
| CC Pill sliders | CSS (.cc-pill-slider) | ✅ Via `@accent_bg_color` in SCSS |
| CC Clear button | CSS | ✅ Via `@accent_bg_color` |
| Bar workspace dots | CSS | ✅ Via `@accent_bg_color` |
| Top bar pills | Cairo | ❌ Hardcoded (would need Cairo changes) |
| Dock background | Cairo | ❌ Hardcoded |
| Dock indicators | Cairo | ❌ Adaptive to mode, not accent |
| Settings sliders | CSS | ✅ Via `@accent_bg_color` |

## Adding a New Accent-Aware Component

1. **CSS-based**: Use `#{"@accent_bg_color"}` in SCSS, or `#{"alpha(@accent_bg_color, 0.X)"}` for transparency
2. **Cairo-based**: Read `ACCENT_PALETTE[Theme.accentColor].color`, convert hex to RGB:
   ```typescript
   const hex = ACCENT_PALETTE[Theme.accentColor].color
   const r = parseInt(hex.slice(1, 3), 16) / 255
   const g = parseInt(hex.slice(3, 5), 16) / 255
   const b = parseInt(hex.slice(5, 7), 16) / 255
   ```
