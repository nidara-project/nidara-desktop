# GTK4 UI/UX Examples

This directory contains example files demonstrating modern GTK4 best practices for creating beautiful, native-feeling desktop applications.

## Files

### `window.ui`
GTK Builder UI template demonstrating:
- **AdwApplicationWindow** for GNOME platform integration
- **AdwHeaderBar** with standard GNOME header pattern
- **AdwViewStack** for view-based navigation
- **AdwLeaflet** for responsive sidebar/content layout
- **AdwBreakpoint** for adaptive UI at different screen sizes
- **GtkFlowBox** with card-based layout
- Proper widget composition and CSS classes

### `style.css`
CSS styling demonstrating:
- **Theme-aware colors** using CSS variables
- **Custom accent colors** for brand identity
- **Card styling** with hover effects and shadows
- **Responsive design** with media queries
- **High contrast mode** support
- **Typography scale** using Cantarell font
- **Focus indicators** for accessibility
- **Dark mode** overrides

### `application.c`
C code demonstrating:
- **GtkApplication** subclassing pattern
- **GActions** for application logic
- **Keyboard shortcuts** with accelerators
- **Custom CSS loading** via GtkCssProvider
- **File handling** with `open` signal
- **Proper GObject lifecycle** management

## Running the Example

```bash
# Compile with GTK4 and Libadwaita
gcc application.c -o example \
    $(pkg-config --cflags --libs gtk4 libadwaita-1)

# Run
./example
```

## Key Patterns Demonstrated

### 1. Modern Application Structure
- Subclass `AdwApplication` for GNOME integration
- Use `GActionEntry` for application actions
- Implement `startup`, `activate`, and `open` methods

### 2. Responsive Design
- Use `AdwBreakpoint` for adaptive layouts
- Support minimum width of 360px (mobile)
- Sidebar/content layout adapts at 600px

### 3. Header Bar Pattern
```
┌────────────────────────────────────────────┐
│  ◐  New  ▾    [Window Title]     ⋮  □  ✕ │
└────────────────────────────────────────────┘
```
- Start: Primary actions (New, Back)
- Center: Title or view switcher
- End: Menu and secondary actions

### 4. Card-Based Layout
- Use `GtkFlowBox` for responsive grid
- Cards with hover effects and shadows
- Icons, title, subtitle, action button pattern

### 5. Accessibility
- Semantic CSS classes (`.title-3`, `.caption`, `.dim-label`)
- Clear focus indicators
- Keyboard navigation support
- Screen reader labels

### 6. Theme Support
- CSS variables for light/dark mode
- High contrast overrides
- System accent color integration

## Best Practices Shown

### ✅ DO
- Use GTK4 APIs (not GTK3)
- Implement keyboard shortcuts
- Support dark mode
- Use semantic CSS classes
- Load UI from templates
- Bind actions to accelerators
- Use AdwStyleManager for themes
- Implement accessibility features

### ❌ DON'T
- Mix GTK3 and GTK4 APIs
- Block the main loop
- Ignore keyboard navigation
- Hardcode colors (use CSS variables)
- Skip high contrast mode
- Forget signal cleanup

## Resources

- [GTK4 Tutorial](https://docs.gtk.org/gtk4/getting_started.html)
- [Libadwaita Documentation](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1.4/)
- [GNOME HIG](https://developer.gnome.org/hig/)
