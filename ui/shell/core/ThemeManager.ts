import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { Gdk, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
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
} from "./FluidCrystal"
import { SHELL_ROOT } from "./Paths"
import hs from "./HyprlandState"

// ── CONSTANTS ────────────────────────────────────────────────────────
// No default theme forced — themeFamily is read from system on first run via syncFromSystem()

// ── DARK/LIGHT: the one allowed way to set it in-process ────────────────────
// The shell is libadwaita-free, but AGS's own runtime (lib/gtk4/app.ts) calls
// Adw.init() whenever libadwaita exists on the system — we can't opt out. An
// initialized libadwaita OWNS GtkSettings:gtk-application-prefer-dark-theme:
// writing it directly logs Adwaita-WARNING and risks being overridden. So:
// route through AdwStyleManager when Adw is initialized, and fall back to plain
// Gtk.Settings on systems without libadwaita (where AGS's init no-ops).
let adwStyleManager: any | null | undefined // undefined = not probed yet
let adwForceDark = 0
let adwForceLight = 0
async function probeAdwStyleManager(): Promise<any | null> {
    if (adwStyleManager !== undefined) return adwStyleManager
    try {
        const Adw = (await import("gi://Adw?version=1")).default as any
        adwStyleManager = Adw.is_initialized() ? Adw.StyleManager.get_default() : null
        adwForceDark = Adw.ColorScheme.FORCE_DARK
        adwForceLight = Adw.ColorScheme.FORCE_LIGHT
    } catch {
        adwStyleManager = null
    }
    return adwStyleManager
}

