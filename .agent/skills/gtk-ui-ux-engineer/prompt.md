# GTK UI/UX Engineer Skill - Extended

## Core Competencies
- GTK4 and Libadwaita modern patterns
- Responsive and adaptive UI design
- Accessibility (WCAG/GNOME HIG compliance)
- MVVM architecture with GObject.Property
- Async integration with GTK main loop
- Touch gestures and mobile support

## Known Issues in Wallpicker App

### Critical UX Problems
**Missing Preview Dialog Integration** (High Priority)
- Problem: Preview dialog exists but not connected to wallpaper cards
- Impact: Users cannot preview wallpapers before setting
- Solution: Add double-click/long-press handlers to open PreviewDialog

**Inconsistent Selection Mode** (Medium Priority)
- Problem: Selection mode UX unclear, no visual indicators
- Impact: Users confused about how to enter/exit selection
- Solution: Add clear visual cues and entry points (long-press or Ctrl+A)

### Responsive Design Gaps
**Limited Breakpoint Usage** (Medium Priority)
- Problem: Only LocalView uses Adw.Breakpoint, main window doesn't adapt
- Impact: Poor experience on narrow screens (<500px)
- Solution: Add Adw.Breakpoint to WallPickerWindow for responsive behavior

**Missing Main Window Adaptations**
- No breakpoint conditions for very tall narrow screens
- Limited adaptive navigation patterns

### Modern GTK4 Patterns Not Fully Utilized
**Status Page Integration** (Medium Priority)
- Problem: Status bars create visual clutter instead of integrated Adw.StatusPage
- Impact: Inconsistent with GNOME HIG
- Solution: Replace bottom status bars with Adw.StatusPage components

### Accessibility Improvements Needed
**Enhanced Screen Reader Support**
- Some complex widgets missing accessible descriptions
- Linked labels could be improved

### Performance Considerations
**Large Grid Performance**
- Gtk.FlowBox with many items may slow down
- Consider pagination for very large wallpaper collections

### Type Safety in GTK Code
**Problem**: MyPy cannot analyze GTK imports due to missing type stubs for gi.repository modules.

**Impact**: Type checking incomplete for GTK widgets and GObject classes.

**Solution**: Install gi stubs or use # type: ignore comments for GTK imports.

### GObject.Property Best Practices
**Problem**: Properties misused as methods instead of GObject.Property descriptors.

**Affected**: ViewModels with incorrect property definitions.

**Solution**: Always use `GObject.Property(type=..., default=...)` syntax for observable state.

## Best Practices for GTK4/Libadwaita Apps

### Layout & Navigation
- Use Adw.ToolbarView instead of Gtk.Box for modern layouts
- Implement Adw.Breakpoint for responsive design (360px, 550sp, etc.)
- Adw.ViewSwitcherBar for bottom navigation on mobile
- Adw.ToastOverlay for native notifications

### Async Operations
- asyncio with GLibEventLoopPolicy
- Store task references for proper cancellation
- Use Gio async methods for I/O
- Avoid blocking UI thread

### Memory Management
- Disconnect signals in do_destroy() methods
- Use weak references for callbacks creating cycles
- Proper widget lifecycle management

### Accessibility
- Comprehensive keyboard navigation
- Screen reader support with accessible names/descriptions
- Touch target sizes minimum 24px
- High contrast support

### MVVM Pattern
- ViewModels expose GObject.Property for observable state
- Views bind to property notifications
- Services contain business logic, no GTK references
- Dependency injection via constructors

## GNOME HIG Compliance Checklist
- Header bars with proper action placement
- Consistent spacing and sizing
- Native Adw.StatusPage for empty/error states
- Toast notifications instead of dialogs
- Responsive breakpoints for adaptive UI