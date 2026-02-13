/**
 * GTK4 Application Example
 * Demonstrates modern GTK4 patterns:
 * - GtkApplication subclassing
 * - GActions for application logic
 * - Keyboard shortcuts
 * - Custom CSS loading
 * - AdwStyleManager for theme support
 */

#include <gtk/gtk.h>
#include <adwaita.h>

#define APP_ID "org.example.gtk-ui-example"

// Application structure
struct _ExampleApp {
    AdwApplication parent;
};

G_DEFINE_TYPE(ExampleApp, example_app, ADW_TYPE_APPLICATION)

// Action handlers
static void on_new_window(GSimpleAction *action, GVariant *parameter, gpointer user_data) {
    ExampleApp *app = EXAMPLE_APP(user_data);
    g_print("New window activated\n");
}

static void on_preferences(GSimpleAction *action, GVariant *parameter, gpointer user_data) {
    g_print("Preferences activated\n");
}

static void on_shortcuts(GSimpleAction *action, GVariant *parameter, gpointer user_data) {
    g_print("Keyboard shortcuts activated\n");
}

static void on_about(GSimpleAction *action, GVariant *parameter, gpointer user_data) {
    g_print("About activated\n");
}

// Application actions
static GActionEntry app_entries[] = {
    { "new-window", on_new_window, NULL, NULL, NULL },
    { "preferences", on_preferences, NULL, NULL, NULL },
    { "shortcuts", on_shortcuts, NULL, NULL, NULL },
    { "about", on_about, NULL, NULL, NULL },
};

// Load custom CSS
static void load_css(GtkApplication *app) {
    GtkCssProvider *provider = gtk_css_provider_new();

    // Load CSS from resource or file
    // gtk_css_provider_load_from_resource(provider, "/org/example/app/style.css");
    gtk_css_provider_load_from_path(provider, "style.css", NULL);

    gtk_style_context_add_provider_for_display(
        gdk_display_get_default(),
        GTK_STYLE_PROVIDER(provider),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
    );
}

// Set keyboard shortcuts
static void set_accels(GtkApplication *app) {
    // New window
    const char *new_window_accels[] = { "<Primary>n", NULL };
    gtk_application_set_accels_for_action(app, "app.new-window", new_window_accels);

    // Preferences
    const char *preferences_accels[] = { "<Primary>comma", NULL };
    gtk_application_set_accels_for_action(app, "app.preferences", preferences_accels);

    // Shortcuts
    const char *shortcuts_accels[] = { "<Primary>question", NULL };
    gtk_application_set_accels_for_action(app, "app.shortcuts", shortcuts_accels);
}

// Application startup
static void example_app_startup(GApplication *gapp) {
    GtkApplication *app = GTK_APPLICATION(gapp);
    ExampleApp *self = EXAMPLE_APP(app);

    // Chain up
    ADW_APPLICATION_CLASS(example_app_parent_class)->startup(gapp);

    // Add actions
    g_action_map_add_action_entries(
        G_ACTION_MAP(app),
        app_entries,
        G_N_ELEMENTS(app_entries),
        self
    );

    // Set keyboard shortcuts
    set_accels(app);

    // Load custom CSS
    load_css(app);

    g_print("Application started\n");
}

// Application activate
static void example_app_activate(GApplication *gapp) {
    GtkApplication *app = GTK_APPLICATION(gapp);

    // Create window
    GtkBuilder *builder = gtk_builder_new_from_file("window.ui");
    GObject *window = gtk_builder_get_object(builder, "example_window");
    gtk_window_set_application(GTK_WINDOW(window), app);
    gtk_window_present(GTK_WINDOW(window));

    g_object_unref(builder);

    g_print("Window activated\n");
}

// Application open (handle file opening)
static void example_app_open(GApplication *gapp,
                          GFile **files,
                          gint n_files,
                          const gchar *hint) {
    GtkApplication *app = GTK_APPLICATION(gapp);

    for (int i = 0; i < n_files; i++) {
        char *path = g_file_get_path(files[i]);
        g_print("Opening file: %s\n", path);
        g_free(path);
    }

    // Activate to create window
    example_app_activate(gapp);
}

// Class initialization
static void example_app_class_init(ExampleAppClass *klass) {
    GApplicationClass *app_class = G_APPLICATION_CLASS(klass);

    app_class->startup = example_app_startup;
    app_class->activate = example_app_activate;
    app_class->open = example_app_open;
}

// Instance initialization
static void example_app_init(ExampleApp *self) {
    // Set application ID
    g_application_set_application_id(G_APPLICATION(self), APP_ID);
}

// Main function
int main(int argc, char **argv) {
    ExampleApp *app;
    int status;

    // Create application
    app = g_object_new(EXAMPLE_TYPE_APP,
                       "application-id", APP_ID,
                       "flags", G_APPLICATION_HANDLES_OPEN,
                       NULL);

    // Run application
    status = g_application_run(G_APPLICATION(app), argc, argv);

    // Cleanup
    g_object_unref(app);

    return status;
}
