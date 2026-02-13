# Accessibility Implementation Guide

Best practices for making GTK applications accessible to all users.

## Core Accessibility Principles

### What is Accessibility?

Accessibility means ensuring that people with disabilities can use your application effectively. This includes:

- **Screen readers** for blind/low-vision users
- **Keyboard navigation** for users who can't use a mouse
- **High contrast** for users with low vision
- **Text alternatives** for non-text content

### Why It Matters

- **Inclusivity**: Everyone should be able to use your application
- **Legal requirements**: Many jurisdictions require accessibility compliance
- **Better UX**: Accessible apps are generally better designed
- **Built-in**: GTK makes accessibility easy - use it!

## GTK Accessibility Basics

### Standard Widgets Are Accessible

Good news: GTK's standard widgets (buttons, entries, labels, etc.) are accessible by default!

```c
// This button is automatically accessible
GtkWidget *button = gtk_button_new_with_label("Save");
gtk_box_append(GTK_BOX(box), button);

// Screen reader reads: "Save, button"
```

### Custom Widgets Need Accessibility

When creating custom widgets, you must add accessibility support:

```c
// Set accessible label
gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_PROPERTY_LABEL, "My custom widget",
    -1
);

// Set accessible role
gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_PROPERTY_ROLE,
    GTK_ACCESSIBLE_ROLE_BUTTON,
    -1
);
```

## Accessible Labels & Descriptions

### Labels

Labels provide the primary name/identity of a widget:

```c
// Entry with placeholder
GtkWidget *entry = gtk_entry_new();
gtk_entry_set_placeholder_text(GTK_ENTRY(entry), "Enter your name");
// Screen reader reads: "Enter your name, text entry"

// Set accessible label explicitly
gtk_accessible_update_property(GTK_ACCESSIBLE(entry),
    GTK_ACCESSIBLE_PROPERTY_LABEL,
    "Enter your full name",
    -1
);
```

### Descriptions

Descriptions provide additional context:

```c
// Complex control with description
GtkWidget *entry = gtk_entry_new();
gtk_accessible_update_property(GTK_ACCESSIBLE(entry),
    GTK_ACCESSIBLE_PROPERTY_LABEL, "Server address",
    -1);
gtk_accessible_update_property(GTK_ACCESSIBLE(entry),
    GTK_ACCESSIBLE_PROPERTY_DESCRIPTION,
    "Enter the IP address or hostname of the server",
    -1);
// Screen reader reads: "Server address, text entry. Enter the IP address or hostname of the server."
```

### Mnemonic Labels

Associate labels with controls for keyboard shortcuts:

```c
GtkWidget *label = gtk_label_new_with_mnemonic("_Name:");
GtkWidget *entry = gtk_entry_new();

gtk_label_set_mnemonic_widget(GTK_LABEL(label), entry);

// User can press Alt+N to focus the entry
```

## Keyboard Navigation

### Focus Management

All interactive elements must be keyboard focusable:

```c
// Make widget focusable
gtk_widget_set_can_focus(widget, TRUE);

// Set initial focus
gtk_widget_grab_focus(entry);

// Set focus chain (tab order)
GList *focus_chain = NULL;
focus_chain = g_list_append(focus_chain, entry1);
focus_chain = g_list_append(focus_chain, entry2);
focus_chain = g_list_append(focus_chain, button);
gtk_container_set_focus_chain(GTK_CONTAINER(container), focus_chain);
```

### Standard Keyboard Shortcuts

Implement standard shortcuts for consistency:

| Action | Shortcut | Action Name |
|--------|----------|-------------|
| Quit | `Ctrl+Q` | `app.quit` |
| New | `Ctrl+N` | `app.new` |
| Open | `Ctrl+O` | `app.open` |
| Save | `Ctrl+S` | `win.save` |
| Find | `Ctrl+F` | `win.find` |
| Help | `F1` | `app.help` |

```c
// Set accelerators
const char *save_accels[] = { "<Control>s", NULL };
gtk_application_set_accels_for_action(GTK_APPLICATION(app),
                                       "win.save",
                                       save_accels);
```

### Keyboard Events

Handle keyboard events with GTK4 event controllers:

```c
// Key controller
GtkEventController *key_controller = gtk_event_controller_key_new();
gtk_widget_add_controller(widget, key_controller);

g_signal_connect(key_controller, "key-pressed",
                 G_CALLBACK(on_key_pressed), self);

gboolean on_key_pressed(GtkEventControllerKey *controller,
                        guint keyval,
                        guint keycode,
                        GdkModifierType state,
                        gpointer user_data) {
    // Handle special keys
    if (keyval == GDK_KEY_Escape) {
        on_cancel();
        return TRUE;  // Event handled
    }
    return FALSE;  // Let default handling continue
}
```

## Screen Reader Support

### ATK Integration

GTK4 automatically provides accessibility via ATK (Assistive Technology Kit). For custom widgets, implement accessibility interfaces:

```c
// For custom text widgets, implement GtkAccessibleText
// GTK4 4.14+ provides public interfaces

// Notify screen reader of text changes
gtk_accessible_text_update_caret_position(GTK_ACCESSIBLE_TEXT(widget));
gtk_accessible_text_update_contents(GTK_ACCESSIBLE_TEXT(widget));
```

### Announce Important Events

Notify screen readers of dynamic changes:

