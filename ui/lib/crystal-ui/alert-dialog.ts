import { Gtk } from "ags/gtk4"

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
}): void {
    const { parent, heading, body, responses, onResponse } = opts

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

    // Body
    if (body) {
        root.append(new Gtk.Label({
            label: body,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ["crystal-alert-body"],
            margin_top: 8,
            margin_start: 24,
            margin_end: 24,
        }))
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
    const respond = (id: string) => {
        if (done) return
        done = true
        onResponse(id)
        dialog.destroy()
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
