import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import { execAsync } from "ags/process"
import { readFile, writeFile } from "ags/file"
import {
    type FluidCrystalConfig,
    type AccentKey,
    type TintPanels,
    DEFAULT_CONFIG,
    ACCENT_PALETTE,
    generateTokensCss,
    generateTintCss,
    writeQtSettings,
    getSystemQtTheme,
} from "./FluidCrystal"

// ── CONSTANTS ────────────────────────────────────────────────────────
// No default theme forced — themeFamily is read from system on first run via syncFromSystem()

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
 * ThemeManager — GTK theme, dark mode, and Fluid Crystal token management
 * Orchestrates GTK theming, Fluid Crystal token engine, and GSettings.
 */
class ThemeManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "ThemeManager",
            Signals: { 
                "changed": {},
                "ready": {}
            }
        }, this)
    }

    private state: ThemeState = {
        themeFamily: "",   // populated by syncFromSystem() on first run
        iconTheme: "",     // populated by syncFromSystem() on first run
        cursorTheme: "",   // populated by syncFromSystem() on first run
        isDark: true
    }

    private fcConfig: FluidCrystalConfig = { ...DEFAULT_CONFIG }
    private configPath = `${GLib.get_user_config_dir()}/crystal-shell/appearance.json`
    private _lastTokensCss: string = ""
    private _lastTintCss: string = ""

    private mainProvider = new Gtk.CssProvider()
    private fontProvider = new Gtk.CssProvider()
    private themeProvider = new Gtk.CssProvider()
    private tintProvider = new Gtk.CssProvider()
    private providersLinked = false

    private interfaceSettings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })

    constructor() {
        super()
        console.log("[ThemeManager] NEW instance created. ")
        this.loadSettings()
        
        // Monitor system color scheme changes
        this.interfaceSettings.connect("changed::color-scheme", () => {
            const scheme = this.interfaceSettings.get_string("color-scheme")
            const isDark = scheme === "prefer-dark"
            if (this.state.isDark !== isDark) {
                console.log(`[ThemeManager] External Dark Mode change detected: ${scheme}`)
                this.setDarkMode(isDark)
            }
        })

        // Monitor font preference changes
        this.interfaceSettings.connect("changed::font-name", () => this.syncFont())
        this.syncFont()
        
        // Hot-reload CSS in dev mode
        this.setupStyleMonitor()
        
        this.applyAll()
    }

    private setupStyleMonitor() {
        const stylePath = `${GLib.get_user_config_dir()}/crystal-shell/ui/ags-v3/style.css`
        const file = Gio.File.new_for_path(stylePath)
        try {
            const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null)
            monitor.connect("changed", () => {
                console.log(`[ThemeManager] Style Hot-Reload: ${stylePath}`)
                this.mainProvider.load_from_path(stylePath)
            })
        } catch (e) { console.error(`[ThemeManager] Failed to monitor ${stylePath}:`, e) }
    }

    private syncFont() {
        try {
            const fontName = this.interfaceSettings.get_string("font-name")
            const [family] = fontName.match(/^(.*?) (\d+)$/)?.slice(1) || ["sans-serif"]
            const fontCss = `* { font-family: "${family}", "Symbols Nerd Font", sans-serif; }`
            
            this.ensureProvidersLinked()
            this.fontProvider.load_from_data(fontCss, fontCss.length)
            console.log(`[ThemeManager] Font Sync: ${family}`)
        } catch (e) { }
    }

    // ── Discovery API ────────────────────────────────────────────────

    getAvailableGtkThemes(): string[] {
        const paths = ["/usr/share/themes", `${GLib.get_home_dir()}/.local/share/themes`, `${GLib.get_home_dir()}/.themes`]
        return this.listDirs(paths).filter(t => !["Default", "Emacs"].includes(t))
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
                const enumerator = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null)
                let info
                while ((info = enumerator.next_file(null))) {
                    const name = info.get_name()
                    if (name.endsWith("#")) continue
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        try {
                            const subDir = Gio.File.new_for_path(`${p}/${name}`)
                            const subEnum = subDir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
                            let subInfo
                            while ((subInfo = subEnum.next_file(null))) {
                                const subName = subInfo.get_name()
                                if (subName.endsWith(".kvconfig")) {
                                    themes.add(subName.replace(".kvconfig", ""))
                                }
                            }
                        } catch (e) { themes.add(name) }
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
    get accentColor(): AccentKey { return this.fcConfig.accent }
    get transparency() { return this.fcConfig.transparency }
    get tintStrength() { return this.fcConfig.tintStrength }
    get tintPanels() { return this.fcConfig.tintPanels }
    get qtTheme() { return this.fcConfig.qtTheme }
    get accentPalette() { return ACCENT_PALETTE }
    get interfaceFont(): string {
        try { return this.interfaceSettings.get_string("font-name") } catch (_) { return "Sans 11" }
    }
    get monoFont(): string {
        try { return this.interfaceSettings.get_string("monospace-font-name") } catch (_) { return "Monospace 11" }
    }

    // ── Actions ──────────────────────────────────────────────────────

    async setGtkTheme(theme: string) {
        console.log(`[ThemeManager] Setting GTK Theme to: ${theme}`)
        this.state.themeFamily = theme
        await this.syncGtkTheme()
        this.saveSettings()
        this.emit("changed")
    }

    async setIconTheme(icons: string) {
        this.state.iconTheme = icons
        try {
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", icons])
            this.saveSettings(true)
            this.emit("changed")
        } catch (e) { console.error(e) }
    }

    async setCursorTheme(cursor: string) {
        this.state.cursorTheme = cursor
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", cursor])
        this.saveSettings()
        this.emit("changed")
    }

    async setQtTheme(theme: string) {
        this.fcConfig.qtTheme = theme
        this.saveSettings(true)
        this.emit("changed")
    }

    async setFont(fontName: string) {
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "font-name", fontName])
        if (this.state.themeFamily) this.updateSettingsIni(this.state.themeFamily)
        this.emit("changed")
    }

    async setMonoFont(fontName: string) {
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "monospace-font-name", fontName])
        this.emit("changed")
    }

    async setDarkMode(dark: boolean) {
        this.state.isDark = dark
        const scheme = dark ? "prefer-dark" : "prefer-light"
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])
        this.saveSettings()
        await this.syncGtkTheme()
    }

    private persistenceDebounceId = 0
    private schedulePersistence() {
        if (this.persistenceDebounceId > 0) GLib.source_remove(this.persistenceDebounceId)
        this.persistenceDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            console.log(`[ThemeManager] Token persistence triggered`)
            this.saveSettings()
            this.persistenceDebounceId = 0
            return GLib.SOURCE_REMOVE
        })
    }

    async setAccentColor(accent: AccentKey) {
        this.fcConfig.accent = accent
        this.ensureProvidersLinked()
        this.themeProvider.load_from_string(generateTokensCss(this.fcConfig, this.state.isDark))
        this.schedulePersistence()
        this.emit("changed")
    }

    async setTransparency(value: number) {
        this.fcConfig.transparency = Math.max(0, Math.min(1, value))
        console.log(`[ThemeManager] Updating Transparency: ${this.fcConfig.transparency}`)
        this.ensureProvidersLinked()
        const tokens = generateTokensCss(this.fcConfig, this.state.isDark)
        this.themeProvider.load_from_data(tokens, tokens.length)
        this.schedulePersistence()
        this.emit("changed")
    }

    async setTintStrength(value: number) {
        this.fcConfig.tintStrength = Math.max(0, Math.min(1, value))
        this.refreshTintCss()
        this.saveSettings()
        this.emit("changed")
    }

    async setTintPanel(panel: keyof TintPanels, enabled: boolean) {
        this.fcConfig.tintPanels[panel] = enabled
        this.refreshTintCss()
        this.saveSettings()
        this.emit("changed")
    }

    // ── Internal Logic ───────────────────────────────────────────────

    private ensureProvidersLinked() {
        if (this.providersLinked) return
        try {
            const display = Gdk.Display.get_default()
            if (display) {
                const priority = Gtk.STYLE_PROVIDER_PRIORITY_USER
                const highPriority = priority + 10
                const tokenPriority = priority + 30

                Gtk.StyleContext.add_provider_for_display(display, this.mainProvider, highPriority)
                Gtk.StyleContext.add_provider_for_display(display, this.fontProvider, highPriority)
                Gtk.StyleContext.add_provider_for_display(display, this.themeProvider, tokenPriority)
                Gtk.StyleContext.add_provider_for_display(display, this.tintProvider, priority)
                
                // V921: Environment Isolation (Dev Sandbox)
                const isDevMode = GLib.getenv("CRYSTAL_DEV_MODE") === "1";
                const activeDir = GLib.get_current_dir();

                let configPaths: string[] = [];

                if (isDevMode) {
                    console.log("[ThemeManager] Dev mode: loading local style.css");
                    configPaths = [`${activeDir}/style.css`];
                } else {
                    // Production behavior: crystal-shell config dir first, fallback to cwd
                    configPaths = [
                        `${GLib.get_user_config_dir()}/crystal-shell/ui/ags-v3/style.css`,
                        `${activeDir}/style.css`
                    ];
                }
                
                for (const stylePath of configPaths) {
                    if (GLib.file_test(stylePath, GLib.FileTest.EXISTS)) {
                        this.mainProvider.load_from_path(stylePath)
                        console.log(`[ThemeManager] Static style.css loaded from: ${stylePath}`)
                        break
                    }
                }
                this.providersLinked = true
            }
        } catch (e) { console.error(e) }
    }

    private refreshTintCss() {
        this.ensureProvidersLinked()
        const tintCss = generateTintCss(this.fcConfig)
        if (this._lastTintCss !== tintCss) {
            this.tintProvider.load_from_string(tintCss)
            this._lastTintCss = tintCss
        }
    }

    private async syncGtkTheme() {
        const theme = this.state.themeFamily

        this.ensureProvidersLinked()
        const tokensCss = generateTokensCss(this.fcConfig, this.state.isDark)
        if (this._lastTokensCss !== tokensCss) {
            this.themeProvider.load_from_string(tokensCss)
            this._lastTokensCss = tokensCss
        }
        this.refreshTintCss()
        GLib.unsetenv("GTK_THEME")

        try {
            if (theme) {
                const current = this.interfaceSettings.get_string("gtk-theme")
                if (current !== theme) {
                    await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", theme])
                }
                this.updateSettingsIni(theme)
                const settings = Gtk.Settings.get_default()
                if (settings) settings.gtk_theme_name = theme
            }
            
            // USE Adw.StyleManager exclusively for dark-mode coordination
            Adw.StyleManager.get_default().set_color_scheme(
                this.state.isDark ? Adw.ColorScheme.PREFER_DARK : Adw.ColorScheme.PREFER_LIGHT
            )
        } catch (e) { }
        writeQtSettings(this.fcConfig, this.state.iconTheme)
    }

    private updateSettingsIni(theme: string) {
        const ini = `[Settings]\ngtk-theme-name=${theme}\ngtk-icon-theme-name=${this.state.iconTheme}\ngtk-font-name=${this.interfaceFont}\n`
        for (const d of ["gtk-3.0", "gtk-4.0"]) {
            writeFile(`${GLib.get_user_config_dir()}/${d}/settings.ini`, ini)
        }
    }

    private _isReady = false
    get isReady() { return this._isReady }

    private async applyAll() {
        await this.syncGtkTheme()
        const settings = this.interfaceSettings
        if (settings.get_string("icon-theme") !== this.state.iconTheme) execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", this.state.iconTheme])
        if (settings.get_string("cursor-theme") !== this.state.cursorTheme) execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", this.state.cursorTheme])
        const target = this.state.isDark ? "prefer-dark" : "prefer-light"
        if (settings.get_string("color-scheme") !== target) execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", target])
        
        this._isReady = true
        this.emit("ready")
        console.log("[ThemeManager] Global Styles READY! ")
    }

    private saveSettings(syncQt = false) {
        const dir = `${GLib.get_user_config_dir()}/crystal-shell`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        const merged = {
            ...this.state,
            accent: this.fcConfig.accent,
            transparency: this.fcConfig.transparency,
            tintStrength: this.fcConfig.tintStrength,
            tintPanels: this.fcConfig.tintPanels,
            qtTheme: this.fcConfig.qtTheme,
        }
        writeFile(this.configPath, JSON.stringify(merged, null, 2))
        if (syncQt) writeQtSettings(this.fcConfig, this.state.iconTheme)
    }

    private loadSettings() {
        const systemQt = getSystemQtTheme()
        try {
            let data: Record<string, unknown> = {}

            if (GLib.file_test(this.configPath, GLib.FileTest.EXISTS)) {
                data = JSON.parse(readFile(this.configPath))
            } else {
                // Migrate from old split files if they exist
                const oldFcPath = `${GLib.get_user_config_dir()}/crystal-shell/fluid-crystal.json`
                const oldThemePath = `${GLib.get_user_config_dir()}/crystal-shell/theme_settings.json`
                if (GLib.file_test(oldFcPath, GLib.FileTest.EXISTS))
                    data = { ...data, ...JSON.parse(readFile(oldFcPath)) }
                if (GLib.file_test(oldThemePath, GLib.FileTest.EXISTS))
                    data = { ...data, ...JSON.parse(readFile(oldThemePath)) }
                if (Object.keys(data).length === 0) this.syncFromSystem()
            }

            this.state = {
                themeFamily: (data.themeFamily as string) ?? this.state.themeFamily,
                iconTheme:   (data.iconTheme as string)   ?? this.state.iconTheme,
                cursorTheme: (data.cursorTheme as string) ?? this.state.cursorTheme,
                isDark:      (data.isDark as boolean)     ?? this.state.isDark,
            }
            this.fcConfig = {
                accent:      (data.accent as AccentKey)                  ?? DEFAULT_CONFIG.accent,
                transparency:(data.transparency as number)               ?? DEFAULT_CONFIG.transparency,
                tintStrength:(data.tintStrength as number)               ?? DEFAULT_CONFIG.tintStrength,
                tintPanels:  (data.tintPanels as typeof DEFAULT_CONFIG.tintPanels) ?? DEFAULT_CONFIG.tintPanels,
                qtTheme:     systemQt || (data.qtTheme as string)        || DEFAULT_CONFIG.qtTheme,
            }
        } catch (e) {
            this.syncFromSystem()
            if (systemQt) this.fcConfig.qtTheme = systemQt
        }
    }

    private syncFromSystem() {
        try {
            const s = this.interfaceSettings
            this.state.iconTheme = s.get_string("icon-theme")
            this.state.cursorTheme = s.get_string("cursor-theme")
            this.state.isDark = s.get_string("color-scheme") === "prefer-dark"
            const gtk = s.get_string("gtk-theme")
            if (gtk) this.state.themeFamily = gtk
        } catch (e) { }
    }
}

export const Theme = new ThemeManager()
export default Theme
