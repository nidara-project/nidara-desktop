// dock-css-probe — does a change to _dock.scss change any pixel of the dock?
//   gjs -m probe.js <style.css>      then grim, and diff two runs with two stylesheets
// A REPLICA of the dock's widget tree with its real types, classes and names (the real dock
// needs layer-shell and Hyprland): window.nidara-dock-window#nidara-dock > GtkOverlay >
// GtkOverlay.cd-layout > GtkBox.cd-bar > GtkRevealer.cd-revealer > GtkBox.cd-item >
// GtkBox.cd-icon-container > icon, plus the separator. States forced so rules that only
// apply to them get exercised: item 2 :hover (PRELIGHT), item 3 .cd-dragging; the launcher
// is a symbolic icon in a DockIcon (tinted by `.cd-icon` color) and the last slot is the
// Gtk.Image fallback. Second arg `dark|light` picks the token set.
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { DockIcon } from "../../ui/shell/surfaces/dock/DockIcon"
import { withKitSheet } from "../../ui/lib/nidara-kit/platform/kit-css"
import { generateTokensCss, generateChromeTokenScope, DEFAULT_CONFIG } from "../../ui/shell/core/NidaraTheme"

const [css, mode = "dark"] = (globalThis as any).ARGV ?? []
Gtk.init()
const provider = new Gtk.CssProvider()
provider.load_from_string(withKitSheet(css))
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default()!, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 10)
// The --nidara-* tokens ThemeManager injects, dark, so `var()` rules resolve as in the shell.
const tokens = new Gtk.CssProvider()
tokens.load_from_string(generateTokensCss(DEFAULT_CONFIG, mode === "dark") + "\n" + generateChromeTokenScope(DEFAULT_CONFIG, mode === "dark", mode === "dark"))
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default()!, tokens, Gtk.STYLE_PROVIDER_PRIORITY_USER + 30)

const pix = GdkPixbuf.Pixbuf.new_from_file_at_scale("/usr/share/icons/hicolor/scalable/apps/firefox.svg", 128, 128, true)!
const win = new Gtk.Window({ name: "nidara-dock", css_classes: ["nidara-dock-window", "nd-ignore"], default_width: 900, default_height: 200 })
const outer = new Gtk.Overlay()
const layout = new Gtk.Overlay({ name: "cd-layout", css_classes: ["cd-layout"] })
const bar = new Gtk.Box({ name: "cd-bar", css_classes: ["cd-bar"], spacing: 8, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER })

function item(appId: string, icon: Gtk.Widget, state?: "hover" | "dragging") {
    const rev = new Gtk.Revealer({ css_classes: ["cd-revealer"], reveal_child: true, transition_duration: 0 })
    const itemBox = new Gtk.Box({ name: "cd-item-" + appId, css_classes: ["cd-item"], orientation: Gtk.Orientation.VERTICAL })
    const iconBox = new Gtk.Box({ name: "cd-icon-box-" + appId, css_classes: ["cd-icon-container"] })
    icon.set_size_request(64, 64)
    iconBox.append(icon)
    itemBox.append(iconBox)
    const dotZone = new Gtk.Box({ height_request: 8 })
    itemBox.append(dotZone)
    rev.set_child(itemBox)
    if (state === "hover") itemBox.set_state_flags(Gtk.StateFlags.PRELIGHT, false)
    if (state === "dragging") itemBox.add_css_class("cd-dragging")
    bar.append(rev)
}
const dockIcon = (pb = pix, symbolic = false) => { const d = new DockIcon({ valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER, css_classes: ["cd-icon"] }); d.restSize = () => 64; d.setPixbuf(pb, symbolic); return d }
// The launcher as the real dock draws it: a SYMBOLIC file loaded as a pixbuf into DockIcon.
const SYMBOLIC = "/usr/share/icons/Papirus/32x32/symbolic/actions/view-app-grid-symbolic.svg"
item("launcher", dockIcon(GdkPixbuf.Pixbuf.new_from_file_at_scale(SYMBOLIC, 128, 128, true)!, true))
item("firefox", dockIcon())
item("hovered", dockIcon(), "hover")
item("dragging", dockIcon(), "dragging")
const sepC = new Gtk.Box({ css_classes: ["cd-separator-container"] })
sepC.append(new Gtk.Box({ name: "cd-separator", css_classes: ["cd-separator"], width_request: 1, height_request: 40 }))
bar.append(sepC)
item("image-fallback", new Gtk.Image({ icon_name: "application-x-executable", pixel_size: 64 }))

layout.set_child(bar)
outer.set_child(layout)
win.set_child(outer)
win.present()
new GLib.MainLoop(null, false).run()
