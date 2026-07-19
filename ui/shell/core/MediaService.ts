// MediaService — the single source of truth for WHICH MPRIS player the shell shows.
//
// AstalMpris exposes every player on the bus; the media surfaces used to hardcode
// get_players()[0] (= whichever app registered on D-Bus first), so a Spotify
// paused since the morning kept the tile while a YouTube video was audibly
// playing. Same facade pattern as AudioService/NetworkService. This one owns:
//
//   - the AUTO heuristic: prefer a player that is currently PLAYING; among
//     several, the one whose playback status changed most recently ("last
//     active wins"); paused-only players fall back to the same recency order.
//   - the manual PIN: the source selector in the media panel can pin a player
//     (by bus name). The pin holds until that player leaves the bus, then auto
//     selection resumes. Session-scoped on purpose — players don't survive a
//     reboot, so persisting the pin would only pin a ghost.
//   - COVER-ART resolution beyond AstalMpris's cache: `cover_art` only covers
//     art the lib could cache locally. Browsers hand us file:// (works), but
//     Spotify-class players publish https:// and mpv-mpris publishes data: —
//     both rendered as an empty square before this. Resolution chain:
//     cover_art path → file:// → data: (decoded once into our cache) →
//     http(s) (curl'd async into ~/.cache/nidara/media-art, listeners
//     re-notified when the file lands).
//
// Never imports Gtk (core→core only). Consumers subscribe() and re-read
// selectedPlayer()/players(); the widget keeps its own per-player "notify"
// wiring exactly as before.

import AstalMpris from "gi://AstalMpris"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import { execAsync } from "ags/process"
import { safeDisconnect } from "./signals"

// ── Selection state ──────────────────────────────────────────────────────────

let initialized = false
let pinnedBusName: string | null = null
let selected: any = null
const lastActive = new Map<string, number>() // bus_name → monotonic µs of last status flip
const statusSigs = new Map<any, number>()    // player → notify::playback-status handler id
const listeners: Array<() => void> = []

function notifyListeners() {
    listeners.forEach(fn => { try { fn() } catch {} })
}

function computeSelected(): any {
    const list = AstalMpris.get_default()?.get_players() ?? []
    if (list.length === 0) return null
    if (pinnedBusName) {
        const pinned = list.find((p: any) => p.bus_name === pinnedBusName)
        if (pinned) return pinned
        pinnedBusName = null // pinned player left the bus → resume auto
    }
    const rank = (p: any) => ({
        playing: p.playback_status === AstalMpris.PlaybackStatus.PLAYING ? 1 : 0,
        ts: lastActive.get(p.bus_name) ?? 0,
    })
    return [...list].sort((a, b) => {
        const ra = rank(a), rb = rank(b)
        return rb.playing - ra.playing || rb.ts - ra.ts
    })[0]
}

function reevaluate() {
    const next = computeSelected()
    if (next !== selected) {
        selected = next
        notifyListeners()
    }
}

function syncPlayerSubscriptions() {
    const mpris = AstalMpris.get_default()
    const list: any[] = mpris?.get_players() ?? []
    const live = new Set(list)
    for (const [p, id] of statusSigs) {
        if (!live.has(p)) { safeDisconnect(p, id); statusSigs.delete(p) }
    }
    for (const p of list) {
        if (statusSigs.has(p)) continue
        lastActive.set(p.bus_name, GLib.get_monotonic_time())
        statusSigs.set(p, p.connect("notify::playback-status", () => {
            lastActive.set(p.bus_name, GLib.get_monotonic_time())
            reevaluate()
        }))
    }
}

function init() {
    if (initialized) return
    initialized = true
    const mpris = AstalMpris.get_default()
    // Singleton lives for the whole shell process — no disconnect path needed.
    mpris?.connect("notify::players", () => { syncPlayerSubscriptions(); reevaluate() })
    syncPlayerSubscriptions()
    selected = computeSelected()
    pruneArtCache()
}

// ── Public API ───────────────────────────────────────────────────────────────

export function players(): any[] {
    init()
    return AstalMpris.get_default()?.get_players() ?? []
}

export function selectedPlayer(): any {
    init()
    return selected
}

export function pinnedBus(): string | null {
    return pinnedBusName
}

/** Pin a player by bus name (source selector); null returns to auto. */
export function pinPlayer(busName: string | null) {
    init()
    pinnedBusName = busName
    reevaluate()
}

/** Subscribe to "the shown player (or its artwork) changed". Returns unsubscribe. */
export function subscribe(cb: () => void): () => void {
    init()
    listeners.push(cb)
    return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
    }
}

/** Human label for the selector row: app name ("Firefox"), not bus noise. */
export function playerLabel(p: any): string {
    return p?.identity || p?.entry || "Player"
}

