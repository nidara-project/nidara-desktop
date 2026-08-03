import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import { squircleThumb } from "../common/DrawingUtils"
import { menuRow, menuSeparator } from "../common/MenuRow"
import IconButton from "../common/IconButton"
import { NidaraScrolled } from "../../lib/nidara-kit"
import { PANEL_W } from "../common/widget-kit"
import { AtomicWidget, WidgetSize } from "../surfaces/control-center/Types"
import { buildCapsuleInner, wrapCapsuleTile } from "../surfaces/control-center/Toggles"

import { t } from "../core/i18n"
import Icons from "../core/Icons"

// ── cliphist helpers ──────────────────────────────────────────────────────────

interface ClipEntry {
    line: string   // full "id\tcontent" line — passed to cliphist decode
    id: string
    preview: string
    image: { w: number, h: number } | null   // source dimensions when this row is an image
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

// cliphist has no thumbnail concept: an image row arrives as the literal preview
// `[[ binary data 24 KiB jpeg 1920x1080 ]]` (verified against cliphist 0.7.0 with a
// throwaway -db-path). Non-image binary is NOT wrapped like this — it comes through
// raw, which readList()'s C0 filter already tidies — so matching the exact shape is
// safe. Show the human half (kind · format · dimensions); the byte count says less
// about which screenshot this is than the dimensions do.
const BINARY_PREVIEW = /^\[\[ binary data \S+ \S+ (\w+) (\d+)x(\d+) \]\]$/

// The panel shows everything cliphist keeps — retention is set at the capture end
// (`-max-items` on the store command in hyprland.lua), and keeping history the user
// cannot reach is exactly the thing that made the db grow to 60 MB unnoticed. The cap
// here is a safety net for a hand-edited limit, not the product decision.
const MAX_ROWS = 200

// What Bar.tsx gives every other expansion panel. We take it over (barExpandedFlush)
// so the scroll can reach the panel edge, then re-apply it to the content — keep the
// two in step or this panel drifts from every other one.
const PANEL_PAD = 14

async function listEntries(): Promise<ClipEntry[]> {
    try {
        const out = await readList()
        return out
            .split("\n")
            .filter(l => l.trim())
            .slice(0, MAX_ROWS)
            .map(line => {
                const tab = line.indexOf("\t")
                const id = tab !== -1 ? line.slice(0, tab) : line
                const preview = tab !== -1 ? line.slice(tab + 1) : line
                const clean = preview.replace(/\s+/g, " ").trim()
                const m = BINARY_PREVIEW.exec(clean)
                return {
                    line,
                    id,
                    preview: m
                        ? `${t("widget.clipboard.image")} · ${m[1].toUpperCase()} · ${m[2]}×${m[3]}`
                        : clean || t("widget.clipboard.image"),
                    image: m ? { w: Number(m[2]), h: Number(m[3]) } : null,
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

// ── Thumbnails ────────────────────────────────────────────────────────────────

const THUMB = 32          // px; keeps an image row close to a text row's height
const THUMB_RADIUS = 8

// The panel rebuilds its whole list on every open, and decoding a 2560×1440
// screenshot is not free — cache by cliphist id so reopening is instant. Bounded
// because ids never repeat: without the cap a long session would pin every
// screenshot the user ever copied in memory.
const thumbCache = new Map<string, any>()
const THUMB_CACHE_MAX = 40

/** Decoded, downscaled pixbuf for an image entry — null if it isn't decodable. */
async function loadThumb(entry: ClipEntry): Promise<any> {
    if (thumbCache.has(entry.id)) return thumbCache.get(entry.id)
    const raw = await runBytes(["cliphist", "decode"], new TextEncoder().encode(`${entry.id}\t`), true)
    if (raw.length === 0) return null
    const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(raw))
    // Scale against the SHORTER side (-1 on the other axis) so the cover-fit crop
    // always has enough pixels: a bounding box would give a 2560×100 panorama a
    // 2px-tall thumbnail. ×2 for HiDPI, same as the notification hero.
    const land = entry.image!.w >= entry.image!.h
    const w = land ? -1 : THUMB * 2
    const h = land ? THUMB * 2 : -1
    const pixbuf = await new Promise<any>(resolve => {
        // _async keeps the decode off the main loop — 20 image rows decoded
        // synchronously would visibly stall the panel as it opens.
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, w, h, true, null, (_s: any, res: any) => {
            try { resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res)) } catch { resolve(null) }
        })
    })
    if (pixbuf) {
        if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value!)
        thumbCache.set(entry.id, pixbuf)
    }
    return pixbuf
}

/** Drop one entry. `cliphist delete` takes the id on stdin, tab-terminated — the
 *  same shape `decode` takes, and it matches on the id ALONE (verified against a
 *  throwaway db, including entries whose content holds NULs). That matters here:
 *  our `line` has been through readList's C0 filter, so it is NOT byte-identical to
 *  what cliphist printed and could never be echoed back for a content match. */
async function deleteEntry(entry: ClipEntry): Promise<void> {
    thumbCache.delete(entry.id)
    await runBytes(["cliphist", "delete"], new TextEncoder().encode(`${entry.id}\t`), false)
}

async function wipeHistory(): Promise<void> {
    thumbCache.clear()
    await runBytes(["cliphist", "wipe"], null, false)
}

async function copyEntry(entry: ClipEntry): Promise<void> {
    // `cliphist decode` reads the id (tab-terminated) from stdin.
    const raw = await runBytes(["cliphist", "decode"], new TextEncoder().encode(`${entry.id}\t`), true)
    const enc = utf16Encoding(raw)
    // Only re-encode what we positively identified; everything else — including
    // every image — goes back to the clipboard byte for byte. wl-copy runs xdg-mime
    // over the content it reads on stdin, so a decoded PNG is re-offered as image/png
    // (verified) — no --type needed, and guessing one would be worse.
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
                    label: entry.preview, halign: Gtk.Align.START, hexpand: true, ellipsize: 3,
                    max_width_chars: 36, css_classes: ["nidara-row-title"],
                })
                let child: Gtk.Widget = lbl
                if (entry.image) {
                    // The dimensions alone don't identify anything — five screenshots
                    // of the same monitor read as five identical rows. Reserve the slot
                    // at full size up front and fill it when the decode lands, so the
                    // list never reflows under the pointer.
                    const slot = new Gtk.Box({
                        width_request: THUMB, height_request: THUMB, valign: Gtk.Align.CENTER,
                    })
                    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, hexpand: true })
                    row.append(slot); row.append(lbl)
                    child = row
                    loadThumb(entry).then(pixbuf => {
                        // refresh() may have torn this row down while we decoded.
                        if (!pixbuf || !slot.get_parent()) return
                        slot.append(squircleThumb(pixbuf, THUMB, THUMB, THUMB_RADIUS, "clip-thumb"))
                    }).catch(() => { })
                }
                // Per-row delete. captureClick so the press never reaches the row's own
                // "copy and close" handler, and the slot stays ALLOCATED at rest (opacity
                // 0 + can_target false, not visible=false) so revealing it on hover cannot
                // reflow the row under the pointer — same recipe as the notification rows.
                const del = IconButton({
                    icon: Icons.close, iconSize: 12, variant: "danger", captureClick: true,
                    valign: Gtk.Align.CENTER,
                    tooltip: t("widget.clipboard.delete"),
                    onClick: () => {
                        deleteEntry(entry)
                            .then(refresh)
                            .catch(e => console.error("[Clipboard] delete failed:", e))
                    },
                })
                del.opacity = 0; del.can_target = false

                const rowBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, hexpand: true })
                rowBox.append(child)
                rowBox.append(del)

                const btn = new Gtk.Button({
                    css_classes: ["nidara-menu-row"],
                    hexpand: true, halign: Gtk.Align.FILL,
                    child: rowBox,
                })
                const hover = new Gtk.EventControllerMotion()
                hover.connect("enter", () => { del.opacity = 1; del.can_target = true })
                hover.connect("leave", () => { del.opacity = 0; del.can_target = false })
                btn.add_controller(hover)
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

