import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Adw from "gi://Adw?version=1"
import { execAsync } from "ags/process"
import { readFile, writeFile } from "ags/file"

/**
 * ThemeEngine State Interface
 */
interface ThemeState {
    themeFamily: string
    iconTheme: string
    cursorTheme: string
    isDark: boolean
}

/**
 * ThemeManager Service 🎨
 * Handles GSettings, Libadwaita, and internal "Theme Family" logic.
 */
class ThemeManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "ThemeManager",
            Signals: { "changed": {} }
        }, this)
    }

    private state: ThemeState = {
        themeFamily: "WhiteSur",
        iconTheme: "WhiteSur",
        cursorTheme: "macOS",
        isDark: true
    }

    private configPath = `${GLib.get_user_config_dir()}/distroia/theme_settings.json`

    constructor() {
        super()
        this.loadSettings()
        // Ensure initial sync
        this.applyAll()
    }

    // --- Discovery API ---

    getAvailableGtkThemes(): string[] {
        const paths = ["/usr/share/themes", `${GLib.get_home_dir()}/.local/share/themes`, `${GLib.get_home_dir()}/.themes`]
        return this.listDirs(paths).filter(t => !["Default", "Emacs"].includes(t))
    }

    getAvailableIconThemes(): string[] {
        const paths = ["/usr/share/icons", `${GLib.get_home_dir()}/.local/share/icons`, `${GLib.get_home_dir()}/.icons`]
        // Only return folders that have index.theme (meaning it's a theme, not just a cursor folder)
        return this.listDirs(paths).filter(t => {
            for (const p of paths) {
                if (GLib.file_test(`${p}/${t}/index.theme`, GLib.FileTest.EXISTS)) return true
            }
            return false
        })
    }

    getAvailableCursorThemes(): string[] {
        const paths = ["/usr/share/icons", `${GLib.get_home_dir()}/.local/share/icons`, `${GLib.get_home_dir()}/.icons`]
        // Cursors always have a 'cursors' folder inside them
        return this.listDirs(paths).filter(t => {
            for (const p of paths) {
                if (GLib.file_test(`${p}/${t}/cursors`, GLib.FileTest.EXISTS)) return true
            }
            return false
        })
    }

    private listDirs(paths: string[]): string[] {
        const sets = new Set<string>()
        paths.forEach(p => {
            if (!GLib.file_test(p, GLib.FileTest.EXISTS)) return
            try {
                const dir = Gio.File.new_for_path(p)
                const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
                let info
                while ((info = enumerator.next_file(null))) {
                    sets.add(info.get_name())
                }
            } catch (e) { }
        })
        return Array.from(sets).sort()
    }

    // --- Public API ---

    get themeFamily() { return this.state.themeFamily }
    get iconTheme() { return this.state.iconTheme }
    get cursorTheme() { return this.state.cursorTheme }
    get isDark() { return this.state.isDark }

    async setThemeFamily(family: string) {
        this.state.themeFamily = family
        await this.syncGtkTheme()
        this.saveSettings()
        this.emit("changed")
    }

    async setIconTheme(icons: string) {
        console.log(`[ThemeManager] Setting icon theme to: ${icons}`)
        this.state.iconTheme = icons
        try {
            // Use --type string to be explicit
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", icons])
            this.saveSettings()
            this.emit("changed")
        } catch (e) {
            console.error(`[ThemeManager] FAILED to set icons: ${e}`)
        }
    }

    async setCursorTheme(cursor: string) {
        this.state.cursorTheme = cursor
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", cursor])
        this.saveSettings()
        this.emit("changed")
    }

    async setDarkMode(dark: boolean) {
        this.state.isDark = dark

        // 1. GSettings Color Scheme
        const scheme = dark ? "prefer-dark" : "default"
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])

        // 2. Libadwaita Integration
        try {
            const styleManager = Adw.StyleManager.get_default()
            styleManager.set_color_scheme(dark ? Adw.ColorScheme.PREFER_DARK : Adw.ColorScheme.PREFER_LIGHT)
        } catch (e) { console.warn("[ThemeManager] Adw sync failed", e) }

        // 3. GTK Theme Suffix Logic
        await this.syncGtkTheme()

        this.saveSettings()
        this.emit("changed")
    }

    // --- Private Logic ---

    private async syncGtkTheme() {
        // Dynamic Family Logic: We try to find the best match
        let finalName = this.state.themeFamily

        // If it's a family name (no -Dark/-Light), append it
        if (!finalName.includes("-Dark") && !finalName.includes("-Light") && !finalName.includes("-dark") && !finalName.includes("-light")) {
            const suffix = this.state.isDark ? "-Dark" : "-Light"
            finalName = `${this.state.themeFamily}${suffix}`
        }

        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", finalName])
        console.log(`[ThemeManager] Applied GTK Theme: ${finalName}`)
    }

    private async applyAll() {
        await this.syncGtkTheme()
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", this.state.iconTheme])
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", this.state.cursorTheme])

        const scheme = this.state.isDark ? "prefer-dark" : "default"
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])

        try {
            Adw.StyleManager.get_default().set_color_scheme(
                this.state.isDark ? Adw.ColorScheme.PREFER_DARK : Adw.ColorScheme.PREFER_LIGHT
            )
        } catch (e) { }
    }

    private saveSettings() {
        const dir = `${GLib.get_user_config_dir()}/distroia`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) {
            GLib.mkdir_with_parents(dir, 0o755)
        }
        try {
            writeFile(this.configPath, JSON.stringify(this.state, null, 2))
            console.log(`[ThemeManager] Settings saved to ${this.configPath}`)
        } catch (e) {
            console.error(`[ThemeManager] Failed to save settings: ${e}`)
        }
    }

    private loadSettings() {
        try {
            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                const content = readFile(this.configPath)
                const parsed = JSON.parse(content)
                this.state = { ...this.state, ...parsed }
                console.log("[ThemeManager] Settings loaded from JSON")
            } else {
                console.log("[ThemeManager] Config not found, initializing from system...")
                this.syncFromSystem()
            }
        } catch (e) {
            console.warn("[ThemeManager] Error loading settings, syncing from system")
            this.syncFromSystem()
        }
    }

    /**
     * READ current GSettings into our state
     */
    private syncFromSystem() {
        try {
            const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
            const gtk = settings.get_string("gtk-theme")
            const icons = settings.get_string("icon-theme")
            const cursor = settings.get_string("cursor-theme")
            const scheme = settings.get_string("color-scheme")

            this.state.iconTheme = icons
            this.state.cursorTheme = cursor
            this.state.isDark = scheme === "prefer-dark"

            // Heuristic for theme family: remove -Dark/-Light
            this.state.themeFamily = gtk.replace(/-Dark$|-Light$|-dark$|-light$/, "")

            console.log("[ThemeManager] Registry sync done:", this.state)
        } catch (e) {
            console.error("[ThemeManager] System sync failed:", e)
        }
    }
}

export const Theme = new ThemeManager()
export default Theme
