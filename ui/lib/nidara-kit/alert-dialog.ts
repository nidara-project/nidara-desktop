import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { setTransientForExported } from "./wayland-parent"
import { setWindowAppId } from "../app-id"
import { dialogButtonRow } from "./dialog-buttons"

export interface AlertResponse {
    id: string
    label: string
    /** Red / danger styling */
    destructive?: boolean
    /** Accent / suggested-action styling */
    suggested?: boolean
}

/** A yes/no option shown as a check box under the body; its state reaches `onResponse`. */
export interface AlertChoice {
    id: string
    label: string
    initial?: boolean
}

export interface AlertHandle {
    /** Close programmatically, responding with `id` (default: the cancel action). */
    close: (id?: string) => void
}

/**
 * showNidaraAlert — modal confirmation dialog
 *
 * Direct replacement for Adw.AlertDialog. Creates and presents a modal
 * Gtk.Window; destroys it after any response (button click or window close).
 * On close-request without an explicit button, the first non-destructive
 * response id is used as the cancel action.
 *
 * With `entry`, a single-line input is shown under the body; its text reaches
 * `onResponse` as the second argument, and Enter triggers the suggested response.
 *
 * For a prompt raised on behalf of ANOTHER app (the XDG portal's consent dialogs):
 * `icon` shows who is asking above the heading, `choices` adds check boxes whose
 * state reaches `onResponse` as the third argument, and `parentWindow` takes the
 * portal's `wayland:<handle>` so the dialog sits on the requesting app's window.
 */
export function showNidaraAlert(opts: {
    parent?: Gtk.Window | null
    heading: string
    body?: string
    responses: AlertResponse[]
    onResponse: (id: string, text?: string, choices?: Record<string, string>) => void
    /** Auto-respond after a countdown (e.g. revert a risky change if not confirmed).
     *  `format(remaining)` renders the body text each tick. */
    countdown?: { seconds: number; respondId: string; format: (remaining: number) => string }
    /** Optional single-line input (PIN / passkey prompts). */
    entry?: { placeholder?: string; digitsOnly?: boolean; maxLength?: number }
    /** Who is asking: an icon name or a Gio.Icon, shown above the heading. */
    icon?: string | any | null   // an icon name or a Gio.Icon
    /** Check boxes under the body; `onResponse` gets `{ id: "true" | "false" }`. */
    choices?: AlertChoice[]
    /** A window of ANOTHER process, as an XDG portal passes it (`wayland:<handle>`). */
    parentWindow?: string | null
    /** The Wayland app-id this dialog declares for itself (window rules, window lists). */
    appId?: string
}): AlertHandle {
    const { parent, heading, body, responses, onResponse, countdown, entry, icon, choices, parentWindow, appId } = opts

    // ── Window ────────────────────────────────────────────────────────────────
    // transient_for is set post-construction: GJS rejects `undefined` in the
    // initializer, and parentless dialogs (e.g. pairing prompts with Settings
    // hidden) are legitimate.
    const dialog = new Gtk.Window({
        modal: true,
        resizable: false,
        decorated: false,
        default_width: 360,
        // The heading doubles as the window title: without one a screen reader and
        // the compositor's window list name the dialog after the process.
        title: heading,
        css_classes: ["nidara-alert-dialog"],
    })
    if (appId) setWindowAppId(dialog, appId)
    if (parent) dialog.transient_for = parent
    else if (parentWindow) setTransientForExported(dialog, parentWindow)

    // ── Layout ────────────────────────────────────────────────────────────────
    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
    })

    // Icon (who is asking)
    if (icon) {
        const image = typeof icon === "string"
            ? Gtk.Image.new_from_icon_name(icon)
            : Gtk.Image.new_from_gicon(icon)
        image.pixel_size = 48
        image.margin_top = 24
        image.add_css_class("nidara-alert-icon")
        root.append(image)
    }

    // Heading
    root.append(new Gtk.Label({
        label: heading,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["nidara-alert-heading"],
        margin_top: icon ? 12 : 28,
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
            css_classes: ["nidara-alert-body"],
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
            css_classes: ["nidara-alert-entry"],
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

    // Choices (check boxes)
    const checks = new Map<string, Gtk.CheckButton>()
    if (choices && choices.length > 0) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 16,
            margin_start: 24,
            margin_end: 24,
            css_classes: ["nidara-alert-choices"],
        })
        for (const c of choices) {
            const check = new Gtk.CheckButton({ label: c.label, active: c.initial === true })
            checks.set(c.id, check)
            box.append(check)
        }
        root.append(box)
    }
    const choiceState = (): Record<string, string> =>
        Object.fromEntries([...checks].map(([id, check]) => [id, check.active ? "true" : "false"]))

    let done = false
    let tickId = 0
    const respond = (id: string) => {
        if (done) return
        done = true
        if (tickId) { GLib.source_remove(tickId); tickId = 0 }
        onResponse(id, entryWidget?.text, choiceState())
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

    // ── Buttons ───────────────────────────────────────────────────────────────
    root.append(dialogButtonRow(responses, respond).box)
    dialog.set_child(root)
    dialog.present()
    entryWidget?.grab_focus()

    return { close: (id?: string) => respond(id ?? cancelId) }
}
