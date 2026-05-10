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
    // Pass only the numeric ID — JSON.stringify would escape the real tab in entry.line
    // to \t (literal), which bash double-quotes don't re-expand.
    // printf format-string does expand \t, so we reconstruct id<TAB> safely.
    const tab = entry.line.indexOf("\t")
    const id = tab !== -1 ? entry.line.slice(0, tab) : entry.line
    return execAsync(["bash", "-c", `printf '%s\t' ${JSON.stringify(id)} | cliphist decode | wl-copy`])
}

// ── Shared list builder ───────────────────────────────────────────────────────
// Returns widget + refresh fn; caller decides whether to wrap in a scroll.

function buildClipboardList(onClose: () => void): { widget: Gtk.Widget; refresh: () => void } {
    const listBox = new Gtk.ListBox({ css_classes: ["settings-list-box"], selection_mode: Gtk.SelectionMode.NONE })
    const emptyLabel = new Gtk.Label({
        label: t("widget.clipboard.empty"),
        css_classes: ["settings-row-subtitle"],
        margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16,
    })
    const container = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0, margin_top: 8, margin_bottom: 8 })
    container.append(emptyLabel)
    container.append(listBox)

    const refresh = () => {
        let child = listBox.get_first_child()
        while (child) { listBox.remove(child); child = listBox.get_first_child() }
        listEntries().then(entries => {
            emptyLabel.visible = entries.length === 0
            for (const entry of entries) {
                const btn = new Gtk.Button({ css_classes: ["settings-action-row"], hexpand: true, halign: Gtk.Align.FILL })
                const lbl = new Gtk.Label({
                    label: entry.preview, halign: Gtk.Align.START, ellipsize: 3,
                    max_width_chars: 36, margin_top: 10, margin_bottom: 10,
                    margin_start: 14, margin_end: 14, css_classes: ["settings-row-label"],
                })
                btn.set_child(lbl)
                btn.connect("clicked", () => {
                    onClose()
                    copyEntry(entry).catch(e => console.error("[Clipboard] copy failed:", e))
                })
                const row = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
                row.set_child(btn); listBox.append(row)
            }
        })
    }
    refresh()
    return { widget: container, refresh }
}

// ── Popover / bar expansion (with scroll wrapper) ─────────────────────────────

function buildClipboardContent(onClose: () => void): { widget: Gtk.Widget; refresh: () => void } {
    const { widget: list, refresh } = buildClipboardList(onClose)
    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        propagate_natural_height: true,
        min_content_height: 60,
        max_content_height: 360,
        width_request: 300,
    })
    scroll.set_child(list)
    return { widget: scroll, refresh }
}

// ── Bar content ───────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })
}

function buildBarExpanded(onClose: () => void): Gtk.Widget {
    return buildClipboardContent(onClose).widget
}

function buildCCDetail(onClose: () => void): Gtk.Widget {
    return buildClipboardList(onClose).widget
}

// ── CC content ────────────────────────────────────────────────────────────────

function buildContent(size: WidgetSize): Gtk.Widget {
    if (size === WidgetSize.SINGLE) {
        const box = new Gtk.Box({ hexpand: true, vexpand: true })
        box.append(new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["cs-icon"] }))
        return box
    }

    const iconBox = new Gtk.Box({
        css_classes: ["cc-atomic-icon-circle-bg"],
        halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
        width_request: 48, height_request: 48,
        margin_start: 4,
    })
    iconBox.append(new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["cs-icon"] }))

    const textBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER })
    textBox.append(new Gtk.Label({ label: t("widget.clipboard.name"), css_classes: ["cc-atomic-label-bold"], halign: Gtk.Align.START }))
    textBox.append(new Gtk.Label({ label: t("widget.clipboard.sub.history"), css_classes: ["cc-atomic-label-dim"], halign: Gtk.Align.START }))

    const inner = new Gtk.Box({ spacing: 12, halign: Gtk.Align.FILL, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true })
    inner.append(iconBox)
    inner.append(textBox)
    return inner
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
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 4,
}

export default clipboardWidget