// ── Clear-all footer ─────────────────────────────────────────────────────────

/** "Clear history" that swaps IN PLACE into a cancel/confirm pair. A modal would be
 *  wrong here: the panel is a popover that dismisses on outside click, so a dialog
 *  over it closes the very surface it is asking about. Same inline-confirm shape and
 *  tones as the bar's system menu (logout/shutdown). */
function buildClearFooter(refresh: () => void): Gtk.Widget {
    const host = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    const show = (child: Gtk.Widget) => {
        const cur = host.get_first_child()
        if (cur) host.remove(cur)
        host.append(child)
    }

    const confirmRow = new Gtk.Box({ spacing: 6, homogeneous: true })
    const cancelBtn = new Gtk.Button({
        label: t("widget.clipboard.clear.cancel"),
        css_classes: ["nidara-menu-row", "nidara-confirm-secondary"], hexpand: true,
    })
    const confirmBtn = new Gtk.Button({
        label: t("widget.clipboard.clear.confirm"),
        css_classes: ["nidara-menu-row", "nidara-confirm-primary", "danger-action"], hexpand: true,
    })
    confirmRow.append(cancelBtn); confirmRow.append(confirmBtn)

    const clearRow = menuRow({
        label: t("widget.clipboard.clear"), icon: Icons.trash, danger: true, center: true,
        onClick: () => show(confirmRow),
    })
    cancelBtn.connect("clicked", () => show(clearRow))
    confirmBtn.connect("clicked", () => {
        show(clearRow)
        wipeHistory().then(refresh).catch(e => console.error("[Clipboard] wipe failed:", e))
    })

    show(clearRow)
    return host
}

