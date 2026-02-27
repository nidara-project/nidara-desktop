import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { Gdk, Gtk } from "ags/gtk4"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import { execAsync } from "ags/process"
import { readFile, writeFile } from "ags/file"
import {
    type FluidCrystalConfig,
    type AccentKey,
    DEFAULT_CONFIG,
    ACCENT_PALETTE,
    writeGeneratedTheme,
    generateTokensCss,
    installFluidCrystalSymlinks,
    loadConfig as loadFCConfig,
    saveConfig as saveFCConfig,
} from "./FluidCrystal"

// ── CONSTANTS ────────────────────────────────────────────────────────
const FLUID_CRYSTAL_ID = "FluidCrystal"

/**
 * ThemeEngine State Interface
 */
interface ThemeState {
    themeFamily: string   // "FluidCrystal" or external theme name
    iconTheme: string
    cursorTheme: string
    isDark: boolean
}

/**
 * ThemeManager Service 🎨
 * Orchestrates GTK theming, Fluid Crystal token engine, and GSettings.
 */
class ThemeManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "ThemeManager",
            Signals: { "changed": {} }
        }, this)
    }

    private state: ThemeState = {
        themeFamily: FLUID_CRYSTAL_ID,
        iconTheme: "MacTahoe",
        cursorTheme: "macOS",
        isDark: true
    }

    private fcConfig: FluidCrystalConfig = { ...DEFAULT_CONFIG }
    private configPath = `${GLib.get_user_config_dir()}/distroia/theme_settings.json`

    constructor() {
        super()
        GLib.setenv("GTK_THEME", "", true)
        this.loadSettings()
        this.applyAll()
    }

    // ── Discovery API ────────────────────────────────────────────────

    getAvailableGtkThemes(): string[] {
        const paths = ["/usr/share/themes", `${GLib.get_home_dir()}/.local/share/themes`, `${GLib.get_home_dir()}/.themes`]
        const external = this.listDirs(paths).filter(t => !["Default", "Emacs"].includes(t))
        // Always include Fluid Crystal as the first option
        return [FLUID_CRYSTAL_ID, ...external]
    }

    getAvailableIconThemes(): string[] {
        const paths = ["/usr/share/icons", `${GLib.get_home_dir()}/.local/share/icons`, `${GLib.get_home_dir()}/.icons`]
        return this.listDirs(paths).filter(t => {
            for (const p of paths) {
                if (GLib.file_test(`${p}/${t}/index.theme`, GLib.FileTest.EXISTS)) return true
            }
            return false
        })
    }

    getAvailableCursorThemes(): string[] {
        const paths = ["/usr/share/icons", `${GLib.get_home_dir()}/.local/share/icons`, `${GLib.get_home_dir()}/.icons`]
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

    // ── Public API ───────────────────────────────────────────────────

    get themeFamily() { return this.state.themeFamily }
    get iconTheme() { return this.state.iconTheme }
    get cursorTheme() { return this.state.cursorTheme }
    get isDark() { return this.state.isDark }

    get isFluidCrystal() { return this.state.themeFamily === FLUID_CRYSTAL_ID }
    get accentColor(): AccentKey { return this.fcConfig.accent }
    get transparency() { return this.fcConfig.transparency }
    get tintStrength() { return this.fcConfig.tintStrength }
    get accentPalette() { return ACCENT_PALETTE }

    // ── Theme Switching ──────────────────────────────────────────────

    async setGtkTheme(theme: string) {
        console.log(`[ThemeManager] Setting GTK Theme to: ${theme}`)
        this.state.themeFamily = theme
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
        this.fcConfig.isDark = dark

        const scheme = dark ? "prefer-dark" : "prefer-light"
        console.log(`[ThemeManager] Global Preference: ${scheme}`)
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])

        // No need to regenerate Fluid Crystal CSS here —
        // Libadwaita handles dark/light switching in real-time via color-scheme.
        // Our CSS only defines accent, transparency, etc. (mode-independent).

        // Update settings.ini
        if (this.isFluidCrystal) {
            this.updateSettingsIni("Adwaita")
        }

        this.saveSettings()
        this.emit("changed")
    }

    // ── Fluid Crystal API ────────────────────────────────────────────

    async setAccentColor(accent: AccentKey) {
        console.log(`[ThemeManager] Setting accent: ${accent}`)
        this.fcConfig.accent = accent
        if (this.isFluidCrystal) {
            this.regenerateFluidCrystal()
        }
        saveFCConfig(this.fcConfig)
        this.emit("changed")
    }

    async setTransparency(value: number) {
        this.fcConfig.transparency = Math.max(0, Math.min(1, value))
        if (this.isFluidCrystal) {
            this.regenerateFluidCrystal()
        }
        saveFCConfig(this.fcConfig)
        this.emit("changed")
    }

    async setTintStrength(value: number) {
        this.fcConfig.tintStrength = Math.max(0, Math.min(1, value))
        if (this.isFluidCrystal) {
            this.regenerateFluidCrystal()
        }
        saveFCConfig(this.fcConfig)
        this.emit("changed")
    }

    // ── Private Logic ────────────────────────────────────────────────

    private themeProvider = new Gtk.CssProvider()
    private providersLinked = false

    private ensureProvidersLinked() {
        if (this.providersLinked) return
        try {
            const display = Gdk.Display.get_default()
            if (display) {
                Gtk.StyleContext.add_provider_for_display(display, this.themeProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
                this.providersLinked = true
                console.log("[ThemeManager] Theme CSS Provider linked (PRIORITY_USER)")
            }
        } catch (e) { }
    }

    private registeredResource: any | null = null

    /**
     * Regenerate Fluid Crystal theme from current config.
     * CSS is mode-independent (works for both dark and light).
     */
    private regenerateFluidCrystal() {
        console.log("[ThemeManager] Regenerating Fluid Crystal theme...")
        try {
            // Write full CSS (tokens + MacTahoe template) for system apps
            writeGeneratedTheme(this.fcConfig)
            installFluidCrystalSymlinks()

            // Load ONLY tokens into AGS CssProvider (not the MacTahoe template)
            // Our AGS widgets are styled by our SCSS, not MacTahoe rules
            this.ensureProvidersLinked()
            const tokensCss = generateTokensCss(this.fcConfig)
            this.themeProvider.load_from_string(tokensCss)
            console.log(`[ThemeManager] AGS CssProvider loaded with tokens only`)
        } catch (e) {
            console.error(`[ThemeManager] Fluid Crystal generation failed: ${e}`)
        }
    }

    /**
     * Register an external theme's resources + CSS
     */
    private registerExternalTheme(themeName: string) {
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

                if (GLib.file_test(resPath, GLib.FileTest.EXISTS)) {
                    this.registeredResource = Gio.Resource.load(resPath)
                    // @ts-ignore
                    this.registeredResource._register()
                    console.log(`[ThemeManager] GResource registered: ${resPath}`)
                }

                if (GLib.file_test(cssPath, GLib.FileTest.EXISTS)) {
                    this.themeProvider.load_from_path(cssPath)
                    console.log(`[ThemeManager] CSS loaded: ${cssPath}`)
                    return
                }
            }
        } catch (e) {
            console.warn("[ThemeManager] Error registering theme assets:", e)
        }
    }

    /**
     * Symlink an external theme's CSS to ~/.config/gtk-4.0/
     */
    private symlinkExternalTheme(themeName: string) {
        const configDir = `${GLib.get_user_config_dir()}/gtk-4.0`
        const userThemeDir = `${GLib.get_home_dir()}/.themes/${themeName}/gtk-4.0`
        const systemThemeDir = `/usr/share/themes/${themeName}/gtk-4.0`

        let sourceDir = ""
        if (GLib.file_test(userThemeDir, GLib.FileTest.EXISTS)) sourceDir = userThemeDir
        else if (GLib.file_test(systemThemeDir, GLib.FileTest.EXISTS)) sourceDir = systemThemeDir

        if (sourceDir) {
            const themeCss = `${sourceDir}/gtk.css`
            execAsync(["rm", "-f", `${configDir}/gtk.css`, `${configDir}/gtk-dark.css`])
            execAsync(["ln", "-sf", themeCss, `${configDir}/gtk.css`])
            execAsync(["ln", "-sf", themeCss, `${configDir}/gtk-dark.css`])
            console.log(`[ThemeManager] External symlinks → ${themeCss}`)
        }
    }

    private async syncGtkTheme() {
        const theme = this.state.themeFamily
        console.log(`[ThemeManager] syncGtkTheme → ${theme}`)

        if (theme === FLUID_CRYSTAL_ID) {
            // ── Fluid Crystal path ──
            this.regenerateFluidCrystal()

            // Set gtk-theme to "Adwaita" so Libadwaita apps (Nautilus, etc.)
            // use the default engine and pick up our ~/.config/gtk-4.0/gtk.css override
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", "Adwaita"])

            // Update settings.ini to match
            this.updateSettingsIni("Adwaita")
        } else {
            // ── External theme path ──
            this.registerExternalTheme(theme)
            this.symlinkExternalTheme(theme)
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", theme])
            this.updateSettingsIni(theme)
        }

        // Local settings update
        try {
            const settings = Gtk.Settings.get_default()
            if (settings) {
                settings.gtk_theme_name = theme === FLUID_CRYSTAL_ID ? "Adwaita" : theme
                // @ts-ignore
                settings.gtk_application_prefer_dark_theme = this.state.isDark
            }

            Adw.StyleManager.get_default().set_color_scheme(
                this.state.isDark ? Adw.ColorScheme.PREFER_DARK : Adw.ColorScheme.PREFER_LIGHT
            )
        } catch (e) {
            console.warn("[ThemeManager] Local application error:", e)
        }
    }

    /**
     * Update ~/.config/gtk-4.0/settings.ini to keep it in sync
     */
    private updateSettingsIni(gtkThemeName: string) {
        try {
            const ini = `[Settings]
gtk-theme-name=${gtkThemeName}
gtk-icon-theme-name=${this.state.iconTheme}
gtk-font-name=Inter Variable Medium 11
gtk-cursor-theme-name=${this.state.cursorTheme}
gtk-cursor-theme-size=24
gtk-application-prefer-dark-theme=${this.state.isDark ? 1 : 0}
`
            const path = `${GLib.get_user_config_dir()}/gtk-4.0/settings.ini`
            writeFile(path, ini)
        } catch (e) {
            console.warn("[ThemeManager] Failed to update settings.ini:", e)
        }
    }

    private async applyAll() {
        await this.syncGtkTheme()
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", this.state.iconTheme])
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", this.state.cursorTheme])

        const scheme = this.state.isDark ? "prefer-dark" : "prefer-light"
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])
    }

    // ── Persistence ──────────────────────────────────────────────────

    private saveSettings() {
        const dir = `${GLib.get_user_config_dir()}/distroia`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) {
            GLib.mkdir_with_parents(dir, 0o755)
        }
        try {
            writeFile(this.configPath, JSON.stringify(this.state, null, 2))
            console.log(`[ThemeManager] Settings saved`)
        } catch (e) {
            console.error(`[ThemeManager] Failed to save settings: ${e}`)
        }
    }

    private loadSettings() {
        // Load Fluid Crystal config
        this.fcConfig = loadFCConfig()

        try {
            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                const content = readFile(this.configPath)
                const parsed = JSON.parse(content)
                this.state = { ...this.state, ...parsed }

                // Sync isDark between both configs
                this.fcConfig.isDark = this.state.isDark
                console.log("[ThemeManager] Settings loaded")
            } else {
                console.log("[ThemeManager] No config found, initializing from system...")
                this.syncFromSystem()
            }
        } catch (e) {
            console.warn("[ThemeManager] Error loading settings, syncing from system")
            this.syncFromSystem()
        }
    }

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
