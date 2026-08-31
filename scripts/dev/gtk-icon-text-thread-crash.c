/* Self-contained reproducer for the GTK icon-load thread racing the main thread
 * inside Pango (gtk#8295).
 *
 *   cc -O2 -o repro gtk-icon-text-thread-crash.c $(pkg-config --cflags --libs gtk4)
 *   ./repro            # SVG icon containing <text>   -> SIGSEGV, most runs
 *   ./repro --no-text  # identical run, icon has none -> survives
 *
 * It installs its own icon theme in a temp dir, so it does not depend on which
 * icons the machine happens to have. Exit 0 = survived; killed = reproduced.
 * Measured 2026-08-31 on gtk4 1:4.22.4-1 / pango 1:1.58.2-1 / cairo 1.18.4:
 * 5 of 6 runs died (3 SIGSEGV, 2 SIGABRT — "double free or corruption"), and
 * --no-text survived 4 of 4.
 *
 * 🔑 NOTE WHAT IS NOT HERE: no GTK_ICON_LOOKUP_PRELOAD, no icon-theme call at
 * all. Plain gtk_image_new_from_icon_name(), which is what every application
 * does. GTK asks for the threaded load by itself.
 *
 * ⚠️ TWO WAYS THIS HARNESS MEASURED NOTHING WHILE LOOKING GREEN, both fixed here
 * and both worth knowing before editing it:
 *
 *  1. The icons must live in a theme GTK actually SEARCHES. A theme of our own
 *     naming is never consulted unless it is active or inherited, so the first
 *     version planted them where nothing looked and survived 5 of 5. That is why
 *     they go in "hicolor" and why the program ABORTS with exit 2 when
 *     gtk_icon_theme_has_icon() says no — a void run must not be able to look
 *     like a pass.
 *  2. The tiles must be BUILT each round, not reused. The icon helper preloads
 *     when a widget's css size first settles, so widgets that merely change
 *     their icon pay for it once at startup and never race. Reusing them gave
 *     another 5 of 5 survivals, this time with the icons genuinely loading —
 *     2135 glyph draws, all on the main thread, per the pangotrace shim. That is
 *     also why the bug shows up when a launcher OPENS rather than while it is up.
 */
#include <gtk/gtk.h>
#include <stdlib.h>
#include <stdio.h>

#define TILES  90
#define ROUNDS 300

static int round_no = 0;
static GMainLoop *loop;

static const char *SVG_TEXT =
    "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'>"
    "<rect width='48' height='48' fill='#3584e4'/>"
    "<text x='4' y='16' font-family='sans-serif' font-size='10' fill='#fff'>abc</text>"
    "<text x='4' y='30' font-family='sans-serif' font-size='12' fill='#fff'>defg</text>"
    "<text x='4' y='44' font-family='serif'      font-size='9'  fill='#fff'>hijkl</text>"
    "</svg>";

static const char *SVG_PLAIN =
    "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'>"
    "<rect width='48' height='48' fill='#3584e4'/>"
    "<circle cx='24' cy='24' r='14' fill='#fff'/>"
    "</svg>";

static GtkWidget *flow;

