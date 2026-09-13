import Gtk from "gi://Gtk?version=4.0"

/**
 * NidaraBadge — a small pill that states a FACT about the thing beside it.
 *
 * "Isolated", "Not isolated", "custom": a status, not a control — it never takes a
 * click, so it carries no hover state and is not focusable. Neutral on purpose (the
 * accent in this desktop marks selection, never a status), with an optional leading
 * icon when the fact has a symbol of its own (a shield for sandboxing).
 *
 * Born for Settings → Apps (#535), where the same "Isolated" fact appears in the app
 * list, on each app's page and later in a Privacy view: one component, so the three
 * cannot drift into three looks.
 *
 * The icon is a `Gio.Icon` (the shell's `Icons.*`), tinted by `.nd-icon` like every
 * other symbolic icon here — a bundle using it owes an `.nd-icon` rule in its sheet.
 */
export function NidaraBadge(label: string, icon?: any /* Gio.Icon */): Gtk.Box {
    const box = new Gtk.Box({
        spacing: 6,
        valign: Gtk.Align.CENTER,
        css_classes: ["nidara-badge"],
        can_focus: false,
    })
    if (icon) {
        box.append(new Gtk.Image({
            gicon: icon, pixel_size: 14, valign: Gtk.Align.CENTER,
            css_classes: ["nd-icon", "nidara-badge-icon"],
        }))
    }
    box.append(new Gtk.Label({ label, valign: Gtk.Align.CENTER, css_classes: ["nidara-badge-label"] }))
    return box
}