export async function setPreferDark(dark: boolean) {
    const sm = await probeAdwStyleManager()
    if (sm) {
        sm.color_scheme = dark ? adwForceDark : adwForceLight
    } else {
        const gtkSettings = Gtk.Settings.get_default()
        if (gtkSettings) gtkSettings.gtk_application_prefer_dark_theme = dark
    }
}

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
        const stylePath = `${SHELL_ROOT}/style.css`
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
            this.fontProvider.load_from_string(fontCss)
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

    getAvailableCursorSizes(): string[] {
        const sizes = ["16", "24", "32", "48", "64"]
        const current = String(this.cursorSize)
        if (!sizes.includes(current)) sizes.push(current)
        return sizes.sort((a, b) => Number(a) - Number(b))
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
    get cursorSize(): number { return this.interfaceSettings.get_int("cursor-size") || 24 }
    get isDark() { return this.state.isDark }
    get accentColor(): AccentKey { return this.fcConfig.accent }
    get transparency() { return this.fcConfig.transparency }
    get shellOpacity() { return this.fcConfig.shellOpacity }
    get dockOpacity()  { return this.fcConfig.dockOpacity }
    get tintStrength() { return this.fcConfig.tintStrength }
    get tintPanels() { return this.fcConfig.tintPanels }
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
            this.saveSettings()
            this.emit("changed")
        } catch (e) { console.error(e) }
    }

    async setCursorTheme(cursor: string) {
        this.state.cursorTheme = cursor
        const size = this.interfaceSettings.get_int("cursor-size") || 24
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", cursor])
        // Three different consumers, three different mechanisms:
        //  - gsettings      → GTK/GNOME Wayland apps
        //  - hyprctl        → Hyprland's live compositor cursor
        //  - Xcursor default → XWayland/X apps (Steam, etc.), which ignore the other two
        this.writeXcursorDefault(cursor)
        hs.setCursor(cursor, size)
        if (this.state.themeFamily) this.updateSettingsIni(this.state.themeFamily)
        this.saveSettings()
        this.emit("changed")
    }

    async setCursorSize(size: number) {
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-size", String(size)])
        // Same three consumers as the theme — push the size everywhere it's read.
        if (this.state.cursorTheme) hs.setCursor(this.state.cursorTheme, size)
        if (this.state.themeFamily) this.updateSettingsIni(this.state.themeFamily)
        this.emit("changed")
    }

    /**
     * Pin the "default" Xcursor theme that XWayland and legacy X apps resolve against.
     * Without this, those apps stay on whatever Inherits= was last written (e.g. by
     * nwg-look) regardless of gsettings/hyprctl — which is why Steam ignored the picker.
     */
    private writeXcursorDefault(cursor: string) {
        const dir = `${GLib.get_home_dir()}/.local/share/icons/default`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        writeFile(`${dir}/index.theme`,
            `[Icon Theme]\nName=Default\nComment=Default Cursor Theme\nInherits=${cursor}\n`)
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

    get textScaling(): number {
        try { return this.interfaceSettings.get_double("text-scaling-factor") } catch (_) { return 1.0 }
    }

    async setTextScaling(factor: number) {
        const rounded = Math.round(factor * 100) / 100
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "text-scaling-factor", String(rounded)])
        this.emit("changed")
    }

    async setDarkMode(dark: boolean) {
        this.state.isDark = dark
        const scheme = dark ? "prefer-dark" : "prefer-light"
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme])
        this.saveSettings()
        await this.syncGtkTheme()
        // The GTK3 file chooser served by xdg-desktop-portal-gtk reads the dark-theme flag
        // once at process start and never re-reads settings.ini, so it stays stuck on the
        // previous mode. Restart it so the next portal-driven picker matches the new mode.
        execAsync(["systemctl", "--user", "restart", "xdg-desktop-portal-gtk.service"]).catch(() => {})
        this.emit("changed")
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
        this.applyTokens()
        execAsync(["gsettings", "set", "org.gnome.desktop.interface", "accent-color", accent]).catch(() => {})
        this.schedulePersistence()
        this.emit("changed")
    }

    async setTransparency(value: number) {
        this.fcConfig.transparency = Math.max(0.10, Math.min(0.90, value))
        this.applyTokens()
        this.schedulePersistence()
        this.emit("changed")
    }

    async setShellOpacity(value: number) {
        this.fcConfig.shellOpacity = Math.max(0.06, Math.min(0.75, value))
        this.applyTokens()
        this.schedulePersistence()
        this.emit("changed")
    }

    async setDockOpacity(value: number) {
        this.fcConfig.dockOpacity = Math.max(0.05, Math.min(0.60, value))
        this.applyTokens()
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
                
                // style.css resolves against SHELL_ROOT (source tree in dev,
                // /usr/share in prod). install.sh ships style.css into both.
                const stylePath = `${SHELL_ROOT}/style.css`
                if (GLib.file_test(stylePath, GLib.FileTest.EXISTS)) {
                    this.mainProvider.load_from_path(stylePath)
                    console.log(`[ThemeManager] Static style.css loaded from: ${stylePath}`)
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

    /** Regenerate + apply the Fluid Crystal token CSS (accent / opacities), deduped. */
    private applyTokens() {
        this.ensureProvidersLinked()
        const tokens = generateTokensCss(this.fcConfig, this.state.isDark)
        if (this._lastTokensCss !== tokens) {
            this.themeProvider.load_from_string(tokens)
            this._lastTokensCss = tokens
        }
    }

    private async syncGtkTheme() {
        const theme = this.state.themeFamily

        this.applyTokens()
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
            
            // Dark/light via setPreferDark — AdwStyleManager when AGS init'd
            // libadwaita, plain Gtk.Settings otherwise (see helper above).
            await setPreferDark(this.state.isDark)
        } catch (e) { }
    }

    private updateSettingsIni(theme: string) {
        // GTK3 apps (and the GTK3 file chooser served by xdg-desktop-portal-gtk) don't
        // read the portal's color-scheme — they switch dark/light via this flag. Without
        // it, every GTK3 surface renders light Adwaita even though gsettings says prefer-dark.
        const cursorSize = this.interfaceSettings.get_int("cursor-size") || 24
        let ini = `[Settings]\n`
            + `gtk-theme-name=${theme}\n`
            + `gtk-application-prefer-dark-theme=${this.state.isDark ? 1 : 0}\n`
            + `gtk-icon-theme-name=${this.state.iconTheme}\n`
            + `gtk-font-name=${this.interfaceFont}\n`
        if (this.state.cursorTheme) {
            ini += `gtk-cursor-theme-name=${this.state.cursorTheme}\n`
                + `gtk-cursor-theme-size=${cursorSize}\n`
        }
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
        // Apply the cursor to Hyprland + the Xcursor default, so apps started later
        // (Steam, etc.) inherit it instead of a stale default. gsettings alone misses them.
        if (this.state.cursorTheme) {
            this.writeXcursorDefault(this.state.cursorTheme)
            hs.setCursor(this.state.cursorTheme, settings.get_int("cursor-size") || 24)
        }
        const target = this.state.isDark ? "prefer-dark" : "prefer-light"
        if (settings.get_string("color-scheme") !== target) execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", target])
        if (settings.get_string("accent-color") !== this.fcConfig.accent) execAsync(["gsettings", "set", "org.gnome.desktop.interface", "accent-color", this.fcConfig.accent]).catch(() => {})

        this._isReady = true
        this.emit("ready")
        console.log("[ThemeManager] Global Styles READY! ")
    }

    private saveSettings() {
        const dir = `${GLib.get_user_config_dir()}/crystal-shell`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        const merged = {
            ...this.state,
            accent: this.fcConfig.accent,
            transparency: this.fcConfig.transparency,
            shellOpacity: this.fcConfig.shellOpacity,
            dockOpacity: this.fcConfig.dockOpacity,
            tintStrength: this.fcConfig.tintStrength,
            tintPanels: this.fcConfig.tintPanels,
        }
        const json = JSON.stringify(merged, null, 2)
        writeFile(this.configPath, json)

        // Mirror to /var/tmp so the greeter (which runs as a system user without
        // access to the user home dir) can read the accent on next login screen.
        try {
            const sharedDir = "/var/tmp/crystal-shell"
            if (!GLib.file_test(sharedDir, GLib.FileTest.EXISTS))
                GLib.mkdir_with_parents(sharedDir, 0o755)
            writeFile(`${sharedDir}/appearance.json`, json)
        } catch (e) {
            console.warn("[ThemeManager] could not write shared appearance:", e)
        }
    }

    private loadSettings() {
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
                accent:       (data.accent as AccentKey)                  ?? DEFAULT_CONFIG.accent,
                transparency: (data.transparency as number)              ?? DEFAULT_CONFIG.transparency,
                shellOpacity: (data.shellOpacity as number)              ?? DEFAULT_CONFIG.shellOpacity,
                dockOpacity:  (data.dockOpacity as number)               ?? DEFAULT_CONFIG.dockOpacity,
                tintStrength: (data.tintStrength as number)              ?? DEFAULT_CONFIG.tintStrength,
                tintPanels:   (data.tintPanels as typeof DEFAULT_CONFIG.tintPanels) ?? DEFAULT_CONFIG.tintPanels,
            }
        } catch (e) {
            this.syncFromSystem()
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
            const sysAccent = s.get_string("accent-color") as AccentKey
            if (sysAccent && sysAccent in ACCENT_PALETTE) this.fcConfig.accent = sysAccent
        } catch (e) { }
    }
}

export const Theme = new ThemeManager()
export default Theme
