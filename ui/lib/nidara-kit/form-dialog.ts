import Gtk from "gi://Gtk?version=4.0"
import { setWindowAppId } from "../app-id"

export interface FormResponse {
    id: string
    label: string
    /** Red / danger styling */
    destructive?: boolean
    /** Accent / suggested-action styling */
    suggested?: boolean
    /** Initial button sensitivity (default: true) */
    sensitive?: boolean
}

export interface FormDialogHandle {
    readonly window: Gtk.Window
    close: (id?: string) => void
    setResponseSensitive: (id: string, sensitive: boolean) => void
    setResponseLabel: (id: string, label: string) => void
}

export interface NidaraFormDialogOpts {
    parent?: Gtk.Window | null
    title?: string
    heading: string
    body?: string
    appId?: string
    width?: number
    content: Gtk.Widget
    responses: FormResponse[]
    onResponse?: (id: string, handle: FormDialogHandle) => void
}

/**
 * showNidaraFormDialog — modal form dialog with floating glass styling.
 *
 * Universal form dialog primitive for nidara-kit. Creates and presents an
 * undecorated, floating-glass modal Gtk.Window with a header (heading + subtitle),
 * a body slot for arbitrary form inputs, a horizontal separator, and a footer
 * response button row matching `showNidaraAlert`.
 */
export function showNidaraFormDialog(opts: {
    parent?: Gtk.Window | null
    title?: string
    heading: string
    body?: string
    appId?: string
    width?: number
    content: Gtk.Widget
    responses: FormResponse[]
    onResponse?: (id: string, handle: FormDialogHandle) => void
}): FormDialogHandle {
    const { parent, title, heading, body, appId, width, content, responses, onResponse } = opts

    // ── Window ────────────────────────────────────────────────────────────────
    const dialog = new Gtk.Window({
        title: title ?? heading,
        modal: true,
        resizable: false,
        decorated: false,
        default_width: width ?? 380,
        css_classes: ["nidara-alert-dialog", "nidara-form-dialog"],
    })
    setWindowAppId(dialog, appId ?? "nidara-settings")
    if (parent) dialog.set_transient_for(parent)

    // ── Layout ────────────────────────────────────────────────────────────────
    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
    })

    // Heading
    root.append(new Gtk.Label({
        label: heading,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ["nidara-alert-heading"],
        margin_top: 24,
        margin_start: 24,
        margin_end: 24,
    }))

    // Subtitle / Body (optional)
    if (body) {
        root.append(new Gtk.Label({
            label: body,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ["nidara-alert-body"],
            margin_top: 8,
            margin_start: 24,
            margin_end: 24,
        }))
    }

    // Content container slot
    const contentBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_start: 24,
        margin_end: 24,
        margin_top: 16,
        margin_bottom: 20,
    })
    contentBox.append(content)
    root.append(contentBox)

    // Separator
    root.append(new Gtk.Separator({
        orientation: Gtk.Orientation.HORIZONTAL,
        css_classes: ["nidara-alert-sep"],
    }))

    // ── Buttons ───────────────────────────────────────────────────────────────
    const btnBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        homogeneous: true,
        css_classes: ["nidara-alert-buttons"],
    })

    const buttonMap = new Map<string, Gtk.Button>()
    let isClosed = false

    const cancelId = (responses.find(r => !r.destructive) ?? responses[0])?.id ?? ""

    const handle: FormDialogHandle = {
        window: dialog,
        close: (_id?: string) => {
            if (isClosed) return
            isClosed = true
            dialog.destroy()
        },
        setResponseSensitive: (id: string, sensitive: boolean) => {
            const btn = buttonMap.get(id)
            if (btn) btn.sensitive = sensitive
        },
        setResponseLabel: (id: string, label: string) => {
            const btn = buttonMap.get(id)
            if (btn) btn.label = label
        },
    }

    const triggerResponse = (id: string) => {
        if (isClosed) return
        if (onResponse) {
            onResponse(id, handle)
        } else {
            handle.close(id)
        }
    }

    // Close-request / Escape → cancel action
    dialog.connect("close-request", () => {
        triggerResponse(cancelId)
        return true
    })

    for (const resp of responses) {
        const classes = ["nidara-alert-btn"]
        if (resp.destructive) classes.push("nidara-alert-btn--destructive")
        else if (resp.suggested) classes.push("nidara-alert-btn--suggested")

        const btn = new Gtk.Button({
            label: resp.label,
            css_classes: classes,
            hexpand: true,
            sensitive: resp.sensitive !== false,
        })
        btn.connect("clicked", () => triggerResponse(resp.id))
        buttonMap.set(resp.id, btn)
        btnBox.append(btn)
    }

    root.append(btnBox)
    dialog.set_child(root)
    dialog.present()

    return handle
}