/** The player's app icon as a GIcon, or null. The MPRIS DesktopEntry field is
 *  unreliable in the wild (Chromium instances publish "chromium-browser" while
 *  the installed file is chromium.desktop; some players omit it entirely), so
 *  the lookup walks candidates — exact entry, lowercased, the bus-name app
 *  segment (org.mpris.MediaPlayer2.<app>[.instanceN]) — and falls back to a
 *  desktop-file search on the human identity ("Chromium" → chromium.desktop).
 *  Uses GioUnix.DesktopAppInfo: GJS moved it there (GLib ≥ 2.80); the Gio.*
 *  alias still works but logs a Gjs-WARNING with a stack trace per access. */
export function playerAppIcon(p: any): any {
    if (!p) return null
    const candidates: string[] = []
    const entry: string = p.entry || ""
    if (entry) candidates.push(entry, entry.toLowerCase())
    const bus: string = p.bus_name || ""
    const tail = bus.split("org.mpris.MediaPlayer2.")[1] ?? ""
    if (tail) candidates.push(tail, tail.split(".")[0])
    for (const c of candidates) {
        try {
            const icon = GioUnix.DesktopAppInfo.new(`${c}.desktop`)?.get_icon()
            if (icon) return icon
        } catch {}
    }
    const identity: string = p.identity || ""
    if (identity) {
        try {
            const id = GioUnix.DesktopAppInfo.search(identity)[0]?.[0]
            const icon = id ? GioUnix.DesktopAppInfo.new(id)?.get_icon() : null
            if (icon) return icon
        } catch {}
    }
    return null
}

// ── Cover-art resolution ─────────────────────────────────────────────────────

const ART_DIR = `${GLib.get_user_cache_dir()}/nidara/media-art`
const artByUrl = new Map<string, string | null>() // art_url → local path (null = failed)
const artPending = new Set<string>()

function artPath(url: string): string {
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)
    return `${ART_DIR}/${hash}.img`
}

/**
 * Resolve a player's cover art to a LOCAL file path, or null.
 * Synchronous when possible; an http(s) URL kicks off one async download and
 * returns null for now — subscribers are re-notified when the file lands, so
 * the widget's usual loadArt path picks it up.
 */
export function resolveCoverArt(p: any): string | null {
    if (!p) return null
    // 1) AstalMpris already cached it (or the player handed us a local path)
    const cached = p.cover_art
    if (cached && GLib.file_test(cached, GLib.FileTest.EXISTS)) return cached

    const url: string = p.art_url || ""
    if (!url) return null
    if (artByUrl.has(url)) return artByUrl.get(url) ?? null

    if (url.startsWith("file://")) {
        try {
            const [path] = GLib.filename_from_uri(url)
            const ok = !!path && GLib.file_test(path, GLib.FileTest.EXISTS)
            artByUrl.set(url, ok ? path : null)
            return ok ? path! : null
        } catch { artByUrl.set(url, null); return null }
    }

    if (url.startsWith("data:")) {
        // data:image/…;base64,<payload> (mpv-mpris). Decode once into the cache.
        try {
            const comma = url.indexOf(",")
            if (comma < 0 || !url.slice(0, comma).endsWith(";base64")) {
                artByUrl.set(url, null)
                return null
            }
            const bytes = GLib.base64_decode(url.slice(comma + 1))
            GLib.mkdir_with_parents(ART_DIR, 0o755)
            const path = artPath(url)
            GLib.file_set_contents(path, bytes)
            artByUrl.set(url, path)
            return path
        } catch { artByUrl.set(url, null); return null }
    }

    if (url.startsWith("http://") || url.startsWith("https://")) {
        const path = artPath(url)
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            artByUrl.set(url, path)
            return path
        }
        if (!artPending.has(url)) {
            artPending.add(url)
            GLib.mkdir_with_parents(ART_DIR, 0o755)
            // curl: guaranteed on Arch (pacman depends on it); no gvfs/soup needed.
            const tmp = `${path}.part`
            execAsync(["curl", "-fsSL", "--max-time", "10", "--max-filesize", "10485760", "-o", tmp, url])
                .then(() => {
                    Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null)
                    artByUrl.set(url, path)
                })
                .catch(() => {
                    artByUrl.set(url, null) // negative-cache: don't retry at 1 Hz
                    try { Gio.File.new_for_path(tmp).delete(null) } catch {}
                })
                .finally(() => {
                    artPending.delete(url)
                    notifyListeners()
                })
        }
        return null
    }

    artByUrl.set(url, null)
    return null
}

/** Keep the art cache bounded: if it grew past ~150 files, drop the oldest. */
function pruneArtCache() {
    try {
        const dir = Gio.File.new_for_path(ART_DIR)
        const en = dir.enumerate_children("standard::name,time::modified", Gio.FileQueryInfoFlags.NONE, null)
        const entries: Array<{ name: string; mtime: number }> = []
        let info
        while ((info = en.next_file(null)) !== null) {
            entries.push({ name: info.get_name(), mtime: info.get_modification_date_time()?.to_unix() ?? 0 })
        }
        en.close(null)
        if (entries.length <= 150) return
        entries.sort((a, b) => a.mtime - b.mtime)
        for (const e of entries.slice(0, entries.length - 100)) {
            try { dir.get_child(e.name).delete(null) } catch {}
        }
    } catch {} // cache dir may not exist yet — nothing to prune
}