```c
// Announce success message
static void announce_success(GtkWidget *widget, const char *message) {
    // Create temporary announcement widget
    GtkWidget *announcement = gtk_label_new(message);
    gtk_widget_add_css_class(announcement, "live-region");

    // Add to UI temporarily
    gtk_box_append(GTK_BOX(content_box), announcement);

    // Screen reader will announce this

    // Remove after delay
    g_timeout_add(3000, G_SOURCE_FUNC(remove_announcement), announcement);
}
```

## High Contrast Mode

### Respect High Contrast Preference

Users with low vision often use high contrast mode:

```css
/* Default styling */
.card {
  background-color: @card_bg_color;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

/* High contrast override */
@media (prefers-contrast: more) {
  .card {
    background-color: transparent;
    border: 2px solid currentColor;
  }

  button {
    border: 2px solid currentColor;
    background-color: transparent;
  }
}
```

### Testing High Contrast

```c
// Enable high contrast mode for testing
AdwStyleManager *manager = adw_style_manager_get_default();
adw_style_manager_set_color_scheme(manager,
                                    ADW_COLOR_SCHEME_FORCE_LIGHT);
adw_style_manager_set_high_contrast(manager, TRUE);
```

## Accessible Roles

### Common Roles

Assign correct roles to custom widgets:

```c
// Button role
gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_PROPERTY_ROLE,
    GTK_ACCESSIBLE_ROLE_BUTTON,
    -1
);

// Checkbox role
gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_PROPERTY_ROLE,
    GTK_ACCESSIBLE_ROLE_CHECK_BOX,
    -1
);

// List role
gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_PROPERTY_ROLE,
    GTK_ACCESSIBLE_ROLE_LIST,
    -1
);
```

### Roles Reference

| Role | When to Use |
|------|-------------|
| `GTK_ACCESSIBLE_ROLE_BUTTON` | Clickable elements that trigger actions |
| `GTK_ACCESSIBLE_ROLE_CHECK_BOX` | Checkable items |
| `GTK_ACCESSIBLE_ROLE_COMBO_BOX` | Dropdown selectors |
| `GTK_ACCESSIBLE_ROLE_ENTRY` | Text input fields |
| `GTK_ACCESSIBLE_ROLE_GRID` | Grid layouts |
| `GTK_ACCESSIBLE_ROLE_LIST` | List widgets |
| `GTK_ACCESSIBLE_ROLE_MENU` | Menus |
| `GTK_ACCESSIBLE_ROLE_RADIO_BUTTON` | Radio buttons |
| `GTK_ACCESSIBLE_ROLE_SCROLL_BAR` | Scroll bars |
| `GTK_ACCESSIBLE_ROLE_SLIDER` | Sliders |
| `GTK_ACCESSIBLE_ROLE_TAB` | Tabs |
| `GTK_ACCESSIBLE_ROLE_TEXT` | Text content |
| `GTK_ACCESSIBLE_ROLE_TOGGLE_BUTTON` | Toggleable buttons |

## Accessible States

### Toggle States

```c
// Checkable widget state
gboolean is_checked = g_value_get_boolean(state);
gtk_accessible_update_state(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_STATE_CHECKED,
    is_checked
);

// Toggle button state
gtk_accessible_update_state(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_STATE_PRESSED,
    pressed
);
```

### Selection State

```c
// Selected item in list
gtk_accessible_update_state(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_STATE_SELECTED,
    TRUE
);
```

### Disabled State

```c
// Disabled widgets are automatically marked
gtk_widget_set_sensitive(widget, FALSE);
// Screen reader reads: "My button, button, disabled"
```

## Focus Indicators

### Clear Focus Indicators

Ensure focused elements are clearly visible:

```css
/* Default focus ring */
:focus {
  outline: 2px solid var(--accent-bg-color);
  outline-offset: 2px;
}

/* High contrast focus */
@media (prefers-contrast: more) {
  :focus {
    outline: 3px solid currentColor;
    outline-offset: 0;
  }
}
```

## Testing Accessibility

### Keyboard Testing

Test your application with keyboard only:

1. **Unplug your mouse**
2. **Navigate**: Use `Tab` to move between elements
3. **Activate**: Use `Enter` or `Space` to activate buttons
4. **Escape**: Use `Esc` to close dialogs/menus
5. **Shortcuts**: Test all keyboard shortcuts

### Screen Reader Testing

Test with Orca (Linux screen reader):

```bash
# Install Orca
sudo apt install orca

# Launch Orca
orca

# Test your app
./your-app
```

### Accessibility Inspector

Use Accerciser to inspect accessibility:

```bash
# Install Accerciser
sudo apt install accerciser

# Launch
accerciser
```

## Best Practices Checklist

### During Development

- [ ] All interactive elements are keyboard focusable
- [ ] Logical tab order (left-to-right, top-to-bottom)
- [ ] Clear focus indicators
- [ ] Standard keyboard shortcuts implemented
- [ ] All images have text alternatives
- [ ] Custom widgets have accessible labels
- [ ] Color is not the only way to convey information
- [ ] Text contrast meets WCAG AA standards (4.5:1)

### Before Release

- [ ] Test entire app with keyboard only
- [ ] Test with screen reader
- [ ] Test in high contrast mode
- [ ] Test with large text (150%+)
- [ ] Verify all form fields have labels
- [ ] Check that all dynamic changes are announced

## Resources

- **GNOME Accessibility Guide**: https://developer.gnome.org/documentation/guidelines/accessibility.html
- **GTK4 Accessibility**: https://docs.gtk.org/gtk4/section-accessibility.html
- **WCAG Guidelines**: https://www.w3.org/WAI/WCAG21/quickref/
- **Orca Screen Reader**: https://wiki.gnome.org/Projects/Orca
