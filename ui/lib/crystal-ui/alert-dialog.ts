import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"

export interface AlertResponse {
    id: string
    label: string
    /** Red / danger styling */
    destructive?: boolean
    /** Accent / suggested-action styling */
    suggested?: boolean
}

/**
 * showCrystalAlert — modal confirmation dialog
 *
 * Direct replacement for Adw.AlertDialog. Creates and presents a modal
 * Gtk.Window; destroys it after any response (button click or window close).
 * On close-request without an explicit button, the first non-destructive
 * response id is used as the cancel action.
 */
export function showCrystalAlert(opts: {
    parent?: Gtk.Window | null
    heading: string
    body?: string
    responses: AlertResponse[]
    onResponse: (id: string) => void
    /** Auto-respond after a countdown (e.g. revert a risky change if not confirmed).
     *  `format(remaining)` renders the body text each tick. */
    countdown?: { seconds: number; respondId: string; format: (remaining: number) => string }
}): void {
    const { parent, heading, body, responses, onResponse, countdown } = opts

    // ── Window ────────────────────────────────────────────────────────────────
    const dialog = new Gtk.Window({
        transient_for: parent ?? undefined,
        modal: true,
        resizable: false,
        decorated: false,
        default_width: 360,
        css_classes: ["crystal-alert-dialog"],
    })

    // ── Layout ────────────────────────────────────────────────────────────────
    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
    })

    // Heading
    root.append(new Gtk.Label({
        label: heading,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["crystal-alert-heading"],
        margin_top: 28,
        margin_start: 24,
        margin_end: 24,
    }))

    // Body (kept as a reference so a countdown can update it live).
    let bodyLabel: Gtk.Label | null = null
    if (body || countdown) {
        bodyLabel = new Gtk.Label({
            label: countdown ? countdown.format(countdown.seconds) : (body ?? ""),
            wrap: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ["crystal-alert-body"],
            margin_top: 8,
            margin_start: 24,
            margin_end: 24,
        })
        root.append(bodyLabel)
    }

    // Separator
    root.append(new Gtk.Separator({
        orientation: Gtk.Orientation.HORIZONTAL,
        css_classes: ["crystal-alert-sep"],
        margin_top: 24,
    }))

    // ── Buttons ───────────────────────────────────────────────────────────────
    const btnBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        homogeneous: true,
        css_classes: ["crystal-alert-buttons"],
    })

    let done = false
    let tickId = 0
    const respond = (id: string) => {
        if (done) return
        done = true
        if (tickId) { GLib.source_remove(tickId); tickId = 0 }
        onResponse(id)
        dialog.destroy()
    }

    // Countdown: tick the body text down each second, auto-respond at zero.
    if (countdown) {
        let remaining = countdown.seconds
        tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            remaining -= 1
            if (remaining <= 0) { tickId = 0; respond(countdown.respondId); return GLib.SOURCE_REMOVE }
            bodyLabel?.set_label(countdown.format(remaining))
            return GLib.SOURCE_CONTINUE
        })
    }

    // Close-request → cancel (first non-destructive response, fallback to first)
    const cancelId = (responses.find(r => !r.destructive) ?? responses[0])?.id ?? ""
    dialog.connect("close-request", () => { respond(cancelId); return true })

    for (const resp of responses) {
        const classes = ["crystal-alert-btn"]
        if (resp.destructive) classes.push("crystal-alert-btn--destructive")
        else if (resp.suggested) classes.push("crystal-alert-btn--suggested")

        const btn = new Gtk.Button({ label: resp.label, css_classes: classes, hexpand: true })
        btn.connect("clicked", () => respond(resp.id))
        btnBox.append(btn)
    }

    root.append(btnBox)
    dialog.set_child(root)
    dialog.present()
}
