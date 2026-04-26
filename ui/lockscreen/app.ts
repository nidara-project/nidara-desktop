import app from "ags/gtk4/app"
import { Gdk, Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import Lock from "./widget/Lock"

try {
  Adw.init()
  Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.PREFER_DARK)
} catch (e) {
  console.warn("[Lock] Adw init:", e)
}

// Share the greeter's compiled CSS
const cssPath = GLib.file_test("/usr/share/crystal-shell/ui/greeter/style.css", GLib.FileTest.EXISTS)
  ? "/usr/share/crystal-shell/ui/greeter/style.css"
  : "../greeter/style.css"

const ACCENT_PALETTE: Record<string, { color: string; rgb: string }> = {
  blue:   { color: "#0088FF", rgb: "0, 136, 255" },
  teal:   { color: "#2190a4", rgb: "33, 144, 164" },
  green:  { color: "#79B757", rgb: "121, 183, 87" },
  yellow: { color: "#F3BA4B", rgb: "243, 186, 75" },
  orange: { color: "#E9873A", rgb: "233, 135, 58" },
  red:    { color: "#ED5F5D", rgb: "237, 95, 93" },
  pink:   { color: "#E55E9C", rgb: "229, 94, 156" },
  purple: { color: "#9A57A3", rgb: "154, 87, 163" },
  slate:  { color: "#6f8396", rgb: "111, 131, 150" },
}

function loadAccentCss(): string {
  try {
    const path = `${GLib.get_user_config_dir()}/crystal-shell/appearance.json`
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return ""
    const cfg = JSON.parse(new TextDecoder().decode(data as Uint8Array))
    const entry = ACCENT_PALETTE[cfg.accent as string]
    if (!entry) return ""
    return `* { --crystal-accent: ${entry.color}; --crystal-accent-rgb: ${entry.rgb}; }`
  } catch {
    return ""
  }
}

app.start({
  instanceName: "crystal-lock",
  css: cssPath,

  main() {
    const display = Gdk.Display.get_default()
    if (!display) { console.error("[Lock] No display"); return }

    // Override accent color from user's shell config
    const accentCss = loadAccentCss()
    if (accentCss) {
      const provider = new Gtk.CssProvider()
      provider.load_from_string(accentCss)
      Gtk.StyleContext.add_provider_for_display(
        display,
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_USER + 1,
      )
    }

    const monitors: any = display.get_monitors()
    const n = monitors.get_n_items()
    for (let i = 0; i < n; i++) {
      try {
        Lock(monitors.get_item(i) as Gdk.Monitor)
      } catch (e) {
        console.error(`[Lock] Failed on monitor ${i}:`, e)
      }
    }
  },
})
