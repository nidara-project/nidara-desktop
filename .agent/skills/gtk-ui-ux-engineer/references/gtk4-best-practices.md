# GTK4 Best Practices

Modern GTK4 development patterns for building maintainable, performant applications.

## Application Architecture

### Use GtkApplication Subclassing

**Best Practice**: Always subclass `GtkApplication` for your app:

```c
struct _MyApp {
    GtkApplication parent;
    GSettings *settings;
};

G_DEFINE_TYPE(MyApp, my_app, GTK_TYPE_APPLICATION);

static void my_app_startup(GApplication *app) {
    MyApp *self = MY_APP(app);
    G_APPLICATION_CLASS(my_app_parent_class)->startup(app);

    // Initialize resources
    self->settings = g_settings_new("org.example.app");

    // Add actions
    g_action_map_add_action_entries(G_ACTION_MAP(app),
                                     app_entries,
                                     G_N_ELEMENTS(app_entries),
                                     app);

    // Set accelerators
    gtk_application_set_accels_for_action(GTK_APPLICATION(app),
                                           "app.quit",
                                           quit_accels);
}

static void my_app_activate(GApplication *app) {
    MyAppWindow *window = my_app_window_new(MY_APP(app));
    gtk_window_present(GTK_WINDOW(window));
}

static void my_app_open(GApplication *app,
                       GFile **files,
                       gint n_files,
                       const gchar *hint) {
    MyAppWindow *window = my_app_window_new(MY_APP(app));

    // Open files in new window
    for (int i = 0; i < n_files; i++) {
        my_app_window_open_file(window, files[i]);
    }

    gtk_window_present(GTK_WINDOW(window));
}
```

### Subclass GtkApplicationWindow

**Best Practice**: Always subclass `GtkApplicationWindow`:

```c
struct _MyAppWindow {
    GtkApplicationWindow parent;
    GtkStack *stack;
    AdwHeaderBar *header_bar;
};

G_DEFINE_TYPE(MyAppWindow, my_app_window, GTK_TYPE_APPLICATION_WINDOW);

static void my_app_window_class_init(MyAppWindowClass *klass) {
    GtkWidgetClass *widget_class = GTK_WIDGET_CLASS(klass);

    // Load UI template
    gtk_widget_class_set_template_from_resource(widget_class,
        "/org/example/app/ui/window.ui");

    // Bind child widgets
    gtk_widget_class_bind_template_child(widget_class, MyAppWindow, stack);
    gtk_widget_class_bind_template_child(widget_class, MyAppWindow, header_bar);
}

static void my_app_window_init(MyAppWindow *self) {
    gtk_widget_init_template(GTK_WIDGET(self));
}
```

## Widget Composition

### Use Templates for Complex Widgets

**Best Practice**: Use GTK builder templates for complex widget hierarchies:

```xml
<!-- window.ui -->
<interface>
  <template class="MyAppWindow" parent="GtkApplicationWindow">
    <property name="default-width">800</property>
    <property name="default-height">600</property>

    <child type="titlebar">
      <object class="AdwHeaderBar" id="header_bar">
        <property name="show-title">true</property>
        <child type="start">
          <object class="GtkButton">
            <property name="icon-name">document-open-symbolic</property>
            <signal name="clicked" handler="on_open_clicked" swapped="no"/>
          </object>
        </child>
      </object>
    </child>

    <child>
      <object class="GtkBox">
        <property name="orientation">vertical</property>
        <child>
          <object class="GtkStack" id="stack">
            <!-- Stack children added here -->
          </object>
        </child>
      </object>
    </child>
  </template>
</interface>
```

### Create Reusable Composite Widgets

**Best Practice**: Build composite widgets for UI reuse:

