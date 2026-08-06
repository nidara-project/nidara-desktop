import GObject from "gi://GObject"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import { execAsync } from "ags/process"
import { writeFile } from "ags/file"
import { readWallpaperConfig, resolveWallpaper } from "../../lib/wallpaper"
import { t } from "./i18n"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/nidara/wallpaper`

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

    constructor() {
        super()
        this._loadSaved()
    }

    get current() { return this._current }
    get transition() { return this._transition }

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
        try {
            await execAsync(["awww", "img", path, "--transition-type", t])
            this.emit("changed")
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
