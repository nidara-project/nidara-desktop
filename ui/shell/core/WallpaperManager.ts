import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gdk from "gi://Gdk?version=4.0"
import GdkPixbuf from "gi://GdkPixbuf"
import { execAsync } from "../../lib/process"
import { writeFile } from "../../lib/file"
import { readWallpaperConfig, resolveWallpaper } from "../../lib/wallpaper"
import { t } from "./i18n"
import { fireHook } from "./Hooks"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/nidara/wallpaper`
const THUMB_CACHE_DIR = `${GLib.get_user_cache_dir()}/nidara/wallpaper-thumbs`
const MAX_THUMB_CACHE_ENTRIES = 120
const MAX_MEM_CACHE_ENTRIES = 24

/**
 * Generate a cache key and file path based on file path, mtime, size and target dimensions.
 * Using mtime and size guarantees invalidation if an image file is edited in-place.
 */
function getCacheKeyAndPath(srcPath: string, width: number, height: number): { key: string; cachePath: string } | null {
    if (!srcPath || !GLib.file_test(srcPath, GLib.FileTest.EXISTS)) return null
    try {
        const file = Gio.File.new_for_path(srcPath)
        const info = file.query_info("time::modified,time::modified-usec,standard::size", Gio.FileQueryInfoFlags.NONE, null)
        const mtimeSec = info.get_attribute_uint64("time::modified")
        const mtimeUsec = info.get_attribute_uint32("time::modified-usec")
        const size = info.get_size()
        const key = `${srcPath}:${mtimeSec}:${mtimeUsec}:${size}:${width}x${height}`
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1)
        return {
            key,
            cachePath: `${THUMB_CACHE_DIR}/${hash}.png`,
        }
    } catch {
        return null
    }
}

/**
 * Widest a `preview` copy is ever decoded to.
 *
 * The desktop wallpaper is whatever the user picked — a 4K photo is normal, and
 * decoding one at full size costs ~33 MB of pixels to draw something 300 px
 * wide. The biggest consumer is an overview card; 960 leaves headroom for a 2×
 * scale factor and for the card getting wider later, and costs ~2 MB decoded
 * (measured) instead of ~33. It is a BOUND, not a size: a smaller wallpaper is
 * never upscaled.
 */
const PREVIEW_MAX_W = 960

export type TransitionType =
    | "simple" | "fade" | "random" | "center" | "grow"
    | "outer" | "wipe" | "wave" | "left" | "right" | "top" | "bottom"

export const TRANSITION_LABELS: Record<TransitionType, string> = {
    random: t("wallpaper.transition.random"),
    simple: t("wallpaper.transition.simple"),
    fade:   t("wallpaper.transition.fade"),
    center: t("wallpaper.transition.center"),
    grow:   t("wallpaper.transition.grow"),
    outer:  t("wallpaper.transition.outer"),
    wipe:   t("wallpaper.transition.wipe"),
    wave:   t("wallpaper.transition.wave"),
    left:   t("wallpaper.transition.left"),
    right:  t("wallpaper.transition.right"),
    top:    t("wallpaper.transition.top"),
    bottom: t("wallpaper.transition.bottom"),
}

class WallpaperManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "WallpaperManager",
            // "changed": the desktop wallpaper was set. "preview": the decoded
            // copy below arrived (or was replaced) — a different moment, because
            // the decode is asynchronous and lands long after the wallpaper did.
            Signals: { "changed": {}, "preview": {} },
        }, this)
    }

    private _current: string = ""
    private _transition: TransitionType = "random"
    private _preview: any = null
    private _previewPath = ""
    private _previewLoading = false
    private _bgSettings: any = null
    private _syncingGsettings = false
    private _memThumbCache = new Map<string, Gdk.Texture>()
    private _pendingThumbLoads = new Map<string, Promise<Gdk.Texture | null>>()

    constructor() {
        super()
        this._loadSaved()
        this._initGsettingsSync()
        this.pruneThumbnailCache()
    }

    get current() { return this._current }
    get transition() { return this._transition }

    private _getMemCache(key: string): Gdk.Texture | null {
        const tex = this._memThumbCache.get(key)
        if (tex) {
            // Refresh LRU order: re-insert at end
            this._memThumbCache.delete(key)
            this._memThumbCache.set(key, tex)
            return tex
        }
        return null
    }

    private _setMemCache(key: string, tex: Gdk.Texture) {
        if (this._memThumbCache.has(key)) {
            this._memThumbCache.delete(key)
        } else if (this._memThumbCache.size >= MAX_MEM_CACHE_ENTRIES) {
            // Evict oldest entry (first key in map iteration order)
            const oldestKey = this._memThumbCache.keys().next().value
            if (oldestKey !== undefined) {
                this._memThumbCache.delete(oldestKey)
            }
        }
        this._memThumbCache.set(key, tex)
    }

    private _initGsettingsSync() {
        try {
            this._bgSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.background" })
            const onGsettingsChange = () => {
                if (this._syncingGsettings || !this._bgSettings) return
                const uriDark = this._bgSettings.get_string("picture-uri-dark")
                const uri = uriDark || this._bgSettings.get_string("picture-uri")
                if (!uri) return
                let path: string | null = null
                if (uri.startsWith("file://")) {
                    try {
                        const [p] = GLib.filename_from_uri(uri)
                        path = p
                    } catch (_) {
                        path = decodeURIComponent(uri.replace(/^file:\/\//, ""))
                    }
                } else if (uri.startsWith("/")) {
                    path = uri
                }
                if (path && path !== this._current && GLib.file_test(path, GLib.FileTest.EXISTS)) {
                    console.log(`[WallpaperManager] Detected external background change via gsettings: ${path}`)
                    this.setWallpaper(path)
                }
            }
            this._bgSettings.connect("changed::picture-uri", onGsettingsChange)
            this._bgSettings.connect("changed::picture-uri-dark", onGsettingsChange)
        } catch (e) {
            console.warn("[WallpaperManager] org.gnome.desktop.background schema not available:", e)
        }
    }

    private _syncToGsettings(path: string) {
        if (!this._bgSettings) return
        try {
            this._syncingGsettings = true
            const uri = GLib.filename_to_uri(path, null)
            if (uri) {
                if (this._bgSettings.get_string("picture-uri") !== uri) this._bgSettings.set_string("picture-uri", uri)
                if (this._bgSettings.get_string("picture-uri-dark") !== uri) this._bgSettings.set_string("picture-uri-dark", uri)
            }
        } catch (e) {
            console.warn("[WallpaperManager] Failed to sync wallpaper to gsettings:", e)
        } finally {
            this._syncingGsettings = false
        }
    }

    private _loadSaved() {
        // `path` is stored only as a hint for the Settings preview — awww restores
        // the last wallpaper on its own via `awww restore` on session start.
        const data = readWallpaperConfig()
        this._current = data.path ?? ""
        this._transition = (data.transition as TransitionType) ?? "random"
    }

    private _save() {
        const dir = `${GLib.get_user_config_dir()}/nidara`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        // Merge over the existing file: the schema reserves per-surface override
        // keys this manager doesn't own (see ui/lib/wallpaper.ts) — a plain
        // overwrite would wipe them every time the desktop wallpaper changes.
        const existing = readWallpaperConfig()
        writeFile(CONFIG_PATH, JSON.stringify({ ...existing, path: this._current, transition: this._transition }))
    }

    async setWallpaper(path: string, transition?: TransitionType) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            console.error(`[WallpaperManager] File not found: ${path}`)
            return
        }
        const t = transition ?? this._transition
        this._current = path
        this._transition = t
        this._save()
        this._syncToGsettings(path)
        try {
            await execAsync(["awww", "img", path, "--transition-type", t])
            this.emit("changed")
            fireHook("wallpaper-changed", path)
            // The surfaces that paint the wallpaper are closed right now — reheat
            // here rather than making each of them re-check on open.
            this.warmPreview()
            console.log(`[WallpaperManager] Set: ${path} (${t})`)
        } catch (e) {
            console.error("[WallpaperManager] awww error:", e)
        }
    }

    setTransition(t: TransitionType) {
        this._transition = t
        this._save()
    }

    /** Preview a transition by clearing to black then re-applying current wallpaper. */
    async previewTransition(t: TransitionType) {
        this._transition = t
        this._save()
        if (!this._current || !GLib.file_test(this._current, GLib.FileTest.EXISTS)) return
        try {
            await execAsync(["awww", "clear"])
            await execAsync(["awww", "img", this._current, "--transition-type", t])
            this.emit("changed")
        } catch (e) {
            console.error("[WallpaperManager] previewTransition error:", e)
        }
    }

    /** Parse current wallpaper from `awww query` output */
    async queryCurrentFromDaemon(): Promise<string> {
        try {
            const out = await execAsync(["awww", "query"])
            // output: ": DP-1: 2560x1440, ..., currently displaying: image: /path/to/img.jpg"
            const match = out.match(/currently displaying: image: (.+)/)
            return match?.[1]?.trim() ?? ""
        } catch (_) { return "" }
    }

    /**
     * A decoded, size-bounded copy of the wallpaper, for the surfaces that PAINT
     * the desktop instead of setting it (the workspace schematic's backdrop).
     * `null` until `warmPreview()` has finished a load — every consumer needs a
     * fallback for that window, and for a session with no usable image at all.
     */
    get preview() { return this._preview }

    /**
     * Decode the wallpaper into `preview`, off the main loop, and emit "preview".
     *
     * Re-resolves the path from disk on every call rather than trusting
     * `_current`: the wallpaper also changes behind this manager's back — gaming
     * hero-art swaps it through hyprland.lua, and `_current` is only a hint the
     * config carries (awww owns the live one). A call whose path and cached copy
     * already agree is free, so surfaces can just warm on open and self-heal.
     *
     * The old copy is kept until the new one lands: painting the previous
     * wallpaper for a few frames is better than blinking to flat black.
     */
    warmPreview() {
        const path = resolveWallpaper("shell")
        if (!path || this._previewLoading) return
        if (this._preview && this._previewPath === path) return
        this._previewLoading = true

        // Two async hops on purpose: gdk-pixbuf's stream loader decodes in a
        // worker thread, and a 4K JPEG decoded synchronously is a ~100 ms stall
        // of the shell's main loop — i.e. a visible hitch in whatever animation
        // happens to be running when a surface opens.
        Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, null, (file: any, res: any) => {
            let stream: any
            try { stream = file.read_finish(res) } catch (e) {
                this._previewLoading = false
                console.warn(`[WallpaperManager] preview open failed: ${e}`)
                return
            }
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream, PREVIEW_MAX_W, -1, true, null,
                (_src: any, res2: any) => {
                    this._previewLoading = false
                    try {
                        this._preview = GdkPixbuf.Pixbuf.new_from_stream_finish(res2)
                        this._previewPath = path
                        this.emit("preview")
                    } catch (e) {
                        console.warn(`[WallpaperManager] preview decode failed: ${e}`)
                    }
                })
        })
    }

    /**
     * Return a size-bounded, decoded Gdk.Texture for any image on disk,
     * decoding asynchronously in a worker thread and caching to disk.
     *
     * ── Why decode sizes are bounded to 2× the box (640×360 / 160×90) ──
     * A full 4K wallpaper (3840×2160) is ~17–33 MB uncompressed in memory.
     * The Settings window hides rather than destroys on close, so any texture
     * decoded into memory stays resident for the entire lifetime of the shell.
     * Decoding to 2× the display box (640×360 for 320×180 preview; 160×90 for
     * 80×45 thumbnails) provides crisp rendering on HiDPI displays while
     * keeping memory bounded to ~0.9 MB / ~50 KB per texture instead of ~33 MB.
     * DO NOT raise these bounds to full resolution.
     *
     * 1. Check in-memory LRU cache (instant, capped at MAX_MEM_CACHE_ENTRIES).
     * 2. Check on-disk cache (~0.25 ms PNG read, bypasses full 4K decode).
     * 3. Cache miss: decode via gdk-pixbuf async stream loader in worker thread,
     *    write scaled PNG to disk cache, and cache in memory.
     */
    async getThumbnailTexture(srcPath: string, width: number, height: number): Promise<Gdk.Texture | null> {
        const cacheInfo = getCacheKeyAndPath(srcPath, width, height)
        if (!cacheInfo) return null

        const { key, cachePath } = cacheInfo

        // 1. Memory cache hit (LRU order refreshed)
        const memHit = this._getMemCache(key)
        if (memHit) return memHit

        // 2. In-flight load deduplication
        const pending = this._pendingThumbLoads.get(key)
        if (pending) return pending

        const loadPromise = (async (): Promise<Gdk.Texture | null> => {
            // 3. Disk cache hit
            if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
                try {
                    const file = Gio.File.new_for_path(cachePath)
                    const texture = Gdk.Texture.new_from_file(file)
                    this._setMemCache(key, texture)

                    // Touch cache file mtime so disk pruning preserves recently used items (LRU)
                    try {
                        const nowSec = Math.floor(GLib.get_real_time() / 1000000)
                        file.set_attribute_uint64("time::modified", nowSec, Gio.FileQueryInfoFlags.NONE, null)
                    } catch (_) {}

                    return texture
                } catch (e) {
                    console.warn(`[WallpaperManager] reading cached thumb failed: ${e}`)
                }
            }

            // 4. Cache miss: decode asynchronously in worker thread
            return new Promise<Gdk.Texture | null>((resolve) => {
                const file = Gio.File.new_for_path(srcPath)
                file.read_async(GLib.PRIORITY_DEFAULT, null, (_f: any, res: any) => {
                    let stream: any
                    try {
                        stream = file.read_finish(res)
                    } catch (e) {
                        resolve(null)
                        return
                    }
                    GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                        stream, width, height, true, null,
                        (_src: any, res2: any) => {
                            try {
                                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res2)
                                if (!pixbuf) { resolve(null); return }
                                const texture = Gdk.Texture.new_for_pixbuf(pixbuf)
                                this._setMemCache(key, texture)

                                // Asynchronously persist scaled thumbnail to disk cache
                                try {
                                    if (!GLib.file_test(THUMB_CACHE_DIR, GLib.FileTest.EXISTS)) {
                                        GLib.mkdir_with_parents(THUMB_CACHE_DIR, 0o755)
                                    }
                                    const [ok, buffer] = pixbuf.save_to_bufferv("png", [], [])
                                    if (ok && buffer) {
                                        const cacheFile = Gio.File.new_for_path(cachePath)
                                        cacheFile.replace_contents_bytes_async(
                                            new GLib.Bytes(buffer),
                                            null,
                                            false,
                                            Gio.FileCreateFlags.REPLACE_DESTINATION,
                                            null,
                                            (_f: any, res3: any) => {
                                                try {
                                                    cacheFile.replace_contents_finish(res3)
                                                } catch (err) {
                                                    console.warn(`[WallpaperManager] saving thumb to disk cache failed: ${err}`)
                                                }
                                                resolve(texture)
                                            }
                                        )
                                        return
                                    }
                                } catch (err) {
                                    console.warn(`[WallpaperManager] saving thumb to disk cache failed: ${err}`)
                                }

                                resolve(texture)
                            } catch (e) {
                                console.warn(`[WallpaperManager] thumb decode failed for ${srcPath}: ${e}`)
                                resolve(null)
                            }
                        }
                    )
                })
            })
        })().finally(() => {
            this._pendingThumbLoads.delete(key)
        })

        this._pendingThumbLoads.set(key, loadPromise)
        return loadPromise
    }

    /**
     * Evict thumbnail cache entries if the total count exceeds MAX_THUMB_CACHE_ENTRIES,
     * removing the oldest entries by modification/last-accessed time.
     * Note: Pruning runs in an idle callback during startup to avoid adding work
     * to the initial load, so new entries exceeding the cap are pruned on subsequent sessions.
     */
    pruneThumbnailCache() {
        if (!GLib.file_test(THUMB_CACHE_DIR, GLib.FileTest.IS_DIR)) return
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            try {
                const dir = Gio.File.new_for_path(THUMB_CACHE_DIR)
                const enumerator = dir.enumerate_children("standard::name,time::modified", Gio.FileQueryInfoFlags.NONE, null)
                const files: Array<{ file: any; mtime: number }> = []
                let info
                while ((info = enumerator.next_file(null)) !== null) {
                    const child = enumerator.get_child(info)
                    files.push({
                        file: child,
                        mtime: info.get_attribute_uint64("time::modified"),
                    })
                }
                if (files.length > MAX_THUMB_CACHE_ENTRIES) {
                    // Sort oldest first
                    files.sort((a, b) => a.mtime - b.mtime)
                    const toDelete = files.slice(0, files.length - MAX_THUMB_CACHE_ENTRIES)
                    for (const item of toDelete) {
                        try { item.file.delete(null) } catch {}
                    }
                }
            } catch (e) {
                console.warn("[WallpaperManager] pruneThumbnailCache error:", e)
            }
            return GLib.SOURCE_REMOVE
        })
    }

    async refreshFromDaemon() {
        if (!this._current) {
            const path = await this.queryCurrentFromDaemon()
            if (path) {
                this._current = path
                this._save()
                this.emit("changed")
                this.warmPreview()
            }
        }
    }
}

export const Wallpaper = new WallpaperManager()
export default Wallpaper