```c
struct _MyCard {
    GtkBox parent;
    GtkLabel *title;
    GtkLabel *subtitle;
    GtkButton *action_button;
};

G_DEFINE_TYPE(MyCard, my_card, GTK_TYPE_BOX);

static void my_card_class_init(MyCardClass *klass) {
    GtkWidgetClass *widget_class = GTK_WIDGET_CLASS(klass);

    // Install properties
    g_object_class_install_property(
        G_OBJECT_CLASS(klass),
        PROP_TITLE,
        g_param_spec_string("title", "Title", "Card title",
                            NULL, G_PARAM_READWRITE)
    );
}

static void my_card_init(MyCard *self) {
    gtk_orientable_set_orientation(GTK_ORIENTABLE(self),
                                    GTK_ORIENTATION_VERTICAL);
    gtk_box_set_spacing(GTK_BOX(self), 6);
    gtk_widget_add_css_class(GTK_WIDGET(self), "card");

    self->title = gtk_label_new(NULL);
    gtk_widget_add_css_class(GTK_WIDGET(self->title), "title");
    gtk_box_append(GTK_BOX(self), GTK_WIDGET(self->title));

    self->subtitle = gtk_label_new(NULL);
    gtk_widget_add_css_class(GTK_WIDGET(self->subtitle), "subtitle");
    gtk_box_append(GTK_BOX(self), GTK_WIDGET(self->subtitle));

    self->action_button = gtk_button_new_with_label("Action");
    gtk_box_append(GTK_BOX(self), GTK_WIDGET(self->action_button));
}

static void my_card_set_title(MyCard *self, const gchar *title) {
    gtk_label_set_text(GTK_LABEL(self->title), title);
}
```

## List Views & Models

### Use GtkListView with GListModel

**Best Practice**: Modern GTK4 list rendering:

```c
// Create list item factory
static void setup_listitem_cb(GtkListItem *list_item, gpointer user_data) {
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    gtk_widget_add_css_class(box, "list-item-content");

    GtkWidget *icon = gtk_image_new_from_icon_name("folder-symbolic");
    gtk_box_append(GTK_BOX(box), icon);

    GtkWidget *label = gtk_label_new(NULL);
    gtk_box_append(GTK_BOX(box), label);

    gtk_list_item_set_child(list_item, box);
}

static void bind_listitem_cb(GtkListItem *list_item, gpointer user_data) {
    GObject *item = gtk_list_item_get_item(list_item);
    GtkWidget *box = gtk_list_item_get_child(list_item);

    // Get label from box (first child)
    GtkWidget *label = gtk_widget_get_first_child(box);
    const char *text = my_item_get_text(MY_ITEM(item));
    gtk_label_set_text(GTK_LABEL(label), text);
}

// Setup list view
GtkListItemFactory *factory = gtk_signal_list_item_factory_new();
g_signal_connect(factory, "setup", G_CALLBACK(setup_listitem_cb), NULL);
g_signal_connect(factory, "bind", G_CALLBACK(bind_listitem_cb), NULL);

GListStore *store = g_list_store_new(MY_TYPE_ITEM);
// Add items...

GtkSelectionModel *model = gtk_single_selection_new(G_LIST_MODEL(store));
GtkWidget *listview = gtk_list_view_new(GTK_SELECTION_MODEL(model), factory);
```

### Efficient Model Updates

**Best Practice**: Update existing models instead of rebuilding:

```c
// WRONG - Rebuilds entire model
void update_list_wrong(GtkListStore *store) {
    g_list_store_remove_all(store);
    for (int i = 0; i < 1000; i++) {
        g_list_store_append(store, create_item(i));
    }
}

// CORRECT - Update in place
void update_list_correct(GtkListStore *store) {
    // Remove deleted items
    for (int i = g_list_model_get_n_items(G_LIST_MODEL(store)) - 1; i >= 0; i--) {
        gpointer item = g_list_model_get_item(G_LIST_MODEL(store), i);
        if (should_delete(item)) {
            g_list_store_remove(store, i);
        }
    }

    // Add new items
    for (int i = 0; i < new_items_count; i++) {
        g_list_store_append(store, new_items[i]);
    }
}
```

