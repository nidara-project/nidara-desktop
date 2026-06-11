import { Gtk } from "ags/gtk4"
import { PANEL_W } from "../common/widget-kit"
import { execAsync } from "ags/process"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"

import { t } from "../core/i18n"
import Icons from "../core/Icons"

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
    const tab = entry.line.indexOf("\t")
    const id = tab !== -1 ? entry.line.slice(0, tab) : entry.line
    return execAsync(["bash", "-c", `printf '%s\t' ${JSON.stringify(id)} | cliphist decode | wl-copy`])
}

// ── Shared list builder ───────────────────────────────────────────────────────

function buildClipboardList(onClose: () => void): { widget: Gtk.Widget; refresh: () => void } {
    const entriesBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    const emptyLabel = new Gtk.Label({
        label: t("widget.clipboard.empty"),
        css_classes: ["crystal-row-subtitle"],
        margin_top: 16, margin_bottom: 16,
        halign: Gtk.Align.CENTER,
    })

    const refresh = () => {
        let child = entriesBox.get_first_child()
        while (child) { entriesBox.remove(child); child = entriesBox.get_first_child() }

        listEntries().then(entries => {
            if (entries.length === 0) {
                entriesBox.append(emptyLabel)
                return
            }
            for (const entry of entries) {
                const lbl = new Gtk.Label({
                    label: entry.preview, halign: Gtk.Align.START, ellipsize: 3,
                    max_width_chars: 36, css_classes: ["crystal-row-title"],
                })
                const btn = new Gtk.Button({
                    css_classes: ["crystal-menu-row"],
                    hexpand: true, halign: Gtk.Align.FILL,
                    child: lbl,
                })
                btn.connect("clicked", () => {
                    onClose()
                    copyEntry(entry).catch(e => console.error("[Clipboard] copy failed:", e))
                })
                entriesBox.append(btn)
            }
        })
    }
    refresh()
    return { widget: entriesBox, refresh }
}

// ── Bar expansion (with scroll wrapper) ──────────────────────────────────────

function buildClipboardContent(onClose: () => void): Gtk.Widget {
    const { widget: list } = buildClipboardList(onClose)
    const scroll = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        propagate_natural_height: true,
        min_content_height: 60,
        max_content_height: 360,
        width_request: PANEL_W.xl,
    })
    scroll.set_child(list)
    return scroll
}

// ── Bar content ───────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["cs-icon"] })
}

function buildBarExpanded(onClose: () => void): Gtk.Widget {
    return buildClipboardContent(onClose)
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

    return wrapCapsuleTile(buildCapsuleInner(() => Icons.clipboard, () => t("widget.clipboard.name"), () => t("widget.clipboard.sub.history")).box)
}

// ── Widget registration ────────────────────────────────────────────────────────

const clipboardWidget: AtomicWidget = {
    id: "clipboard",
    name: t("widget.clipboard.name"),
    icon: Icons.clipboard,
    locations: ["bar", "cc"],
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 4,
}

export default clipboardWidget
