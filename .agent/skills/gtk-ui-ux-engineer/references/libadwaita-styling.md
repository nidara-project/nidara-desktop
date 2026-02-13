# Libadwaita Styling Guide

Comprehensive guide to CSS styling with Libadwaita for modern GTK4 applications.

## CSS Variables & Theming

### Understanding Libadwaita CSS Variables

Libadwaita provides a rich set of CSS variables that automatically adapt to system themes (light/dark/high-contrast).

**GTK4 Syntax (Required):** Use CSS custom properties (--variable), NOT GTK3 @define-color:

```css
/* GTK4: Use var() for CSS variables */
:root {
  /* Access system variables directly */
  --my-window-bg: var(--window-bg-color);
  --my-card-bg: var(--card-bg-color);
}

/* Usage */
.card {
  background-color: var(--my-card-bg);
}
```

**GTK3 Syntax (DO NOT USE):**
```css
/* GTK3: @define-color is deprecated */
@define-color window_bg_color var(--window-bg-color);

/* Usage - doesn't work in GTK4 */
.card {
  background-color: @window_bg_color;
}
```

### Custom Accent Colors

Override accent colors for brand identity:

```css
:root {
  /* Built-in accent colors */
  /* var(--accent-blue), var(--accent-teal), var(--accent-green),
     var(--accent-yellow), var(--accent-orange), var(--accent-red),
     var(--accent-pink), var(--accent-purple), var(--accent-brown) */

  --accent-bg-color: var(--accent-purple);
  --accent-color: oklab(from var(--accent-bg-color) var(--standalone-color-oklab));
}
```

**Custom Accent Color:**
```css
:root {
  /* Define custom color in OKLab color space */
  --accent-bg-color: oklab(0.55 0.1 0.25); /* Purple */
  --accent-color: oklab(from var(--accent-bg-color) var(--standalone-color-oklab));
}
```

### Theme-Aware Styling

Use media queries to adapt to different themes:

```css
/* Light mode (default) */
.card {
  background-color: rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.08);
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  .card {
    background-color: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
}

/* High contrast mode */
@media (prefers-contrast: more) {
  .card {
    background-color: transparent;
    border: 2px solid currentColor;
  }
}
```

## Widget Styling

### Button Styling

**Primary Buttons:**
```css
.primary-button {
  background-color: var(--accent-bg-color);
  color: var(--accent-fg-color);
  padding: 8px 16px;
  border-radius: 8px;
  font-weight: 600;
  transition: background-color 150ms ease;
}

.primary-button:hover {
  /* GTK4: Use color-mix instead of filter */
  background-color: color-mix(in srgb, var(--accent-bg-color) 90%, white);
}

.primary-button:active {
  /* GTK4: Use color-mix instead of filter */
  background-color: color-mix(in srgb, var(--accent-bg-color) 70%, white);
}
```

**Note:** GTK4 does NOT support CSS `filter` functions like `brightness()`. Use `color-mix()` to adjust colors.

**Icon Buttons:**
```css
.icon-button {
  padding: 8px;
  min-width: 32px;
  min-height: 32px;
  border-radius: 50%;
}

.icon-button:hover {
  background-color: rgba(0, 0, 0, 0.08);
}

@media (prefers-color-scheme: dark) {
  .icon-button:hover {
    background-color: rgba(255, 255, 255, 0.1);
  }
}
```

### Card Styling

```css
.card {
  background-color: var(--card-bg-color);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  border: 1px solid var(--card-shade-color);
}

@media (prefers-color-scheme: dark) {
  .card {
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.1);
  }
}

.card:hover {
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.16);
}
```

### Entry Styling

```css
entry {
  border-radius: 8px;
  padding: 8px 12px;
  background-color: var(--window-bg-color);
  border: 1px solid var(--border-color);
}

@media (prefers-color-scheme: dark) {
  entry {
    background-color: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.12);
  }
}

entry:focus {
  border-color: var(--accent-bg-color);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-bg-color) 30%, transparent);
}
```

### List Items

```css
.listitem {
  padding: 12px;
  border-radius: 8px;
  transition: background-color 200ms ease;
}

.listitem:hover {
  background-color: var(--card-shade-color);
}

.listitem:active {
  background-color: color-mix(in srgb, var(--card-shade-color) 50%, var(--window-bg-color));
}

@media (prefers-color-scheme: dark) {
  .listitem:hover {
    background-color: rgba(255, 255, 255, 0.04);
  }

  .listitem:active {
    background-color: rgba(255, 255, 255, 0.08);
  }
}
```

## Typography

### Font Families

```css
/* System font */
window {
  font-family: "Cantarell", system-ui, sans-serif;
}

/* Monospace for code */
.code {
  font-family: "JetBrains Mono", "Monospace", monospace;
}

/* Headlines */
.title-1 {
  font-family: "Cantarell", system-ui, sans-serif;
  font-size: 28pt;
  font-weight: 700;
  line-height: 1.2;
}

.title-2 {
  font-family: "Cantarell", system-ui, sans-serif;
  font-size: 24pt;
  font-weight: 700;
  line-height: 1.2;
}

.title-3 {
  font-family: "Cantarell", system-ui, sans-serif;
  font-size: 20pt;
  font-weight: 600;
  line-height: 1.3;
}

.body {
  font-family: "Cantarell", system-ui, sans-serif;
  font-size: 11pt;
  font-weight: 400;
  line-height: 1.5;
}

.caption {
  font-family: "Cantarell", system-ui, sans-serif;
  font-size: 9pt;
  font-weight: 400;
  line-height: 1.4;
}
```

