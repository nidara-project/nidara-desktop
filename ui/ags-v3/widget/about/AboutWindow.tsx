import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import SquircleContainer from "../common/SquircleContainer"
import status from "../../core/Status"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

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

function asyncSpecRow(label: string, cmd: string[]): Gtk.Box {
    const val = new Gtk.Label({ label: "…", css_classes: ["about-spec-val"], halign: Gtk.Align.START, hexpand: true, xalign: 0, ellipsize: 3 })
    execAsync(cmd).then(v => { val.label = v.trim() }).catch(() => { val.label = "—" })
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
    const osId   = readOsRelease("ID")
    const cpu    = readCpu()
    const ram    = readRam()

    // ── Header ────────────────────────────────────────────────────────────────
    const headerBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, halign: Gtk.Align.CENTER, margin_bottom: 16 })
    headerBox.append(new Gtk.Image({ icon_name: `distributor-logo-${osId}`, pixel_size: 72, css_classes: ["about-logo"], halign: Gtk.Align.CENTER }))
    headerBox.append(new Gtk.Label({ label: "Crystal Shell", css_classes: ["about-shell-name"], halign: Gtk.Align.CENTER }))
    headerBox.append(new Gtk.Label({ label: osName, css_classes: ["about-os-name"], halign: Gtk.Align.CENTER }))

    // ── Specs ─────────────────────────────────────────────────────────────────
    const specsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, margin_top: 8, margin_bottom: 8, margin_start: 16, margin_end: 16 })
    specsBox.append(specRow(t("settings.about.row.label.cpu"), cpu))
    specsBox.append(specRow(t("settings.about.row.label.memoria-ram"), ram))
    specsBox.append(asyncSpecRow(t("settings.about.row.label.graficos"), ["bash", "-c",
        "lspci 2>/dev/null | grep -i 'vga\\|3d\\|display' | head -1 | sed 's/.*: //' | sed 's/(.*)//' | xargs || echo '—'"
    ]))
    specsBox.append(asyncSpecRow(t("settings.about.row.label.kernel"), ["uname", "-r"]))
    specsBox.append(asyncSpecRow(t("settings.about.row.label.tiempo-activo"), ["bash", "-c", "uptime -p | sed 's/^up //'"] ))

    // ── Versions ──────────────────────────────────────────────────────────────
    const verBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, margin_top: 8, margin_bottom: 8, margin_start: 16, margin_end: 16 })
    verBox.append(asyncSpecRow(t("settings.about.row.label.hyprland"), ["bash", "-c",
        "hyprctl version 2>/dev/null | grep -oP 'v?[\\d]+\\.[\\d]+\\.[\\d]+' | head -1 || echo '—'"
    ]))
    verBox.append(specRow("AGS", "v3 (GJS + GTK4)"))

    // ── Close button ──────────────────────────────────────────────────────────
    const closeBtn = new Gtk.Button({
        child: new Gtk.Image({ gicon: Icons.close, pixel_size: 14 , css_classes: ["cs-icon"] }),
        css_classes: ["about-close-btn"],
        halign: Gtk.Align.END,
        tooltip_text: t("settings.about.label.cerrar"),
    })
    closeBtn.connect("clicked", () => { status.about_open = false })

    // ── Card ──────────────────────────────────────────────────────────────────
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 12, margin_bottom: 24, margin_start: 24, margin_end: 24, width_request: 380 })
    card.append(closeBtn)
    card.append(headerBox)
    card.append(specsBox)
    card.append(new Gtk.Separator({ css_classes: ["about-sep"], margin_top: 8, margin_bottom: 8 }))
    card.append(verBox)

    const squircle = SquircleContainer({ child: card, radius: 24, gloss: true, alpha: 0.18, borderColor: { r: 1, g: 1, b: 1, a: 0.08 }, css_classes: ["about-window-card"] })

    // ── Window ────────────────────────────────────────────────────────────────
    const win = new Gtk.Window({
        name: "crystal-about",
        application: app,
        title: "About Crystal Shell",
        css_classes: ["about-floating-window"],
        decorated: false,
        resizable: false,
    })
    win.set_child(squircle)
    _instance = win

    // Hyprland: float and center
    execAsync(["hyprctl", "keyword", "windowrulev2", "float, title:^(About Crystal Shell)$"]).catch(() => {})
    execAsync(["hyprctl", "keyword", "windowrulev2", "center, title:^(About Crystal Shell)$"]).catch(() => {})

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
            status.disconnect(sigId)
            _instance = null
            win.destroy()
        }
    })

    win.present()
    return win
}
