import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import IconButton from "../../common/IconButton"
import status from "../../core/Status"
import hs from "../../core/HyprlandState"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"
import { SHELL_ROOT } from "../../core/Paths"
import { safeDisconnect } from "../../core/signals"

// ── Helpers ────────────────────────────────────────────────────────────────────

function readOsRelease(field: string): string {
    try {
        const [ok, bytes] = GLib.file_get_contents("/etc/os-release")
        if (!ok) return "Unknown"
        const text = new TextDecoder().decode(bytes)
        const m = text.match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))
        return m ? m[1].trim() : "Unknown"
    } catch { return "Unknown" }
}

function readCpu(): string {
    try {
        const [ok, bytes] = GLib.file_get_contents("/proc/cpuinfo")
        if (!ok) return "Unknown"
        const text = new TextDecoder().decode(bytes)
        const m = text.match(/^model name\s*:\s*(.+)$/m)
        if (!m) return "Unknown"
        return m[1].trim()
            .replace(/\(R\)|\(TM\)/g, "")
            .replace(/\s+CPU\s+/, " ")
            .replace(/\s+@\s+[\d.]+GHz/, "")
            .replace(/\s+/g, " ")
            .trim()
    } catch { return "Unknown" }
}

function readRam(): string {
    try {
        const [ok, bytes] = GLib.file_get_contents("/proc/meminfo")
        if (!ok) return "Unknown"
        const text = new TextDecoder().decode(bytes)
        const m = text.match(/^MemTotal:\s+(\d+)\s+kB/m)
        if (!m) return "Unknown"
        const gb = Math.round(parseInt(m[1]) / 1024 / 1024)
        return `${gb} GB`
    } catch { return "Unknown" }
}

// ── Row builders ───────────────────────────────────────────────────────────────

function specRow(label: string, value: string): Gtk.Box {
    const box = new Gtk.Box({ spacing: 0, margin_top: 4, margin_bottom: 4 })
    box.append(new Gtk.Label({ label, css_classes: ["about-spec-key"], halign: Gtk.Align.START, width_request: 80, xalign: 0 }))
    box.append(new Gtk.Label({ label: value, css_classes: ["about-spec-val"], halign: Gtk.Align.START, hexpand: true, xalign: 0, ellipsize: 3 }))
    return box
}

function asyncSpecRow(label: string, src: string[] | Promise<string>): Gtk.Box {
    const val = new Gtk.Label({ label: "…", css_classes: ["about-spec-val"], halign: Gtk.Align.START, hexpand: true, xalign: 0, ellipsize: 3 })
    const promise = Array.isArray(src) ? execAsync(src) : src
    promise.then(v => { val.label = v.trim() || "—" }).catch(() => { val.label = "—" })
    const box = new Gtk.Box({ spacing: 0, margin_top: 4, margin_bottom: 4 })
    box.append(new Gtk.Label({ label, css_classes: ["about-spec-key"], halign: Gtk.Align.START, width_request: 80, xalign: 0 }))
    box.append(val)
    return box
}

// ── Singleton guard ─────────────────────────────────────────────────────────────
let _instance: Gtk.Window | null = null

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Creates and presents the About window. If already open, brings it to front.
 * The window is DESTROYED (not hidden) on close so it doesn't block `ags quit`.
 * Call this from a status.connect("notify::about-open") listener in app.ts.
 */