## Actions & Menus

### Use GActions for All Application Logic

**Best Practice**: Implement functionality as actions:

```c
// Define action entries
static GActionEntry app_entries[] = {
    { "quit", on_quit, NULL, NULL },
    { "preferences", on_preferences, NULL, NULL },
    { "about", on_about, NULL, NULL }
};

static GActionEntry win_entries[] = {
    { "save", on_save, NULL, NULL },
    { "save-as", on_save_as, NULL, NULL },
    { "undo", on_undo, NULL, NULL },
    { "redo", on_redo, NULL, NULL },
    { "find", on_find, NULL, NULL }
};

// Add actions in startup
static void my_app_startup(GApplication *app) {
    g_action_map_add_action_entries(G_ACTION_MAP(app),
                                     app_entries,
                                     G_N_ELEMENTS(app_entries),
                                     app);
}

// Add window-specific actions in init
static void my_app_window_init(MyAppWindow *self) {
    g_action_map_add_action_entries(G_ACTION_MAP(self),
                                     win_entries,
                                     G_N_ELEMENTS(win_entries),
                                     self);
}
```

### Stateful Actions

**Best Practice**: Use stateful actions for toggle properties:

```c
// Create stateful action
static void on_fullscreen_changed(GSimpleAction *action,
                                   GVariant *value,
                                   gpointer user_data) {
    gboolean is_fullscreen = g_variant_get_boolean(value);

    // Update UI
    if (is_fullscreen) {
        gtk_window_fullscreen(GTK_WINDOW(user_data));
    } else {
        gtk_window_unfullscreen(GTK_WINDOW(user_data));
    }

    // Update action state
    g_simple_action_set_state(action, value);
}

// Register stateful action
static void register_fullscreen_action(GtkWindow *window) {
    GSimpleAction *action = g_simple_action_new_stateful(
        "fullscreen", NULL,
        g_variant_new_boolean(FALSE)
    );

    g_signal_connect(action, "change-state",
                     G_CALLBACK(on_fullscreen_changed), window);

    g_action_map_add_action(G_ACTION_MAP(window), G_ACTION(action));
}
```

## Event Controllers

### Use GTK4 Event Controllers

**Best Practice**: Prefer event controllers over raw signals:

```c
// Keyboard controller
GtkEventController *key_controller = gtk_event_controller_key_new();
gtk_widget_add_controller(widget, key_controller);
g_signal_connect(key_controller, "key-pressed",
                 G_CALLBACK(on_key_pressed), self);
g_signal_connect(key_controller, "key-released",
                 G_CALLBACK(on_key_released), self);

// Focus controller
GtkEventController *focus_controller = gtk_event_controller_focus_new();
gtk_widget_add_controller(widget, focus_controller);
g_signal_connect(focus_controller, "enter",
                 G_CALLBACK(on_focus_enter), self);
g_signal_connect(focus_controller, "leave",
                 G_CALLBACK(on_focus_leave), self);

// Motion controller
GtkEventController *motion_controller = gtk_event_controller_motion_new();
gtk_widget_add_controller(widget, motion_controller);
g_signal_connect(motion_controller, "motion",
                 G_CALLBACK(on_motion), self);
```

### Gesture Controllers

**Best Practice**: Use gestures for click and drag:

```c
// Click gesture
GtkGesture *click = gtk_gesture_click_new();
g_signal_connect(click, "pressed", G_CALLBACK(on_click_pressed), widget);
g_signal_connect(click, "released", G_CALLBACK(on_click_released), widget);
gtk_widget_add_controller(widget, GTK_EVENT_CONTROLLER(click));

// Drag gesture
GtkGesture *drag = gtk_gesture_drag_new();
gtk_gesture_single_set_button(GTK_GESTURE_SINGLE(drag), GDK_BUTTON_PRIMARY);
g_signal_connect(drag, "drag-begin", G_CALLBACK(on_drag_begin), self);
g_signal_connect(drag, "drag-update", G_CALLBACK(on_drag_update), self);
g_signal_connect(drag, "drag-end", G_CALLBACK(on_drag_end), self);
gtk_widget_add_controller(drawing_area, GTK_EVENT_CONTROLLER(drag));
```

