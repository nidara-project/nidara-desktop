import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { readFile, writeFile } from "ags/file"
import { TransitionType } from "./WallpaperManager"

export type WallpaperMode = "artwork" | "custom" | "none"

const CONFIG_PATH = `${GLib.get_user_config_dir()}/crystal-shell/gaming.json`

class GamingManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "GamingManager",
            Signals: { "changed": {} },
        }, this)
    }

    private _wallpaperMode:   WallpaperMode  = "artwork"
    private _customWallpaper: string         = ""
    private _transition:      TransitionType = "grow"
    private _performanceProfile: boolean     = false

    constructor() {
        super()
        this._load()
    }

    get wallpaperMode()      { return this._wallpaperMode }
    get customWallpaper()    { return this._customWallpaper }
    get transition()         { return this._transition }
    get performanceProfile() { return this._performanceProfile }

    private _load() {
        try {
            if (GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
                const data = JSON.parse(readFile(CONFIG_PATH))
                this._wallpaperMode      = data.wallpaperMode      ?? "artwork"
                this._customWallpaper    = data.customWallpaper    ?? ""
                this._transition         = data.transition         ?? "grow"
                this._performanceProfile = data.performanceProfile ?? false
            }
        } catch (_) {}
    }

    private _save() {
        const dir = `${GLib.get_user_config_dir()}/crystal-shell`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        writeFile(CONFIG_PATH, JSON.stringify({
            wallpaperMode:      this._wallpaperMode,
            customWallpaper:    this._customWallpaper,
            transition:         this._transition,
            performanceProfile: this._performanceProfile,
        }, null, 2))
        this.emit("changed")
    }

    setWallpaperMode(mode: WallpaperMode) {
        this._wallpaperMode = mode
        this._save()
    }

    setCustomWallpaper(path: string) {
        this._customWallpaper = path
        this._save()
    }

    setTransition(t: TransitionType) {
        this._transition = t
        this._save()
    }

    setPerformanceProfile(enabled: boolean) {
        this._performanceProfile = enabled
        this._save()
    }
}

export const Gaming = new GamingManager()
export default Gaming
