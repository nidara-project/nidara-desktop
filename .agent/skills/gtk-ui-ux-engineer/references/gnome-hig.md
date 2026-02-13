# GNOME Human Interface Guidelines (HIG)

Key principles and patterns from the official GNOME HIG for creating native-feeling GTK applications.

## Core Design Principles

### Platform Integration
GTK applications should feel native to the GNOME desktop environment. This means:

- Use **header bars** for window controls and primary actions
- Follow **system font** conventions (Cantarell by default)
- Respect **system theme** (light/dark mode, Adwaita)
- Use **system icons** from the GNOME icon theme
- Implement **keyboard shortcuts** following system conventions

### Header Bar Pattern

Header bars are standard top window elements that integrate window controls with application-specific actions:

```
┌────────────────────────────────────────────┐
│  ◐  Save  ▾    [Window Title]     ⋮  □  ✕ │
│ [Start]   [Center]              [End]    │
└────────────────────────────────────────────┘
```

**Placement Rules:**
- **Start (left)**: Primary action buttons (New, Add, Open, Back, Search)
- **Center**: Window heading or view switcher
- **End (right)**: Menus, settings, window controls

**Example C Code:**
```c
GtkWidget *header_bar = adw_header_bar_new();

// Add start button
GtkWidget *new_button = gtk_button_new_from_icon_name("document-new-symbolic");
adw_header_bar_pack_start(ADW_HEADER_BAR(header_bar), new_button);

// Set title
adw_header_bar_set_title_widget(ADW_HEADER_BAR(header_bar),
                                  gtk_label_new("My App"));

// Add end menu
GtkWidget *menu_button = gtk_menu_button_new();
gtk_menu_button_set_icon_name(GTK_MENU_BUTTON(menu_button),
                               "open-menu-symbolic");
adw_header_bar_pack_end(ADW_HEADER_BAR(header_bar), menu_button);
```

## Layout Patterns

### Responsive Design

Applications should adapt to different screen sizes:

- **Minimum width**: 360px (mobile devices)
- **Optimal width**: 800-1200px (desktops)
- **Breakpoint at 600px**: Switch between compact and expanded layouts

**Adaptive Containers:**
- Use `AdwLeaflet` for side-by-side to stacked layout transitions
- Use `AdwBreakpoint` for property changes at specific widths
- Use `AdwViewStack` with `AdwViewSwitcher` for tab-like navigation

### Grid Layouts

Use `GtkGrid` for complex 2D layouts with row/column positioning:

```c
GtkWidget *grid = gtk_grid_new();
gtk_grid_set_row_spacing(GTK_GRID(grid), 6);
gtk_grid_set_column_spacing(GTK_GRID(grid), 12);

// Label and entry in a row
gtk_grid_attach(GTK_GRID(grid), label, 0, 0, 1, 1);
gtk_grid_attach(GTK_GRID(grid), entry, 1, 0, 2, 1);

// Button spanning two columns
gtk_grid_attach(GTK_GRID(grid), button, 0, 1, 3, 1);
```

### Box Layouts

Use `GtkBox` for linear (single-row or single-column) layouts:

```c
GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
gtk_box_append(GTK_BOX(box), label1);
gtk_box_append(GTK_BOX(box), entry);
gtk_box_append(GTK_BOX(box), button);

// Homogeneous sizing (equal widths/heights)
gtk_box_set_homogeneous(GTK_BOX(box), TRUE);
```

## Controls & Widgets

### Buttons

**Button Types:**
- **Primary buttons**: Use accent color, for main actions
- **Secondary buttons**: No accent color, for less important actions
- **Icon-only buttons**: Use symbolic icons, 32px minimum touch target
- **Flat buttons**: Use for toolbar actions

**Button Labels:**
- Use **imperative verbs**: "Save" not "Save the file"
- Use **sentence case**: "Open file" not "Open File"
- Keep labels **concise** (1-3 words preferred)

### Text Entries

**Entry Patterns:**
- Include **placeholder text** to indicate purpose
- Provide **inline validation** for errors
- Use **password mode** for sensitive data
- Set **maximum length** for constrained inputs

```c
GtkWidget *entry = gtk_entry_new();
gtk_entry_set_placeholder_text(GTK_ENTRY(entry), "Enter your name");
gtk_entry_set_max_length(GTK_ENTRY(entry), 50);

// Add icons
gtk_entry_set_icon_from_icon_name(GTK_ENTRY(entry),
                                    GTK_ENTRY_ICON_PRIMARY,
                                    "user-info-symbolic");
```

### Lists & Grids

