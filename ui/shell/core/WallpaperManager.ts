import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { writeFile } from "ags/file"
import { readWallpaperConfig } from "../../lib/wallpaper"
import { t } from "./i18n"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/nidara/wallpaper`

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
            Signals: { "changed": {} },
        }, this)
    }

    private _current: string = ""
    private _transition: TransitionType = "random"

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

    async refreshFromDaemon() {
        if (!this._current) {
            const path = await this.queryCurrentFromDaemon()
            if (path) {
                this._current = path
                this._save()
                this.emit("changed")
            }
        }
    }
}

export const Wallpaper = new WallpaperManager()
export default Wallpaper