// ── Panels ───────────────────────────────────────────────────────────────────

// Both surfaces compose the same three things — list, separator, clear-all — but
// only the bar popover owns its scroll, so only there can the footer be PINNED
// below it. The CC detail is wrapped in IslandGrid's scroll (widgets must not add
// their own), so its footer rides at the end of the list instead. Same position,
// same order; the difference is who owns the viewport, not the design.
function buildClipboardContent(onClose: () => void): Gtk.Widget {
    const { widget: list, refresh } = buildClipboardList(onClose)
    // NidaraScrolled, not Gtk.ScrolledWindow: every row carries a ✕ at its right
    // edge, and GTK's overlay slider grows toward the pointer as it approaches,
    // eating that button's hit area (tech-debt #15).
    // barExpandedFlush: the scroll reaches the panel's inner edge so the bar sits
    // there, per the shell-wide rule. The 14px the panel used to give us moves onto
    // the CONTENT — and the bar's 12px lane fits inside that inset, so an expanded
    // pill still never reaches a row's ✕. reserveLane off: the inset already is one.
    list.margin_start = PANEL_PAD
    list.margin_end = PANEL_PAD
    const { widget: scroll } = NidaraScrolled({
        child: list,
        reserveLane: false,
        propagateNaturalHeight: true,
        minContentHeight: 60,
        maxContentHeight: 360,
        widthRequest: PANEL_W.xl + PANEL_PAD * 2,
    })

    const sep = menuSeparator()
    sep.margin_start = PANEL_PAD; sep.margin_end = PANEL_PAD
    const footer = buildClearFooter(refresh)
    footer.margin_start = PANEL_PAD; footer.margin_end = PANEL_PAD

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    box.append(scroll)
    box.append(sep)
    box.append(footer)
    return box
}

// ── Bar content ───────────────────────────────────────────────────────────────

function buildBarContent(): Gtk.Widget {
    return new Gtk.Image({ gicon: Icons.clipboard, pixel_size: 16, margin_start: 16, margin_end: 16, css_classes: ["nd-icon"] })
}

function buildBarExpanded(onClose: () => void): Gtk.Widget {
    return buildClipboardContent(onClose)
}

function buildCCDetail(onClose: () => void): Gtk.Widget {
    const { widget: list, refresh } = buildClipboardList(onClose)
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    box.append(list)
    box.append(menuSeparator())
    box.append(buildClearFooter(refresh))
    return box
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
    barExpandedFlush: true,
    buildCCDetail,
    ccDetailRows: 4,
}

export default clipboardWidget
