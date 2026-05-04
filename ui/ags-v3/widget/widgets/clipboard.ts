import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../control-center/Types"
import { WideToggle } from "../control-center/Toggles"
import { makeIconAction } from "./bar-helpers"
import { t } from "../../core/i18n"
import Icons from "../../core/Icons"

// ── cliphist helpers ──────────────────────────────────────────────────────────

interface ClipEntry {
    line: string   // full "id\tcontent" line — passed to cliphist decode
    preview: string
}

async function listEntries(): Promise<ClipEntry[]> {
    try {
        const out = await execAsync(["cliphist", "list"])
        return out
            .split("\n")
            .filter(l => l.trim())
            .slice(0, 20)
            .map(line => {
                const tab = line.indexOf("\t")
                const preview = tab !== -1 ? line.slice(tab + 1) : line
                // Binary/image entries come back as empty or non-printable content
                const clean = preview.replace(/\s+/g, " ").trim()
                return {
                    line,
                    preview: clean || t("widget.clipboard.image"),
                }
            })
    } catch {
        return []
    }
}

function copyEntry(entry: ClipEntry): Promise<string> {
    // cliphist decode reads the full line from stdin, outputs raw bytes
    // then pipe to wl-copy
    return execAsync(["bash", "-c", `printf '%s' ${JSON.stringify(entry.line)} | cliphist decode | wl-copy`])
}

// ── Popover ───────────────────────────────────────────────────────────────────

function buildClipboardPopover(anchor: Gtk.Widget): Gtk.Popover {
    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        min_content_height: 60,
        max_content_height: 360,
        width_request: 300,
    })

    const listBox = new Gtk.ListBox({
        css_classes: ["settings-list-box"],
        selection_mode: Gtk.SelectionMode.NONE,
    })
    scroll.set_child(listBox)

    const emptyLabel = new Gtk.Label({
        label: t("widget.clipboard.empty"),
        css_classes: ["settings-row-subtitle"],
        margin_top: 16,
        margin_bottom: 16,
        margin_start: 16,
        margin_end: 16,
    })

    const stack = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        margin_top: 8,
        margin_bottom: 8,
    })
    stack.append(emptyLabel)
    stack.append(scroll)

    const popover = new Gtk.Popover({ autohide: true })
    popover.set_child(stack)
    popover.set_parent(anchor)
    anchor.connect("unrealize", () => { try { popover.unparent() } catch {} })

    const populate = async () => {
        // Clear list
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }

        const entries = await listEntries()
        emptyLabel.visible = entries.length === 0
        scroll.visible = entries.length > 0

        for (const entry of entries) {
            const btn = new Gtk.Button({
                css_classes: ["settings-action-row"],
                hexpand: true,
                halign: Gtk.Align.FILL,
            })
            const lbl = new Gtk.Label({
                label: entry.preview,
                halign: Gtk.Align.START,
                ellipsize: 3,  // PANGO_ELLIPSIZE_END
                max_width_chars: 36,
                margin_top: 10,
                margin_bottom: 10,
                margin_start: 14,
                margin_end: 14,
                css_classes: ["settings-row-label"],
            })
            btn.set_child(lbl)
            btn.connect("clicked", () => {
                popover.popdown()
                copyEntry(entry).catch(e => console.error("[Clipboard] copy failed:", e))
            })
            const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
            row.set_child(btn)
            listBox.append(row)
        }
    }

    popover.connect("show", populate)
    return popover
}

// ── Bar content ───────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    const image = new Gtk.Image({
        gicon: Icons.clipboard,
        pixel_size: 16,
        margin_start: 16,
        margin_end: 16,
        css_classes: ["cs-icon"],
    })

    const popover = buildClipboardPopover(image)

    const gesture = new Gtk.GestureClick()
    gesture.connect("pressed", () => popover.popup())
    image.add_controller(gesture)

    return image
}

// ── CC content ────────────────────────────────────────────────────────────────

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const btn = new Gtk.Button({
            css_classes: ["cc-atomic-round-btn"],
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            hexpand: true, vexpand: true,
        })
        btn.set_child(new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 28, css_classes: ["cs-icon"] }))
        const popover = buildClipboardPopover(btn)
        btn.connect("clicked", () => popover.popup())
        return btn
    }

    const btn = new Gtk.Button({
        css_classes: ["cc-capsule-btn"],
        halign: Gtk.Align.FILL,
        valign: Gtk.Align.FILL,
        hexpand: true,
        vexpand: true,
    })

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        width_request: 48,
        height_request: 48,
    })
    const icon = new Gtk.Image({
        gicon: Icons.clipboard,
        pixel_size: 28,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        hexpand: true,
        vexpand: true,
        css_classes: ["cs-icon"],
    })
    iconBox.append(icon)

    const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    textStack.append(new Gtk.Label({
        label: t("widget.clipboard.name"),
        css_classes: ["cc-atomic-label-bold"],
        halign: Gtk.Align.START,
    }))
    textStack.append(new Gtk.Label({
        label: t("widget.clipboard.sub.history"),
        css_classes: ["cc-atomic-label-dim"],
        halign: Gtk.Align.START,
    }))

    const inner = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        halign: Gtk.Align.START,
        valign: Gtk.Align.CENTER,
        margin_start: 4,
    })
    inner.append(iconBox)
    inner.append(textStack)
    btn.set_child(inner)

    const popover = buildClipboardPopover(btn)
    btn.connect("clicked", () => popover.popup())

    return btn
}

// ── Widget registration ────────────────────────────────────────────────────────

const clipboardWidget: AtomicWidget = {
    id: "clipboard",
    name: t("widget.clipboard.name"),
    icon: Icons.clipboard,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE],
    buildContent,
    buildBarContent,
}

export default clipboardWidget