static gboolean tick (gpointer data)
{
    /* Fresh tiles every round. The icon helper preloads when a widget's css size
     * first settles, so widgets that merely change their icon pay for that once
     * and never again — reusing them measures the wrong thing. Opening the app
     * grid builds its tiles, which is what this imitates. */
    GtkWidget *child;
    while ((child = gtk_widget_get_first_child (flow)) != NULL)
        gtk_flow_box_remove (GTK_FLOW_BOX (flow), child);

    for (int i = 0; i < TILES; i++)
        {
            char name[64], buf[64];
            g_snprintf (name, sizeof name, "gtkreprotexticon%d", (i + round_no) % TILES);
            g_snprintf (buf, sizeof buf, "app %d - round %d", i, round_no);

            GtkWidget *box = gtk_box_new (GTK_ORIENTATION_VERTICAL, 6);
            GtkWidget *img = gtk_image_new_from_icon_name (name);
            gtk_image_set_pixel_size (GTK_IMAGE (img), 16 + ((i + round_no) % 112));
            GtkWidget *lbl = gtk_label_new (buf);
            gtk_label_set_ellipsize (GTK_LABEL (lbl), PANGO_ELLIPSIZE_END);
            gtk_label_set_max_width_chars (GTK_LABEL (lbl), 12);
            gtk_box_append (GTK_BOX (box), img);
            gtk_box_append (GTK_BOX (box), lbl);
            gtk_flow_box_append (GTK_FLOW_BOX (flow), box);
        }

    if (++round_no >= ROUNDS)
        {
            g_print ("SURVIVED %d rounds\n", round_no);
            g_main_loop_quit (loop);
            return G_SOURCE_REMOVE;
        }
    return G_SOURCE_CONTINUE;
}

int main (int argc, char **argv)
{
    gboolean with_text = TRUE;
    for (int i = 1; i < argc; i++)
        if (g_str_equal (argv[i], "--no-text"))
            with_text = FALSE;

    gtk_init ();

    /* our own icon theme, so the run does not depend on the installed icon set */
    char *dir = g_dir_make_tmp ("gtk-icon-race-XXXXXX", NULL);
    /* The icons must live in a theme GTK actually searches. A theme of our own
     * naming is never consulted unless it is the active one or inherited, so we
     * plant them in "hicolor", which every lookup falls back to. The search path
     * is the PARENT of the theme directory. */
    char *theme_dir = g_build_filename (dir, "hicolor", NULL);
    char *apps = g_build_filename (theme_dir, "scalable", "apps", NULL);
    g_mkdir_with_parents (apps, 0755);
    char *index = g_build_filename (theme_dir, "index.theme", NULL);
    g_file_set_contents (index,
                         "[Icon Theme]\nName=hicolor\nDirectories=scalable/apps\n\n"
                         "[scalable/apps]\nSize=48\nMinSize=8\nMaxSize=512\nType=Scalable\n",
                         -1, NULL);
    for (int i = 0; i < TILES; i++)
        {
            char fn[64];
            g_snprintf (fn, sizeof fn, "gtkreprotexticon%d.svg", i);
            char *svg = g_build_filename (apps, fn, NULL);
            g_file_set_contents (svg, with_text ? SVG_TEXT : SVG_PLAIN, -1, NULL);
            g_free (svg);
        }

    GtkIconTheme *theme = gtk_icon_theme_get_for_display (gdk_display_get_default ());
    gtk_icon_theme_add_search_path (theme, dir);
    /* A run that cannot see its own icon loads nothing and "survives" — which is a
     * void result wearing a pass. Refuse to run instead of reporting one. */
    if (!gtk_icon_theme_has_icon (theme, "gtkreprotexticon0"))
        {
            g_printerr ("ABORT: the icon theme does not see our icons (%s) - this run would measure nothing\n", dir);
            return 2;
        }
    g_print ("ok: %d icons planted in %s (%s)\n", TILES, apps,
             with_text ? "SVG contains <text>" : "control: no <text>");

    GtkWidget *win = gtk_window_new ();
    gtk_window_set_default_size (GTK_WINDOW (win), 900, 700);
    flow = gtk_flow_box_new ();
    gtk_flow_box_set_max_children_per_line (GTK_FLOW_BOX (flow), 8);
    GtkWidget *sw = gtk_scrolled_window_new ();
    gtk_scrolled_window_set_child (GTK_SCROLLED_WINDOW (sw), flow);
    gtk_window_set_child (GTK_WINDOW (win), sw);

    gtk_window_present (GTK_WINDOW (win));
    g_timeout_add (5, tick, NULL);
    loop = g_main_loop_new (NULL, FALSE);
    g_main_loop_run (loop);
    return 0;
}
