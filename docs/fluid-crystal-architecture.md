# Fluid Crystal — Theme System Architecture

> Unified theming for Distroia: GTK4 apps, Libadwaita, and AGS shell components.

## Overview

```text
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
| `core/FluidCrystal.ts` | Token engine: generates CSS from config, manages palette and glass calculations |
| `core/ThemeManager.ts` | Orchestrator: GSettings, symlinks, CssProviders, config I/O |
| `styles/_tokens.scss` | SCSS fallbacks (build-time); runtime overridden by CssProvider |
| `themes/fluid-crystal/` | Generated GTK4 CSS output + structural GTK bindings (`template-*.css`) |
| `~/.config/distroia/fluid-crystal.json` | Persisted user config |

---

## 💎 The Glassmorphism Architecture (Absolute Root Targeting)

The hardest technical challenge in GTK4/Libadwaita theming is achieving a globally controlled, single-layer frosted glass effect without causing CSS compiler infinite loops, 100% invisible windows, or ugly "double-tinting" (where nested panels multiply the darkness). 

Fluid Crystal resolves this using **Absolute Root Node Targeting**, bypassing GTK CSS variables entirely for the transparency layer.

### 1. The Direct Window Injection

Instead of overriding `@window_bg_color` (which causes circular references and crashes native apps), Fluid Crystal injects the slider-controlled transparency variable (`@fc_window_bg`) directly into the physical root nodes of GTK applications:

```css
window.background:not(.popup):not(#Z):not(#Y):not(#X),
window.background.csd:not(.popup):not(#Z):not(#Y):not(#X),
dialog.background:not(.popup):not(#Z):not(#Y):not(#X) {
  background-color: @fc_window_bg;
  background-image: none;
}
```

This guarantees that **exactly one** sheet of slider-controlled glass is spawned at the absolute bottom of every native GTK4 application. 

### 2. The Opaque Layer Penetration Sledgehammer

Native GTK apps are built like onions. If we make the root transparent, the internal `GtkBox`, `AdwView`, or `GtkScrolledWindow` will just draw their own solid gray squares, burying our glass. 

We solve this using a monolithic `:not()` specificity injection that mathematically out-ranks all deep Libadwaita bindings, violently stripping all structural internal panels to `transparent`:

```css
/* Strips internal component layering so purely the base window provides the single unified glass tint */
.view:not(#Z):not(#Y):not(#X),
.content-pane:not(#Z):not(#Y):not(#X),
.sidebar-pane:not(#Z):not(#Y):not(#X),
scrolledwindow:not(#Z):not(#Y):not(#X),
mathwindow:not(#Z):not(#Y):not(#X),
carousel:not(#Z):not(#Y):not(#X) {
  background-color: transparent;
  background-image: none;
}
```
*Result: Nautilus, Calculator, and Loupe achieve flawless edge-to-edge glass without double-tinted sidebars or opaque content views.*

### 3. AGS Overlay Isolation vs. Opt-In

AGS creates many invisible utility windows (like the Dock, Top Bar, and OSDs). If we targeted `window:not(.popup)`, these utilities would suddenly get a glass background, drawing giant tinted rectangles on the screen edges.

**The Isolation:** By strictly targeting `window.background`, raw AGS `Gtk.Window` instances remain 100% invisible because they do not have the `.background` class natively.

**The Opt-In (Unified AGS Glass):** For our visible desktop applications (Settings UI, Control Center), we manually opt them into the glass architecture by adding the `"background"` CSS class in TypeScript:
```typescript
const win = new Gtk.Window({
    name: "crystal-control-center",
    css_classes: ["control-center-win", "background"], // Explicitly requests the GTK4 glass layer
})
```

### 4. Popover Defenses

Context menus (`popover`) must remain totally solid to maintain UX readability. They are shielded defensively:
```css
popover.background>contents:not(#Z):not(#Y):not(#X) {
  background-color: @popover_bg_color;
  background-image: none;
}
```

---

## How Other Features Work

### Dark / Light Mode

**Managed by Libadwaita**, not by us.

```text
ThemeManager.setDarkMode(true)
  → GSettings: color-scheme = "prefer-dark"
  → Libadwaita handles all surface colors (window_bg, view_bg, etc.)
  → Apps react in real-time (Nautilus, Loupe, Chrome)
```

We do **NOT** modify GTK base variables for lightness/darkness, we only modify them to be `transparent` where necessary to let the base node shine through.

### Accent Color (The `ACCENT_PALETTE`)

**9 colors** defined (blue, teal, green, yellow, orange, red, pink, purple, slate).

Two delivery mechanisms:
1. **For external apps (restart required):** Written to `gtk.css` as `@define-color accent_bg_color #...` and heavily forced into Libadwaita components via specific CSS rules in `template-x.css`.
2. **For AGS shell (real-time):** Loaded directly via `ThemeManager.themeProvider` so SCSS buttons can bind it live. 

***CRITICAL SCSS Escape Pattern***: GTK named colors (`@name`) conflict with SCSS `@` variable directives. 
```scss
// WRONG — SCSS tries to parse as directive
color: @accent_bg_color;

// CORRECT — passes through literally to compiled CSS
color: #{"@accent_bg_color"};
```

### Theme Orchestration (GSettings & Symlinks)

When Fluid Crystal initializes:
1. Generates `gtk.css` based on current Accent Color and Transparency Slider.
2. Symlinks the theme folder to `~/.config/gtk-4.0/`.
3. Sets `gtk-theme = "FluidCrystal"` in GSettings (or "MacTahoe" if globally turning off FC).

The "Fluid Crystal" section in our Settings menu only appears while FC is physically set as the active theme.
