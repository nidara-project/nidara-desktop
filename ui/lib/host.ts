// The application host — what `ags/gtk4/app` was, owned by us.
//
// This is the last piece of AGS that was not scaffolding. Its 328 lines were a
// `Gtk.Application` subclass plus conveniences, and Nidara called five of them:
// `start`, `apply_css`, `quit`, `get_windows`, and `application: app` when
// constructing a window. Everything else — the `window-toggled` signal, the
// `gtkTheme`/`iconTheme`/`cursorTheme` shortcuts, `toggle_window`,
// `get_monitors` as a notifying property — had no caller in any of the three
// bundles. What is here is what is used.
//
// THREE things it did that are load-bearing and easy to lose (each one is a
// silent failure, not a crash):
//
//  1. `Gtk.init()` AT MODULE SCOPE. Import declarations are evaluated before any
//     statement in the importing file, so an `Gtk.init()` written inline in
//     `app.ts` runs too late for any module that builds a widget — or reads the
//     icon theme, as `core/AppService` does — while being imported. Every module
//     that used to import `ags/gtk4/app` imports this instead, so the
//     initialisation order is preserved exactly.
//  2. `GLib.unsetenv("LD_PRELOAD")`. All three bundles are started with
//     `LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so` so layer-shell can hook GDK
//     before it opens the display — and it is `ags bundle`/`ags run` that put it
//     there, in the shell wrapper they generate around the JS, NOT
//     `bin/nidara-ui`. (Worth knowing twice over: whatever replaces the bundler
//     has to keep emitting it, or there is no bar and no dock at all.) That
//     variable is INHERITED, so without this line every app the dock launches —
//     and every `hyprctl`, `wpctl`, `nmcli` we spawn — gets it too.
//  3. `hold()`. The shell's windows are all created inside `main()`, and two of
//     them (the app grid, the agent pointer) are deliberately never mapped. A
//     GApplication with no held reference and no mapped window exits.
//
// What it did that we deliberately DROPPED:
//
//  - `Adw.init()`. AGS called it whenever libadwaita existed on the system, with
//    no way to opt out, which is why `core/ThemeManager` had to route dark/light
//    through `AdwStyleManager` — an initialised libadwaita OWNS
//    `GtkSettings:gtk-application-prefer-dark-theme`. Nidara has been
//    libadwaita-free in its widget tree since the Adwaita removal; now it is
//    libadwaita-free in its process too, and that detour is gone.
//  - `applicationId = "io.Astal." + instanceName`. AGS OVERWROTE whatever id the
//    app asked for. That single line is where the Settings window's Hyprland
//    class `io.Astal.ags` came from, and therefore the dock's remap of it —
//    the skill's seventh commandment, which this file retires. Measured, not
//    assumed: with an `application-id` set, GTK4 hands the Wayland compositor
//    exactly that string and IGNORES `prgname`; with no id it falls back to
//    `prgname` (which GJS leaves as "gjs").
//  - `HANDLES_COMMAND_LINE` + `vfunc_command_line`. That was how `ags run`
//     forwarded a request to an already-running instance. `nidara-ipc` talks to
//     the bus directly (`bin/nidara-ipc.c`), so a second invocation activating
//     the primary instance is the behaviour we want.
//  - The `io.Astal.Application` D-Bus service. The shell publishes its own doors
//    from `ui/shell/app.ts` — see `exportShellBusName` and the legacy one beside
//    it — and the greeter and lockscreen never had a request handler at all.

import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { setConsoleLogDomain } from "console"
import { exit } from "system"

// Before anything can construct a widget or touch the icon theme. See (1) above.
Gtk.init()

// See (2) above: this must not reach a single child process.
GLib.unsetenv("LD_PRELOAD")