export default function AboutWindow(): Gtk.Window | null {
    if (_instance) {
        _instance.present()
        return _instance
    }

    const osName = readOsRelease("PRETTY_NAME")
    const cpu    = readCpu()
    const ram    = readRam()

    // ── Header ────────────────────────────────────────────────────────────────
    // The Nidara mark, not a `distributor-logo-<id>` theme icon: that depends on
    // whatever icon pack is installed and renders broken on a clean machine (e.g.
    // the VM has no Arch distributor logo). Our own mark always resolves and is
    // mode-aware (recoloured to --nidara-text via .about-logo). 72px is a big
    // surface so the flattened-but-faithful symbolic mark looks identical to the goo.
    const markPath = `${SHELL_ROOT}/assets/nidara/assets/nidara-symbolic.svg`
    const headerBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, halign: Gtk.Align.CENTER, margin_bottom: 16 })
    headerBox.append(new Gtk.Image({ gicon: Gio.FileIcon.new(Gio.File.new_for_path(markPath)), pixel_size: 72, css_classes: ["about-logo"], halign: Gtk.Align.CENTER }))
    headerBox.append(new Gtk.Label({ label: "Nidara", css_classes: ["about-shell-name"], halign: Gtk.Align.CENTER }))
    headerBox.append(new Gtk.Label({ label: osName, css_classes: ["about-os-name"], halign: Gtk.Align.CENTER }))

    // ── Specs ─────────────────────────────────────────────────────────────────
    // Device (hostname) first, like GNOME/Windows About — it disambiguates the
    // machine's name from "Nidara" in the header (which is the OS, not the box).
    const specsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, margin_top: 8, margin_bottom: 8, margin_start: 16, margin_end: 16 })
    specsBox.append(specRow(t("settings.about.device"), GLib.get_host_name()))
    specsBox.append(specRow(t("settings.about.cpu"), cpu))
    specsBox.append(specRow(t("settings.about.ram"), ram))
    specsBox.append(asyncSpecRow(t("settings.about.graphics"), ["bash", "-c",
        "lspci 2>/dev/null | grep -i 'vga\\|3d\\|display' | head -1 | sed 's/.*: //' | sed 's/(.*)//' | xargs || echo '—'"
    ]))
    specsBox.append(asyncSpecRow(t("settings.about.kernel"), ["uname", "-r"]))
    specsBox.append(asyncSpecRow(t("settings.about.uptime"), ["bash", "-c", "uptime -p | sed 's/^up //'"] ))

    // ── Versions ──────────────────────────────────────────────────────────────
    const verBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, margin_top: 8, margin_bottom: 8, margin_start: 16, margin_end: 16 })
    verBox.append(asyncSpecRow(t("settings.about.hyprland"), hs.version()))
    verBox.append(specRow("AGS", "v3 (GJS + GTK4)"))

    // ── Close button ──────────────────────────────────────────────────────────
    // Same kit IconButton as the Settings header close. margin_top 12 + the
    // card's margin_top 12 = 24px top gap, equal to the card's 24px end margin
    // (the corner-diagonal rule the Settings close follows too).
    const closeBtn = IconButton({
        icon: Icons.close,
        iconSize: 14,
        variant: "danger",
        tooltip: t("settings.about.close"),
        tooltipChrome: false,   // app-mode window: tooltip follows the system mode
        halign: Gtk.Align.END,
        onClick: () => { status.about_open = false },
    })
    closeBtn.margin_top = 12

    // ── Card ──────────────────────────────────────────────────────────────────
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 12, margin_bottom: 24, margin_start: 24, margin_end: 24, width_request: 380 })
    card.append(closeBtn)
    card.append(headerBox)
    card.append(specsBox)
    card.append(new Gtk.Separator({ css_classes: ["about-sep"], margin_top: 8, margin_bottom: 8 }))
    card.append(verBox)

    // Window chrome = the SAME CSS glass as Settings (.nidara-window-glass →
    // glass(floating)), NOT a Cairo SquircleContainer. A real window already gets
    // Hyprland's 1px border + rounding at its rect; the Cairo card was drawn 2px
    // inside that rect (drawSquircle techInset) and gloss paints its own 1px
    // specular rims regardless of borderColor — together they read as a double
    // border no borderColor tweak can turn off. The CSS route also makes the
    // About follow the user's window-opacity token instead of a hardcoded alpha.
    const glass = new Gtk.Box({ css_classes: ["nidara-window-glass", "about-window-card"] })
    glass.append(card)

    // ── Window ────────────────────────────────────────────────────────────────
    const win = new Gtk.Window({
        name: "nidara-about",
        application: app,
        title: "About Nidara",
        css_classes: ["about-floating-window"],
        decorated: false,
        resizable: false,
    })
    win.set_child(glass)
    _instance = win

    // Float + center come from a static window rule in hyprland.lua (matched by the
    // "About Nidara" title). The old `hyprctl keyword windowrulev2` calls here
    // were rejected by the Lua parser ("Use eval.") and have been removed.

    // Escape key
    const escKey = new Gtk.EventControllerKey()
    escKey.connect("key-pressed", (_c, keyval) => {
        if (keyval === 65307) { status.about_open = false; return true }
        return false
    })
    win.add_controller(escKey)

    // On close: destroy window (not hide) so it doesn't block `ags quit`
    win.connect("close-request", () => {
        _instance = null
        status.about_open = false
        return false  // allow GTK default destroy
    })

    // If status is set to false externally, destroy the window
    const sigId = status.connect("notify::about-open", () => {
        if (!status.about_open && _instance === win) {
            safeDisconnect(status, sigId)
            _instance = null
            win.destroy()
        }
    })

    win.present()
    return win
}