## Property Bindings

### Use GObject Bindings for Synchronization

**Best Practice**: Bind widget properties together:

```c
// Bidirectional binding between entry and label
g_object_bind_property(
    entry, "text",
    label, "label",
    G_BINDING_BIDIRECTIONAL | G_BINDING_SYNC_CREATE
);

// Binding with transform function
g_object_bind_property_full(
    slider, "value",               // Source property
    label, "label",                // Target property
    G_BINDING_DEFAULT,             // Flags
    slider_value_to_label,         // Transform to
    label_to_slider_value,         // Transform from
    NULL, NULL                     // User data / notify
);
```

### Bind Settings to Widget Properties

**Best Practice**: Use GSettings binding:

```c
GSettings *settings = g_settings_new("org.example.app");

// Bind settings to widget properties
g_settings_bind(settings, "window-width",
                 window, "default-width",
                 G_SETTINGS_BIND_DEFAULT);

g_settings_bind(settings, "theme",
                 app, "theme",
                 G_SETTINGS_BIND_DEFAULT);

// Bind with custom mapping
g_settings_bind_with_mapping(settings, "custom-setting",
                              widget, "property",
                              G_SETTINGS_BIND_DEFAULT,
                              settings_to_widget,
                              widget_to_settings,
                              NULL, NULL);
```

## Memory Management

### GObject Reference Counting

**Best Practice**: Let containers manage widget ownership:

```c
// CORRECT - Container manages ownership
GtkWidget *button = gtk_button_new_with_label("Click");
gtk_box_append(GTK_BOX(box), button);
// No g_object_unref needed - box owns it

// WRONG - Manual reference management
GtkWidget *button = gtk_button_new_with_label("Click");
gtk_box_append(GTK_BOX(box), button);
g_object_unref(button);  // May leak or crash
```

### Signal Disconnection in Dispose

**Best Practice**: Clean up signals in dispose:

```c
struct _MyWidget {
    GtkWidget parent;
    GtkButton *button;
    gulong button_clicked_id;
};

static void my_widget_dispose(GObject *object) {
    MyWidget *self = MY_WIDGET(object);

    // Disconnect signals
    if (self->button_clicked_id > 0) {
        g_signal_handler_disconnect(self->button, self->button_clicked_id);
        self->button_clicked_id = 0;
    }

    // Clear references
    g_clear_object(&self->button);

    G_OBJECT_CLASS(my_widget_parent_class)->dispose(object);
}
```

## Performance Optimization

### Avoid Excessive Queue Draws

**Best Practice**: Use property notifications:

```c
// WRONG - Triggers full redraw
void on_data_changed(void) {
    gtk_widget_queue_draw(widget);
}

// CORRECT - More efficient
void on_data_changed(void) {
    gtk_widget_notify(widget, "content");
}
```

### CSS Performance

**Best Practice**: Use efficient CSS selectors:

```css
/* WRONG - Too specific, hard to optimize */
window #header .button:hover label {
    background: red;
}

/* CORRECT - Use classes */
window .primary-button:hover {
    background: var(--accent-bg-color);
}

/* Use direct child selector for performance */
.content > .card {
    padding: 16px;
}
```

## Resources

- **GTK4 Tutorial**: https://docs.gtk.org/gtk4/getting_started.html
- **GObject Reference Manual**: https://docs.gtk.org/gobject/
- **GIO Actions**: https://docs.gtk.org/gio/class.Action.html
