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

export interface AlertHandle {
    /** Close programmatically, responding with `id` (default: the cancel action). */
    close: (id?: string) => void
}

/**
 * showCrystalAlert — modal confirmation dialog
 *
 * Direct replacement for Adw.AlertDialog. Creates and presents a modal
 * Gtk.Window; destroys it after any response (button click or window close).
 * On close-request without an explicit button, the first non-destructive
 * response id is used as the cancel action.
 *
 * With `entry`, a single-line input is shown under the body; its text reaches
 * `onResponse` as the second argument, and Enter triggers the suggested response.
 */
export function showCrystalAlert(opts: {
    parent?: Gtk.Window | null
    heading: string
    body?: string
    responses: AlertResponse[]
    onResponse: (id: string, text?: string) => void
    /** Auto-respond after a countdown (e.g. revert a risky change if not confirmed).
     *  `format(remaining)` renders the body text each tick. */
    countdown?: { seconds: number; respondId: string; format: (remaining: number) => string }
    /** Optional single-line input (PIN / passkey prompts). */
    entry?: { placeholder?: string; digitsOnly?: boolean; maxLength?: number }
}): AlertHandle {
    const { parent, heading, body, responses, onResponse, countdown, entry } = opts

    // ── Window ────────────────────────────────────────────────────────────────
    // transient_for is set post-construction: GJS rejects `undefined` in the
    // initializer, and parentless dialogs (e.g. pairing prompts with Settings
    // hidden) are legitimate.
    const dialog = new Gtk.Window({
        modal: true,
        resizable: false,
        decorated: false,
        default_width: 360,
        css_classes: ["crystal-alert-dialog"],
    })
    if (parent) dialog.transient_for = parent

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

    // Entry (PIN / passkey input)
    let entryWidget: Gtk.Entry | null = null
    if (entry) {
        entryWidget = new Gtk.Entry({
            placeholder_text: entry.placeholder ?? "",
            max_length: entry.maxLength ?? 0,
            input_purpose: entry.digitsOnly ? Gtk.InputPurpose.DIGITS : Gtk.InputPurpose.FREE_FORM,
            css_classes: ["crystal-alert-entry"],
            margin_top: 16,
            margin_start: 24,
            margin_end: 24,
        })
        if (entry.digitsOnly) {
            // input_purpose is only a hint to virtual keyboards — enforce it.
            entryWidget.connect("changed", () => {
                const txt = entryWidget!.text
                const digits = txt.replace(/\D+/g, "")
                if (txt !== digits) entryWidget!.text = digits
            })
        }
        entryWidget.connect("activate", () => {
            const def = responses.find(r => r.suggested) ?? responses[responses.length - 1]
            if (def) respond(def.id)
        })
        root.append(entryWidget)
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
        onResponse(id, entryWidget?.text)
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
    entryWidget?.grab_focus()

    return { close: (id?: string) => respond(id ?? cancelId) }
}
