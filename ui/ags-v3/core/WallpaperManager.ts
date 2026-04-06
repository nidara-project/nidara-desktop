import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { execAsync } from "ags/process"
import { readFile, writeFile } from "ags/file"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/crystal-shell/wallpaper`

export type TransitionType =
    | "simple" | "fade" | "random" | "center" | "grow"
    | "outer" | "wipe" | "wave" | "left" | "right" | "top" | "bottom"

export const TRANSITION_LABELS: Record<TransitionType, string> = {
    random: "Aleatoria",
    simple: "Fundido suave",
    fade: "Fundido con curva",
    center: "Círculo central",
    grow: "Expansión",
    outer: "Contracción",
    wipe: "Barrido diagonal",
    wave: "Ola",
    left: "Desde la izquierda",
    right: "Desde la derecha",
    top: "Desde arriba",
    bottom: "Desde abajo",
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
        try {
            if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
                const data = JSON.parse(readFile(CONFIG_PATH))
                // `path` is stored only as a hint for the Settings preview — awww restores
                // the last wallpaper on its own via `awww restore` on session start.
                this._current = data.path ?? ""
                this._transition = data.transition ?? "random"
            }
        } catch (_) { }
    }

    private _save() {
        const dir = `${GLib.get_user_config_dir()}/crystal-shell`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        // Only persist path as preview hint + transition preference.
        // awww's own cache handles restoration at login.
        writeFile(CONFIG_PATH, JSON.stringify({ path: this._current, transition: this._transition }))
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
