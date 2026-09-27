// Development mode only: a CRITICAL in the shell's own log becomes a CRITICAL
// notification — never expires, cuts through Do Not Disturb.
//
// Why: on 2026-09-27 a read of the log found 2821 texture CRITICALs a day
// (dropdown chevrons, broken since #636), a game-mode push failing on every start
// since #576 and a dead accessibility bus — none of it visible on screen, all of it
// sitting in a file nobody reads. A failed toolkit assertion draws nothing wrong at
// the moment it happens; the developer has to be TOLD.
//
// How:
//   - Only when `~/.config/nidara/.dev` exists AND our stderr is a regular file —
//     i.e. nidara-ui started us and we are writing `nidara-ui.log`. `npm run dev` in
//     a terminal already shows everything, and a release never watches anything.
//   - Gio monitors the file; appends are debounced, and only the NEW bytes are
//     scanned (a storm of WARNINGs costs a read, never a subprocess).
//   - The grouping is `nidara-doctor --log` from the checkout, the one
//     implementation of "which kinds, how many": the notification shows the kinds
//     since this start, and it is posted again (replacing itself, one notification
//     per run) only when a NEW kind appears — a CRITICAL firing 2821 times is one
//     notification, not 2821.
//   - ⚠️ This module's own failures go to console.warn, NEVER console.error: that
//     would be a CRITICAL in the log it watches, and it would wake itself forever.
//   - A toolkit CRITICAL names the C function that refused (`gtk_widget_is_ancestor:
//     assertion … failed`), never OUR line that led there — which is why one like
//     that sat unexplained in the log for days. `traceToolkitCriticals()` hooks
//     GLib's log handler for the toolkit domains: GLib's own line is written
//     unchanged (the doctor groups by it), then a `[DevLogWatch] … ← <frame>`
//     warning with the JS stack at that moment. Measured 2026-09-27: a bad
//     `Box.append` from JS reports the calling function and line; a CRITICAL that
//     GTK raises from its own event or frame processing has no JS on the stack,
//     and says so — that is a clue too (look at what was destroyed just before).
//
// ⚠️ SHELL ONLY, started once from app.ts after the notification server.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "../../lib/process"
import { t } from "./i18n"

const DEBOUNCE_MS = 1500
const MARK = "-CRITICAL **"

let started = false
let monitor: Gio.FileMonitor | null = null // held: an unreferenced monitor stops firing

/** The checkout nidara-ui runs us from, or null outside development mode. */
function devRepo(): string | null {
    try {
        const [ok, bytes] = GLib.file_get_contents(`${GLib.get_home_dir()}/.config/nidara/.dev`)
        const dir = ok ? new TextDecoder().decode(bytes).trim() : ""
        return dir && GLib.file_test(`${dir}/bin/nidara-doctor`, GLib.FileTest.IS_EXECUTABLE) ? dir : null
    } catch { return null }
}

/** The file our stderr is appended to, or null (a terminal, a pipe, the journal). */
function stderrFile(): string | null {
    try {
        const path = GLib.file_read_link("/proc/self/fd/2")
        return path.startsWith("/") && GLib.file_test(path, GLib.FileTest.IS_REGULAR) ? path : null
    } catch { return null }
}

function sizeOf(file: Gio.File): number {
    try { return file.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null).get_size() }
    catch { return 0 }
}

/** GLib log domains whose CRITICALs are failed toolkit assertions. */
const TOOLKIT_DOMAINS = ["Gtk", "Gdk", "Gsk", "GLib", "GLib-GObject", "GLib-GIO", "Pango"]
const MAX_FRAMES = 12

/** See the header. The handler must never throw: an exception inside a GLib log
 *  handler logs a CRITICAL from inside the handler, which GLib reports as recursion. */
function traceToolkitCriticals(): void {
    for (const domain of TOOLKIT_DOMAINS) {
        GLib.log_set_handler(domain, GLib.LogLevelFlags.LEVEL_CRITICAL, (d, level, msg) => {
            try {
                GLib.log_default_handler(d, level, msg, null)
                const frames = (new Error().stack ?? "").split("\n").slice(1).filter(Boolean)
                const where = frames[0] ?? "no JS on the stack (GTK's own event/frame processing)"
                const rest = frames.slice(1, MAX_FRAMES).map(f => `\n    ${f}`).join("")
                console.warn(`[DevLogWatch] ${msg} ← ${where}${rest}`)
            } catch { /* see above: never throw from here */ }
        })
    }
}

/** Idempotent: a second call does nothing. */
export function startDevLogWatch(): void {
    if (started) return
    started = true
    const repo = devRepo()
    const logPath = stderrFile()
    if (!repo || !logPath) return
    traceToolkitCriticals()

    const file = Gio.File.new_for_path(logPath)
    let offset = sizeOf(file)
    let timer = 0
    let shownKinds = ""
    let notifId = 0

    const report = async () => {
        let out: string
        try { out = await execAsync([`${repo}/bin/nidara-doctor`, "--log", logPath]) }
        catch (e) { console.warn("[DevLogWatch] nidara-doctor --log:", e); return }
        // "   N  <first message of the kind>", most frequent first.
        const kinds = out.split("\n").filter(l => l.includes(MARK))
        const names = kinds.map(l => l.replace(/^\s*\d+\s+/, "")).sort().join("\n")
        if (!kinds.length || names === shownKinds) return
        shownKinds = names

        const title = kinds.length === 1
            ? t("dev.log.critical.one")
            : t("dev.log.critical.other").replace("%d", String(kinds.length))
        const lines = kinds.slice(0, 3).map(l => {
            const s = l.trim()
            return GLib.markup_escape_text(s.length > 140 ? `${s.slice(0, 139)}…` : s, -1)
        })
        const body = [...lines, t("dev.log.critical.hint")].join("\n")
        const args = ["notify-send", "-u", "critical", "-a", "Nidara (dev)", "-p"]
        if (notifId > 0) args.push("-r", String(notifId))
        try {
            const id = parseInt(await execAsync([...args, title, body]), 10)
            if (id > 0) notifId = id
        } catch (e) { console.warn("[DevLogWatch] notify-send:", e) }
    }

    const scan = () => {
        timer = 0
        const size = sizeOf(file)
        if (size < offset) offset = 0 // truncated or replaced
        if (size === offset) return GLib.SOURCE_REMOVE
        let text = ""
        try {
            const stream = file.read(null)
            stream.seek(offset, GLib.SeekType.SET, null)
            const bytes = stream.read_bytes(size - offset, null)
            stream.close(null)
            text = new TextDecoder().decode(bytes.toArray())
        } catch (e) { console.warn("[DevLogWatch] read:", e) }
        offset = size
        if (text.includes(MARK)) void report()
        return GLib.SOURCE_REMOVE
    }

    try {
        monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null)
        monitor.connect("changed", () => {
            if (!timer) timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, DEBOUNCE_MS, scan)
        })
    } catch (e) { console.warn("[DevLogWatch] monitor:", e); return }

    // What fired before this module started — GTK's own init, the first
    // services — is in the file already: the doctor reads from the start marker.
    void report()
}