**List View Pattern:**
- Use `GtkListView` for modern, performant list rendering
- Implement `GtkListItemFactory` for custom item widgets
- Use selection models for multi-select capabilities

**Example List View:**
```c
// Create factory
GtkListItemFactory *factory = gtk_signal_list_item_factory_new();
g_signal_connect(factory, "setup", G_CALLBACK(setup_listitem), NULL);
g_signal_connect(factory, "bind", G_CALLBACK(bind_listitem), NULL);

// Create model
GListStore *store = g_list_store_new(MY_TYPE_ITEM);
for (int i = 0; i < 100; i++) {
    g_list_store_append(store, create_item(i));
}

// Create selection
GtkSelectionModel *selection = gtk_single_selection_new(
    G_LIST_MODEL(store)
);

// Create list view
GtkWidget *listview = gtk_list_view_new(GTK_SELECTION_MODEL(selection),
                                         factory);
```

## Navigation

### View Switching

Use `AdwViewStack` with `AdwViewSwitcher` for tab-like navigation:

```c
GtkWidget *stack = adw_view_stack_new();
GtkWidget *page1 = create_page1();
GtkWidget *page2 = create_page2();

adw_view_stack_add_child(ADW_VIEW_STACK(stack), page1, "page1");
adw_view_stack_set_title(ADW_VIEW_STACK(stack), page1, "First Page");

adw_view_stack_add_child(ADW_VIEW_STACK(stack), page2, "page2");
adw_view_stack_set_title(ADW_VIEW_STACK(stack), page2, "Second Page");

// Add view switcher to header bar
GtkWidget *switcher = adw_view_switcher_new();
adw_view_switcher_set_stack(ADW_VIEW_SWITCHER(switcher),
                             ADW_VIEW_STACK(stack));
adw_header_bar_set_title_widget(ADW_HEADER_BAR(header_bar), switcher);
```

### Back Navigation

Use back buttons in header bars for hierarchical navigation:

```c
GtkWidget *back_button = gtk_button_new_from_icon_name("go-previous-symbolic");
gtk_widget_add_css_class(back_button, "image-button");
g_signal_connect(back_button, "clicked", G_CALLBACK(go_back), window);
adw_header_bar_pack_start(ADW_HEADER_BAR(header_bar), back_button);
```

## Keyboard Shortcuts

### Standard Shortcuts

Implement these standard shortcuts:

| Action | Shortcut | Action Method |
|--------|----------|---------------|
| Quit | `Ctrl+Q` | `app.quit` |
| New | `Ctrl+N` | `app.new` |
| Open | `Ctrl+O` | `app.open` |
| Save | `Ctrl+S` | `win.save` |
| Save As | `Ctrl+Shift+S` | `win.save-as` |
| Undo | `Ctrl+Z` | `win.undo` |
| Redo | `Ctrl+Shift+Z` | `win.redo` |
| Find | `Ctrl+F` | `win.find` |
| Help | `F1` | `app.help` |
| Preferences | `Ctrl+,` | `app.preferences` |

**Setting Accelerators:**
```c
const char *quit_accels[] = { "<Control>q", NULL };
gtk_application_set_accels_for_action(GTK_APPLICATION(app),
                                       "app.quit",
                                       quit_accels);
```

## Accessibility

### Keyboard Navigation

- All interactive elements must be **focusable**
- Implement **logical tab order** (left-to-right, top-to-bottom)
- Use **mnemonic labels** for keyboard shortcuts
- **Arrow keys** should navigate within lists and grids

### Screen Reader Support

- Provide **accessible labels** for all widgets
- Include **accessible descriptions** for complex controls
- Announce **state changes** (loading, success, errors)
- Use **accessible roles** correctly (button, checkbox, etc.)

```c
// Set accessible label
gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_PROPERTY_LABEL, "Save changes to file",
    -1
);

// Set accessible description
gtk_accessible_update_property(GTK_ACCESSIBLE(widget),
    GTK_ACCESSIBLE_PROPERTY_DESCRIPTION,
    "Saves the current document to disk. Use Ctrl+S for quick save.",
    -1
);
```

### High Contrast Mode

Applications should respect high contrast mode:

```css
@media (prefers-contrast: more) {
  button {
    border: 2px solid currentColor;
  }

  .card {
    background-color: transparent;
    border: 1px solid currentColor;
  }
}
```

## Resources

- **Official GNOME HIG**: https://developer.gnome.org/hig/
- **GTK4 Tutorial**: https://docs.gtk.org/gtk4/getting_started.html
- **Libadwaita Docs**: https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1.4/
