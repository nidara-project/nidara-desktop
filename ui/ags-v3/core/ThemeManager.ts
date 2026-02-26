import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { Gdk, Gtk } from "ags/gtk4"
// @ts-ignore
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
        // Limpiamos la variable de entorno para este proceso
        GLib.setenv("GTK_THEME", "", true)
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

    async setGtkTheme(theme: string) {
        console.log(`[ThemeManager] Setting GTK Theme to: ${theme}`)
        this.state.themeFamily = theme // Keep property name in state for JSON compatibility, or rename if preferred
        await this.syncGtkTheme()
        this.saveSettings()
        this.emit("changed")
    }

    async setIconTheme(icons: string) {
        console.log(`[ThemeManager] Setting icon theme to: ${icons}`)
        this.state.iconTheme = icons
        try {
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

        // 1. GSettings Color Scheme - Solo actualizamos el valor global
        const scheme = dark ? "prefer-dark" : "prefer-light"
        console.log(`[ThemeManager] Global Preference: ${scheme}`)
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])

        this.saveSettings()
        this.emit("changed")
    }

    // --- Private Logic ---

    private themeProvider = new Gtk.CssProvider()
    private providersLinked = false

    private ensureProvidersLinked() {
        if (this.providersLinked) return
        try {
            const display = Gdk.Display.get_default()
            if (display) {
                // V165: Aumentamos la prioridad a USER para que el tema GTK mande sobre Adwaita
                Gtk.StyleContext.add_provider_for_display(display, this.themeProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
                this.providersLinked = true
                console.log("[ThemeManager] Theme CSS Provider vinculado con prioridad USER.")
            }
        } catch (e) { }
    }

    private registeredResource: any | null = null

    /**
     * V140: DYNAMIC RESOURCE REGISTRATION 🚀
     */
    private registerThemeResource(themeName: string) {
        this.ensureProvidersLinked()
        try {
            if (this.registeredResource) {
                try {
                    // @ts-ignore
                    this.registeredResource._unregister()
                } catch (e) { }
            }

            const searchPaths = [
                `/usr/share/themes/${themeName}`,
                `${GLib.get_home_dir()}/.local/share/themes/${themeName}`,
                `${GLib.get_home_dir()}/.themes/${themeName}`
            ]

            for (const base of searchPaths) {
                const resPath = `${base}/gtk-4.0/gtk.gresource`
                const cssPath = `${base}/gtk-4.0/gtk.css`

                // 1. Try GResource (Critical for many themes)
                if (GLib.file_test(resPath, GLib.FileTest.EXISTS)) {
                    this.registeredResource = Gio.Resource.load(resPath)
                    // @ts-ignore
                    this.registeredResource._register()
                    console.log(`[ThemeManager] GResource registered: ${resPath}`)
                }

                // 2. Try GTK4 CSS (Critical for Libadwaita to follow the theme) 🚀
                if (GLib.file_test(cssPath, GLib.FileTest.EXISTS)) {
                    this.themeProvider.load_from_path(cssPath)
                    console.log(`[ThemeManager] CSS loaded into provider: ${cssPath}`)
                    return // Found it
                }
            }
        } catch (e) {
            console.warn("[ThemeManager] Error registering theme assets:", e)
        }
    }

    private async syncGtkTheme() {
        const theme = this.state.themeFamily
        console.log(`[ThemeManager] syncGtkTheme -> Aplicando: ${theme}`)

        // 1. REGISTRAR RECURSOS
        this.registerThemeResource(theme)

        // 2. Aplicar a GSettings (Para el resto del sistema)
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", theme])

        // 3. ACTUALIZACIÓN DE LIBADWAITA (Symlink Hack) 🚀
        try {
            const configDir = `${GLib.get_user_config_dir()}/gtk-4.0`
            const userThemeDir = `${GLib.get_home_dir()}/.themes/${theme}/gtk-4.0`
            const systemThemeDir = `/usr/share/themes/${theme}/gtk-4.0`

            let sourceDir = ""
            if (GLib.file_test(userThemeDir, GLib.FileTest.EXISTS)) sourceDir = userThemeDir
            else if (GLib.file_test(systemThemeDir, GLib.FileTest.EXISTS)) sourceDir = systemThemeDir

            if (sourceDir) {
                const targetCss = `${configDir}/gtk.css`
                const targetDarkCss = `${configDir}/gtk-dark.css`
                const themeCss = `${sourceDir}/gtk.css`

                // Borramos lo que haya (podrían ser archivos físicos del instalador de MacTahoe)
                execAsync(["rm", "-f", targetCss, targetDarkCss])
                execAsync(["ln", "-sf", themeCss, targetCss])
                execAsync(["ln", "-sf", themeCss, targetDarkCss])
                console.log(`[ThemeManager] Libadwaita symlinks updated to: ${themeCss}`)
            }
        } catch (e) {
            console.warn("[ThemeManager] Error configurando symlinks de Libadwaita:", e)
        }

        // 4. ACTUALIZACIÓN LOCAL 🚀
        // Usamos el estado del toggle (this.state.isDark) para la preferencia de color, 
        // sin que el nombre del tema influya para nada.
        try {
            const settings = Gtk.Settings.get_default()
            if (settings) {
                settings.gtk_theme_name = theme
                // @ts-ignore
                settings.gtk_application_prefer_dark_theme = this.state.isDark
            }

            // Libadwaita obedece al toggle, no al nombre del tema
            Adw.StyleManager.get_default().set_color_scheme(
                this.state.isDark ? Adw.ColorScheme.PREFER_DARK : Adw.ColorScheme.PREFER_LIGHT
            )
        } catch (e) {
            console.warn("[ThemeManager] Error en la aplicación local:", e)
        }
    }

    private async applyAll() {
        await this.syncGtkTheme()
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", this.state.iconTheme])
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", this.state.cursorTheme])

        const scheme = this.state.isDark ? "prefer-dark" : "prefer-light"
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])
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

            this.state.themeFamily = gtk

            console.log("[ThemeManager] Registry sync done:", this.state)
        } catch (e) {
            console.error("[ThemeManager] System sync failed:", e)
        }
    }
}

export const Theme = new ThemeManager()
export default Theme