### Text Colors

```css
.text-primary {
  color: var(--window-fg-color);
  opacity: 1.0;
}

.text-secondary {
  color: var(--window-fg-color);
  opacity: 0.7;
}

.text-tertiary {
  color: var(--window-fg-color);
  opacity: 0.5;
}
```

## Spacing & Layout

### Spacing Scale

```css
.space-xs { padding: 4px; }
.space-sm { padding: 8px; }
.space-md { padding: 12px; }
.space-lg { padding: 16px; }
.space-xl { padding: 24px; }
.space-2xl { padding: 32px; }
.space-3xl { padding: 48px; }
```

### Gap Spacing

```css
.gap-xs { gap: 4px; }
.gap-sm { gap: 8px; }
.gap-md { gap: 12px; }
.gap-lg { gap: 16px; }
.gap-xl { gap: 24px; }
.gap-2xl { gap: 32px; }
```

### Border Radius

```css
.radius-sm { border-radius: 4px; }
.radius-md { border-radius: 8px; }
.radius-lg { border-radius: 12px; }
.radius-xl { border-radius: 16px; }
.radius-2xl { border-radius: 24px; }
```

## Animations & Transitions

### Transition Utilities

```css
.transition-fast {
  transition: all 150ms ease;
}

.transition-normal {
  transition: all 200ms ease;
}

.transition-slow {
  transition: all 300ms ease;
}
```

### Hover Effects

```css
.button-lift {
  transition: transform 100ms ease, box-shadow 200ms ease;
}

.button-lift:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
}

.button-lift:active {
  transform: translateY(0);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.12);
}
```

### Fade Animations

```css
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.fade-in {
  animation: fadeIn 300ms ease-out;
}
```

### Scale Animations

```css
@keyframes scaleIn {
  from {
    transform: scale(0.95);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.scale-in {
  animation: scaleIn 200ms ease-out;
}
```

## Loading Custom CSS

### Load from GResource

```c
// In application startup
static void load_css(GtkApplication *app) {
    GtkCssProvider *provider = gtk_css_provider_new();
    gtk_css_provider_load_from_resource(provider,
        "/org/example/app/styles/style.css");

    gtk_style_context_add_provider_for_display(
        gdk_display_get_default(),
        GTK_STYLE_PROVIDER(provider),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
    );
}
```

### Automatic Style Loading

Libadwaita automatically loads CSS files from your application's resource base path:

```
/org/example/app/
├── styles/
│   ├── style.css        # Always loaded
│   ├── style-dark.css   # Dark mode
│   ├── style-hc.css     # High contrast
│   └── style-hc-dark.css # Dark + high contrast
```

```c
// Set resource base path
adw_application_set_resource_base_path(ADW_APPLICATION(app),
                                         "/org/example/app");
```

### Load CSS Programmatically

```c
// Load from data
GtkCssProvider *provider = gtk_css_provider_new();
gtk_css_provider_load_from_data(provider,
    "window { background-color: @window_bg; }",
    -1);
gtk_style_context_add_provider(
    gtk_widget_get_style_context(widget),
    GTK_STYLE_PROVIDER(provider),
    GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
);
```

## Dark Mode Control

### Use AdwStyleManager

```c
AdwStyleManager *manager = adw_style_manager_get_default();

// Force dark mode
adw_style_manager_set_color_scheme(manager,
                                     ADW_COLOR_SCHEME_FORCE_DARK);

// Force light mode
adw_style_manager_set_color_scheme(manager,
                                     ADW_COLOR_SCHEME_FORCE_LIGHT);

// Follow system preference (default)
adw_style_manager_set_color_scheme(manager,
                                     ADW_COLOR_SCHEME_DEFAULT);

// Listen to changes
g_signal_connect(manager, "notify::dark",
                  G_CALLBACK(on_dark_changed), NULL);
```

### Python/PyGObject Version

```python
from gi.repository import Adw, Gio, GLib

manager = Adw.StyleManager.get_default()

# Force dark mode
manager.set_color_scheme(Adw.ColorScheme.FORCE_DARK)

# Force light mode
manager.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT)

# Follow system preference (default)
manager.set_color_scheme(Adw.ColorScheme.DEFAULT)

# Listen to changes
manager.connect('notify::dark', on_dark_changed)
```

## Icon Styling

### Symbolic Icons

```css
/* Default size */
.symbolic-icon {
  -gtk-icon-size: 16px;
  opacity: 0.8;
}

/* Large symbolic icon */
.symbolic-icon-large {
  -gtk-icon-size: 32px;
  opacity: 0.7;
}

/* Color symbolic icon with accent color */
.accent-icon {
  color: var(--accent-bg-color);
  opacity: 1.0;
}
```

## Resources

- **Libadwaita CSS Variables**: https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1.4/css-variables.html
- **Libadwaita Styling Guide**: https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1.4/styles-and-appearance.html
- **GTK CSS Overview**: https://docs.gtk.org/gtk4/css-overview.html
