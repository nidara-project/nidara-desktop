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
    type TintPanels,
    type GlassTargets, // Added GlassTargets
    DEFAULT_CONFIG,
    ACCENT_PALETTE,
    writeGeneratedTheme,
    writeTokens,
    generateTokensCss,
    generateTintCss,
    installFluidCrystalSymlinks,
    loadConfig as loadFCConfig,
    saveConfig as saveFCConfig,
    writeQtSettings, // Added Qt bridge
    getSystemQtTheme, // Added system reader
} from "./FluidCrystal"

// ── CONSTANTS ────────────────────────────────────────────────────────
// The default fallback theme name if nothing is selected
const DEFAULT_SYSTEM_THEME = "MacTahoe-Dark"

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
        themeFamily: DEFAULT_SYSTEM_THEME,
        iconTheme: "MacTahoe",
        cursorTheme: "macOS",
        isDark: true
    }

    private fcConfig: FluidCrystalConfig = { ...DEFAULT_CONFIG }
    private configPath = `${GLib.get_user_config_dir()}/distroia/theme_settings.json`
    private lastRegisteredTheme: string = "" // Added guard 🛡️
    private _lastTokensCss: string = ""      // Added guard 🛡️
    private _lastTintCss: string = ""        // Added guard 🛡️

    private interfaceSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })

    constructor() {
        super()
        console.log("[ThemeManager] NEW instance created. 🚀")
        this.loadSettings()
        
        // V875: System Monitoring 📡
        this.interfaceSettings.connect("changed::color-scheme", () => {
            const scheme = this.interfaceSettings.get_string("color-scheme")
            const isDark = scheme === "prefer-dark"
            if (this.state.isDark !== isDark) {
                console.log(`[ThemeManager] External Dark Mode change detected: ${scheme}`)
                this.setDarkMode(isDark)
            }
        })
        
        this.applyAll()
    }

    // ── Discovery API ────────────────────────────────────────────────

    getAvailableGtkThemes(): string[] {
        const paths = ["/usr/share/themes", `${GLib.get_home_dir()}/.local/share/themes`, `${GLib.get_home_dir()}/.themes`]
        const external = this.listDirs(paths).filter(t => !["Default", "Emacs"].includes(t))
        return external
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

    getAvailableQtThemes(): string[] {
        const paths = ["/usr/share/Kvantum", `${GLib.get_home_dir()}/.config/Kvantum`]
        const themes = new Set<string>()
        
        paths.forEach(p => {
            if (!GLib.file_test(p, GLib.FileTest.EXISTS)) return
            
            const dir = Gio.File.new_for_path(p)
            try {
                // First level scan (Standard directories)
                const enumerator = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
                let info
                while ((info = enumerator.next_file(null))) {
                    const name = info.get_name()
                    if (name.endsWith("#")) continue

                    const themePath = `${p}/${name}`
                    const themeDir = Gio.File.new_for_path(themePath)
                    
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        try {
                            const subEnum = themeDir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
                            let subInfo
                            while ((subInfo = subEnum.next_file(null))) {
                                const subName = subInfo.get_name()
                                if (subName.endsWith(".kvconfig")) {
                                    // Extract "MacTahoeDark" from "MacTahoeDark.kvconfig"
                                    const themeName = subName.replace(".kvconfig", "")
                                    themes.add(themeName)
                                }
                            }
                        } catch (subE) {
                            // If it's a dir but we can't read it or it's empty, use dir name as fallback
                            themes.add(name)
                        }
                    } else if (name.endsWith(".kvconfig")) {
                        themes.add(name.replace(".kvconfig", ""))
                    }
                }
            } catch (e) { }
        })

        const result = Array.from(themes).sort()
        if (!result.includes("Default")) result.unshift("Default")
        return result
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

    get isFluidCrystal() { return this.fcConfig.enabled }
    get accentColor(): AccentKey { return this.fcConfig.accent }
    get transparency() { return this.fcConfig.transparency }
    get tintStrength() { return this.fcConfig.tintStrength }
    get tintPanels() { return this.fcConfig.tintPanels }
    get glassTargets() { return this.fcConfig.glassTargets }
    get qtTheme() { return this.fcConfig.qtTheme }
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

    async setQtTheme(theme: string) {
        console.log(`[ThemeManager] Setting Qt Theme to: ${theme}`)
        this.fcConfig.qtTheme = theme
        saveFCConfig(this.fcConfig)
        writeQtSettings(this.fcConfig, this.state.iconTheme)
        this.emit("changed")
    }


    async setDarkMode(dark: boolean) {
        console.log(`[ThemeManager] Toggle Dark Mode: ${dark}`)
        this.state.isDark = dark
        this.fcConfig.isDark = dark

        const scheme = dark ? "prefer-dark" : "prefer-light"
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])

        // Save BOTH configs to ensure engine-bridge consistency
        saveFCConfig(this.fcConfig)
        this.saveSettings()

        // Full sync
        await this.syncGtkTheme()
    }

    // ── Fluid Crystal API ────────────────────────────────────────────

    async setFluidCrystalEnabled(enabled: boolean) {
        console.log(`[ThemeManager] Fluid Crystal overlay toggled: ${enabled}`)
        this.fcConfig.enabled = enabled
        saveFCConfig(this.fcConfig)
        await this.syncGtkTheme()
        this.emit("changed")
    }

    async setGlassTarget(key: keyof GlassTargets, enabled: boolean) {
        console.log(`[ThemeManager] Glass target toggled: ${key} = ${enabled}`)
        this.fcConfig.glassTargets[key] = enabled
        if (this.isFluidCrystal) {
            this.syncGtkTheme() // Need full sync to overwrite CSS file
        }
        saveFCConfig(this.fcConfig)
        this.emit("changed")
    }

    private persistenceDebounceId = 0
    private schedulePersistence() {
        if (this.persistenceDebounceId > 0) GLib.source_remove(this.persistenceDebounceId)
        this.persistenceDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            console.log(`[ThemeManager] Ghost-Token persistence triggered (File & Settings)`)
            writeTokens(this.fcConfig)
            this.saveSettings()
            this.persistenceDebounceId = 0
            return GLib.SOURCE_REMOVE
        })
    }

    async setAccentColor(accent: AccentKey) {
        console.log(`[ThemeManager] Setting ghost-accent: ${accent}`)
        this.fcConfig.accent = accent
        if (this.isFluidCrystal) {
            // Instant in-memory boost
            this.ensureProvidersLinked()
            const tokensCss = generateTokensCss(this.fcConfig)
            this.themeProvider.load_from_string(tokensCss)
            this.schedulePersistence()
        } else {
            saveFCConfig(this.fcConfig)
        }
        this.emit("changed")
    }

    async setTransparency(value: number) {
        this.fcConfig.transparency = Math.max(0, Math.min(1, value))
        if (this.isFluidCrystal) {
            // Instant 0ms In-Memory Update (No Disk IO)
            this.ensureProvidersLinked()
            const tokensCss = generateTokensCss(this.fcConfig)
            this.themeProvider.load_from_string(tokensCss)

            // Background persistence for other apps
            this.schedulePersistence()
        } else {
            saveFCConfig(this.fcConfig)
        }
        this.emit("changed")
    }

    async setTintStrength(value: number) {
        this.fcConfig.tintStrength = Math.max(0, Math.min(1, value))
        if (this.isFluidCrystal) {
            this.refreshTintCss()
        }
        saveFCConfig(this.fcConfig)
        this.emit("changed")
    }

    async setTintPanel(panel: keyof TintPanels, enabled: boolean) {
        this.fcConfig.tintPanels[panel] = enabled
        if (this.isFluidCrystal) {
            this.refreshTintCss()
        }
        saveFCConfig(this.fcConfig)
        this.emit("changed")
    }



    // ── Private Logic ────────────────────────────────────────────────

    private themeProvider = new Gtk.CssProvider()
    private tintProvider = new Gtk.CssProvider()
    private providersLinked = false

    private ensureProvidersLinked() {
        if (this.providersLinked) return
        try {
            const display = Gdk.Display.get_default()
            if (display) {
                // V145: THE "GENEVA CONVENTION" FIX REFINED 🕊️
                // Restoring global display providers for AGS internal process.
                Gtk.StyleContext.add_provider_for_display(display, this.themeProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER)
                Gtk.StyleContext.add_provider_for_display(display, this.tintProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
                this.providersLinked = true
                console.log("[ThemeManager] Theme CSS Providers linked (Scoped to AGS Process)")
            }
        } catch (e) { }
    }


    private registeredResource: any | null = null

    /**
     * Delete the regenerateFluidCrystal function block since syncGtkTheme handles all logic now.
     */

    /**
     * Refresh only the tint CSS (lightweight, no file I/O)
     */
    private refreshTintCss() {
        this.ensureProvidersLinked()
        const tintCss = generateTintCss(this.fcConfig)
        if (this._lastTintCss !== tintCss) {
            this.tintProvider.load_from_string(tintCss)
            this._lastTintCss = tintCss
            console.log(`[ThemeManager] Tint CSS refreshed`)
        }
    }

    /**
     * Register an external theme's resources + CSS
     */
    private registerExternalTheme(themeName: string) {
        if (this.lastRegisteredTheme === themeName) {
            console.log(`[ThemeManager] Skipping GResource re-registration (Theme ${themeName} already active) 🛡️`)
            return
        }
        this.lastRegisteredTheme = themeName
        console.log(`[ThemeManager] Registering GResource for new theme: ${themeName} 💎`)
        
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
                    // We don't load the theme CSS into the provider here anymore.
                    // The provider is reserved for our dynamic tokens/overrides.
                    // The system loads the theme natively via ~/.config/gtk-4.0/gtk.css symlink.
                    console.log(`[ThemeManager] Theme found: ${cssPath} (handled via symlink)`)
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
    /**
     * Symlink an external theme's CSS and assets to ~/.config/gtk-4.0/
     */
    private async symlinkExternalTheme(themeName: string) {
        const dirs = ["gtk-3.0", "gtk-4.0"]
        const home = GLib.get_home_dir()

        for (const d of dirs) {
            const configDir = `${GLib.get_user_config_dir()}/${d}`
            const userThemeDir = `${home}/.themes/${themeName}/${d}`
            const systemThemeDir = `/usr/share/themes/${themeName}/${d}`

            let sourceDir = ""
            if (GLib.file_test(userThemeDir, GLib.FileTest.EXISTS)) sourceDir = userThemeDir
            else if (GLib.file_test(systemThemeDir, GLib.FileTest.EXISTS)) sourceDir = systemThemeDir

            if (sourceDir) {
                console.log(`[ThemeManager] Restoring base theme links for ${d} from: ${sourceDir}`)

                // 1. Clear previous links/files safely
                const targets = ["gtk.css", "gtk-dark.css", "assets", "windows-assets", "_tokens.css"]
                for (const target of targets) {
                    await execAsync(["rm", "-rf", `${configDir}/${target}`]).catch(() => { })
                }

                // 2. Restore standard links
                const themeCss = `${sourceDir}/gtk.css`
                await execAsync(["ln", "-sf", themeCss, `${configDir}/gtk.css`])
                await execAsync(["ln", "-sf", themeCss, `${configDir}/gtk-dark.css`])

                // 3. Restore assets if they exist in the theme
                const assetDirs = ["assets", "windows-assets"]
                for (const ads of assetDirs) {
                    const sourceAds = `${sourceDir}/${ads}`
                    if (GLib.file_test(sourceAds, GLib.FileTest.EXISTS)) {
                        await execAsync(["ln", "-sf", sourceAds, `${configDir}/${ads}`])
                    }
                }
            }
        }
        console.log(`[ThemeManager] Base theme symlinks restored for GTK3 & GTK4.`)
    }

    /**
     * Delete overrides in ~/.config/gtk-4.0/ to restore native theme behavior.
     * V145: NUCLEAR PURGE ☢️ - Using rm -rf for absolute disk-level cleanup.
     */
    private async clearConfigSymlinks() {
        const dirs = ["gtk-3.0", "gtk-4.0"]
        const targets = [
            "gtk.css", "gtk-dark.css",
            "gtk.css.map", "gtk-dark.css.map",
            "_tokens.css", "_tokens.css.map",
            "assets", "windows-assets",
            "gtk.gresource"
        ]

        for (const d of dirs) {
            const configDir = `${GLib.get_user_config_dir()}/${d}`
            console.log(`[ThemeManager] Executing Nuclear Purge in ${configDir}...`)
            for (const name of targets) {
                const path = `${configDir}/${name}`
                await execAsync(["rm", "-rf", path]).catch(() => { })
            }
        }

        // 2. Small yield to ensure the filesystem reflects the changes
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { r(null); return GLib.SOURCE_REMOVE; }))
    }

    private async syncGtkTheme() {
        const theme = this.state.themeFamily || DEFAULT_SYSTEM_THEME

        console.log(`[ThemeManager] syncGtkTheme → Base Theme: ${theme} | FC Engine: ${this.isFluidCrystal}`)

        // 1. Process external theme resources (buttons, headers, assets)
        this.registerExternalTheme(theme)

        // 2. Discover the physical CSS file of the base theme
        let baseThemeCssPath = ""
        const searchPaths = [
            `${GLib.get_home_dir()}/.local/share/themes/${theme}/gtk-4.0/gtk.css`,
            `${GLib.get_home_dir()}/.themes/${theme}/gtk-4.0/gtk.css`,
            `/usr/share/themes/${theme}/gtk-4.0/gtk.css`
        ]

        for (const p of searchPaths) {
            if (GLib.file_test(p, GLib.FileTest.EXISTS)) {
                baseThemeCssPath = p
                break
            }
        }

        // 3. Fluid Crystal Overlay Routing
        if (this.isFluidCrystal) {
            console.log(`[ThemeManager] Fluid Crystal Engine ENABLED. Generating @import overlay...`)
            // Write the overlay to ~/.config/gtk-4.0/gtk.css with the @import tag
            writeGeneratedTheme(this.fcConfig, baseThemeCssPath)
            installFluidCrystalSymlinks()

            // Wire our CSS tokens into AGS explicitly
            this.ensureProvidersLinked()
            const tokensCss = generateTokensCss(this.fcConfig)
            if (this._lastTokensCss !== tokensCss) {
                console.log(`[ThemeManager] CSS Tokens WRITTEN to provider 🖌️`)
                this.themeProvider.load_from_string(tokensCss)
                this._lastTokensCss = tokensCss
            } else {
                console.log(`[ThemeManager] CSS Tokens MATCH previous state — Skipping reload 🛡️`)
            }
            this.refreshTintCss()

            // FORCE OVERLAY: When ON, we force apps to read local config via empty GTK_THEME
            GLib.setenv("GTK_THEME", "", true)
        } else {
            console.log(`[ThemeManager] Fluid Crystal Engine DISABLED. PURGING OVERLAYS...`)
            // PURGE OVERLAY: Remove files so child apps load the real system theme natively
            await this.clearConfigSymlinks()

            // We update our AGS custom provider with "opaque" tokens so accents still work
            const tokensCss = generateTokensCss(this.fcConfig)
            if (this._lastTokensCss !== tokensCss) {
                this.themeProvider.load_from_string(tokensCss)
                this._lastTokensCss = tokensCss
            }
            this.tintProvider.load_from_string("")
            this._lastTintCss = ""

            // RESTORE NATIVE: Unset GTK_THEME to allow GSettings/XSettings to take over.
            // This is the ONLY way to ensure 100% native behavior for child processes.
            GLib.unsetenv("GTK_THEME")

            // SECURITY: Ensure the display doesn't have any residual provider (though we use Process-local)
            // We just let the empty/native providers handle it.
        }

        // 4. Force GTK & System bindings to align with the chosen Base Theme structurally
        try {
            const currentTheme = this.interfaceSettings.get_string("gtk-theme")
            if (currentTheme !== theme) {
                await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", theme])
                this.updateSettingsIni(theme)
            }
        } catch (e) {
            console.error("[ThemeManager] GSettings sync failed:", e)
        }

        // Local settings update (force the current settings daemon process to obey)
        try {
            const settings = Gtk.Settings.get_default()
            if (settings && settings.gtk_theme_name !== theme) {
                settings.gtk_theme_name = theme
                // @ts-ignore
                settings.gtk_application_prefer_dark_theme = this.state.isDark
            }

            const styleManager = Adw.StyleManager.get_default()
            const targetScheme = this.state.isDark ? Adw.ColorScheme.PREFER_DARK : Adw.ColorScheme.PREFER_LIGHT
            if (styleManager.color_scheme !== targetScheme) {
                styleManager.set_color_scheme(targetScheme)
            }
        } catch (e) {
            console.warn("[ThemeManager] Local application error:", e)
        }

        // Final Qt Sync
        writeQtSettings(this.fcConfig, this.state.iconTheme)
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
            const dirs = ["gtk-3.0", "gtk-4.0"]
            for (const d of dirs) {
                const path = `${GLib.get_user_config_dir()}/${d}/settings.ini`
                try {
                    const existing = readFile(path)
                    if (existing === ini) continue
                } catch (e) { }
                writeFile(path, ini)
            }
        } catch (e) {
            console.warn("[ThemeManager] Failed to update settings.ini:", e)
        }
    }

    private async applyAll() {
        console.log(`[ThemeManager] applyAll() triggered — Checking for changes... 🔍`)
        await this.syncGtkTheme()

        const currentIcons = this.interfaceSettings.get_string("icon-theme")
        if (currentIcons !== this.state.iconTheme) {
            console.log(`[ThemeManager] Updating Icon Theme: ${this.state.iconTheme}`)
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", this.state.iconTheme])
        }

        const currentCursor = this.interfaceSettings.get_string("cursor-theme")
        if (currentCursor !== this.state.cursorTheme) {
            console.log(`[ThemeManager] Updating Cursor Theme: ${this.state.cursorTheme}`)
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", this.state.cursorTheme])
        }

        const targetScheme = this.state.isDark ? "prefer-dark" : "prefer-light"
        const currentScheme = this.interfaceSettings.get_string("color-scheme")
        if (currentScheme !== targetScheme) {
            console.log(`[ThemeManager] Updating Color Scheme: ${targetScheme}`)
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", targetScheme])
        }
    }

    // ── Persistence ──────────────────────────────────────────────────

    private saveSettings() {
        const dir = `${GLib.get_user_config_dir()}/distroia`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) {
            GLib.mkdir_with_parents(dir, 0o755)
        }
        try {
            writeFile(this.configPath, JSON.stringify(this.state, null, 2))
            writeQtSettings(this.fcConfig, this.state.iconTheme) // Sync Qt bridge with icons
            console.log(`[ThemeManager] Settings saved`)
        } catch (e) {
            console.error(`[ThemeManager] Failed to save settings: ${e}`)
        }
    }

    private loadSettings() {
        // Load Fluid Crystal config
        this.fcConfig = loadFCConfig()
        
        // V880: Sync Qt theme from system (Bidirectional mirror)
        const systemQt = getSystemQtTheme()
        if (systemQt) {
            this.fcConfig.qtTheme = systemQt
        }

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
            // Re-sync base theme if GTK was changed externally
            if (gtk) this.state.themeFamily = gtk

            // V880: Bidirectional Qt sync
            const systemQt = getSystemQtTheme()
            if (systemQt) this.fcConfig.qtTheme = systemQt

            console.log("[ThemeManager] Registry sync done:", this.state)
        } catch (e) {
            console.error("[ThemeManager] System sync failed:", e)
        }
    }
}

export const Theme = new ThemeManager()
export default Theme