export interface StartConfig {
  /**
   * The GApplication id — and therefore, on Wayland, the app-id the compositor
   * sees for every regular (non-layer-shell) window this process opens. For the
   * shell that is the Settings window, which Hyprland shows as this string.
   */
  applicationId: string
  /**
   * Human-readable name for the process: `g_set_application_name` (what a
   * screen reader announces, what appears in "an application is asking for…"
   * dialogs) and `g_set_prgname`. Both were left unset under AGS, so AT-SPI
   * listed every Nidara toplevel under an app called "gjs".
   */
  applicationName?: string
  /** Log domain for `console.*` — the prefix in the shell's log. */
  logDomain?: string
  /** CSS file path, resource:// URI, or literal CSS, applied at startup. */
  css?: string
  /** Called once the application is running, with GTK initialised. */
  main?: () => void
}

class NidaraApplication extends Gtk.Application {
  static {
    GObject.registerClass({ GTypeName: "NidaraApplication" }, this)
  }

  #main?: () => void
  #cssProviders: Gtk.CssProvider[] = []

  get #display(): Gdk.Display {
    const display = Gdk.Display.get_default()
    if (!display) throw Error("could not get the default Gdk.Display")
    return display
  }

  /** Every monitor GDK knows about, as a plain array. */
  get_monitors(): Gdk.Monitor[] {
    const model = this.#display.get_monitors() as any
    const list: Gdk.Monitor[] = []
    let monitor: Gdk.Monitor | null = null
    let i = 0
    while ((monitor = model.get_item(i++)) !== null) list.push(monitor)
    return list
  }

  /** Drop every provider added by {@link apply_css}. */
  reset_css(): void {
    for (const provider of this.#cssProviders) {
      Gtk.StyleContext.remove_provider_for_display(this.#display, provider)
    }
    this.#cssProviders = []
  }

  /**
   * Add a stylesheet at USER priority.
   *
   * `style` may be a path to a file, a `resource://` URI, or literal CSS.
   * Providers added later win ties at the same priority, which is how the
   * greeter and the lockscreen layer their accent override on top of the base
   * sheet — keep the call order.
   */
  apply_css(style: string, reset = false): void {
    const provider = new Gtk.CssProvider()

    provider.connect("parsing-error", (_: any, section: any, error: any) => {
      const name = section.get_file()?.get_basename() ?? ""
      const line = section.get_start_location().lines + 1
      const chars = section.get_start_location().line_chars + 1
      console.error(`CSS Error ${name}:${line}:${chars} ${error.message}`)
    })

    if (reset) this.reset_css()

    if (GLib.file_test(style, GLib.FileTest.EXISTS)) provider.load_from_path(style)
    else if (style.startsWith("resource://")) provider.load_from_resource(style.replace("resource://", ""))
    else provider.load_from_string(style)

    Gtk.StyleContext.add_provider_for_display(
      this.#display,
      provider,
      Gtk.STYLE_PROVIDER_PRIORITY_USER,
    )
    this.#cssProviders.push(provider)
  }

  /** Quit and exit the process. */
  quit(code = 0): void {
    super.quit()
    exit(code)
  }

  vfunc_activate(): void {
    // See (3) above. Released by `quit()` exiting the process.
    this.hold()
    this.#main?.()
  }

  /** Configure and run. Does not return until the application quits. */
  start(config: StartConfig): void {
    const { applicationId, applicationName, logDomain, css, main } = config

    this.#main = main
    this.applicationId = applicationId

    // Neither of these affects the Wayland app-id (measured: an explicit
    // `application-id` wins over `prgname`), and neither was ever set under AGS
    // — which is why AT-SPI listed the bar, the dock and Settings as anonymous
    // frames of an app called "gjs", and a screen reader read them out that way.
    GLib.set_prgname(applicationId)
    if (applicationName) GLib.set_application_name(applicationName)
    setConsoleLogDomain(logDomain ?? applicationName ?? applicationId)

    // Before main(): the base sheet must be in place when the first widget is
    // measured, or the first frame lays out against GTK's defaults.
    if (css) this.apply_css(css, false)

    this.run(null)
  }
}

const app = new NidaraApplication({ flags: Gio.ApplicationFlags.DEFAULT_FLAGS })
export default app
