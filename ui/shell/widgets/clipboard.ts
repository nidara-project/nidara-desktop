import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { PANEL_W } from "../common/widget-kit"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"

import { t } from "../core/i18n"
import Icons from "../core/Icons"

// ── cliphist helpers ──────────────────────────────────────────────────────────

interface ClipEntry {
    line: string   // full "id\tcontent" line — passed to cliphist decode
    preview: string
}

// cliphist prints the RAW BYTES it stored, and every text-mode way of reading a
// process here — Astal's execAsync, Gio's communicate_utf8 — marshals stdout
// through a NUL-terminated C string. So ONE entry saved as UTF-16 (an app that
// publishes its selection that way: ASCII interleaved with NULs) truncated the
// WHOLE listing at its first NUL. Measured: 49151 bytes / 750 lines arrived as
// the six characters `1035\th`, so the panel showed a single mystery entry named
// "h" and the rest of the history looked wiped — which is what made it read as
// data loss rather than as a rendering bug (user-caught 2026-08-03).
//
// Read the BYTES and drop the C0 controls before decoding: no single clip can
// hide the others again, and the UTF-16 case decodes to readable ASCII for free.
// Tab and newline stay — they are cliphist's field and record separators.
function readList(): Promise<string> {
    return new Promise((resolve, reject) => {
        let proc: Gio.Subprocess
        try {
            proc = Gio.Subprocess.new(["cliphist", "list"], Gio.SubprocessFlags.STDOUT_PIPE)
        } catch (e) { reject(e); return }
        proc.communicate_async(null, null, (_s: any, res: any) => {
            try {
                const [, stdout] = proc.communicate_finish(res)
                const bytes = stdout?.get_data()
                if (!bytes) { resolve(""); return }
                const kept = bytes.filter(b => b === 0x09 || b === 0x0A || (b >= 0x20 && b !== 0x7F))
                resolve(new TextDecoder().decode(kept))
            } catch (e) { reject(e) }
        })
    })
}

async function listEntries(): Promise<ClipEntry[]> {
    try {
        const out = await readList()
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

/** Run `argv`, feeding it `input` on stdin, and resolve with its raw stdout. */
function runBytes(argv: string[], input: Uint8Array | null, wantStdout: boolean): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        let proc: Gio.Subprocess
        const flags = Gio.SubprocessFlags.STDIN_PIPE
            | (wantStdout ? Gio.SubprocessFlags.STDOUT_PIPE : Gio.SubprocessFlags.NONE)
        try { proc = Gio.Subprocess.new(argv, flags) }
        catch (e) { reject(e); return }
        proc.communicate_async(input ? new GLib.Bytes(input) : null, null, (_s: any, res: any) => {
            try {
                const [, stdout] = proc.communicate_finish(res)
                resolve(stdout?.get_data() ?? new Uint8Array(0))
            } catch (e) { reject(e) }
        })
    })
}

/** `"utf-16le"`/`"utf-16be"` if these bytes are UTF-16 text, else null.
 *
 *  cliphist stores bytes and no MIME type, so a clip an app published as UTF-16
 *  comes back as UTF-16 and `wl-copy` re-offers it as plain text — which is why
 *  the entry above pasted as NOTHING into every UTF-8 text field. Text in the
 *  ASCII range puts a NUL in every code unit's high byte, at ODD offsets little
 *  endian and EVEN offsets big endian, so the test is most of the pairs plus a
 *  clean parity split. A stray NUL inside genuine text cannot reach that, and
 *  binary clips cannot either: cliphist previews those as "[[ binary data … ]]"
 *  and their bytes have NULs at both parities. */
function utf16Encoding(bytes: Uint8Array): string | null {
    if (bytes.length < 4) return null
    let even = 0, odd = 0
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 0) continue
        if (i % 2 === 0) even++; else odd++
    }
    const pairs = Math.floor(bytes.length / 2)
    if (even === 0 && odd > pairs * 0.8) return "utf-16le"
    if (odd === 0 && even > pairs * 0.8) return "utf-16be"
    return null
}

async function copyEntry(entry: ClipEntry): Promise<void> {
    const tab = entry.line.indexOf("\t")
    const id = tab !== -1 ? entry.line.slice(0, tab) : entry.line
    // `cliphist decode` reads the id (tab-terminated) from stdin.
    const raw = await runBytes(["cliphist", "decode"], new TextEncoder().encode(`${id}\t`), true)
    const enc = utf16Encoding(raw)
    // Only re-encode what we positively identified; everything else — including
    // every image — goes back to the clipboard byte for byte.
    const payload = enc ? new TextEncoder().encode(new TextDecoder(enc).decode(raw)) : raw
    await runBytes(["wl-copy"], payload, false)
}

// ── Shared list builder ───────────────────────────────────────────────────────

function buildClipboardList(onClose: () => void): { widget: Gtk.Widget; refresh: () => void } {
    const entriesBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
    const emptyLabel = new Gtk.Label({
        label: t("widget.clipboard.empty"),
        css_classes: ["nidara-row-subtitle"],
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
                    max_width_chars: 36, css_classes: ["nidara-row-title"],
                })
                const btn = new Gtk.Button({
                    css_classes: ["nidara-menu-row"],
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
    return new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
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
        box.append(new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 28, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, hexpand: true, vexpand: true, css_classes: ["nd-icon"] }))
        return box
    }

    // Action tile (no on/off state) → no status subtitle; just the name.
    return wrapCapsuleTile(buildCapsuleInner(() => Icons.clipboard, () => t("widget.clipboard.name"), () => "").box)
}

// ── Widget registration ────────────────────────────────────────────────────────

const clipboardWidget: AtomicWidget = {
    id: "clipboard",
    category: "utilities",
    barOrder: 40,
    name: t("widget.clipboard.name"),
    icon: Icons.clipboard,
    locations: ["bar", "cc"],
    defaultInCc: false,   // off by default — optional/power feature; available to add
    defaultSize: WidgetSize.WIDE,
    supportedSizes: [WidgetSize.SINGLE, WidgetSize.WIDE, WidgetSize.SQUARE],
    buildContent,
    buildBarContent,
    buildBarExpanded,
    buildCCDetail,
    ccDetailRows: 4,
}

export default clipboardWidget
