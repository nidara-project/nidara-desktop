import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import { execAsync } from "../../lib/process"
import { readFile, writeFile } from "../../lib/file"
import { applyCrispFontRendering } from "../../lib/font-rendering"
import {
    type NidaraThemeConfig,
    type AccentKey,
    type ShellAppearance,
    DEFAULT_CONFIG,
    GLASS_MODEL,
    clampGlass,
    readGlass,
    ACCENT_PALETTE,
    generateTokensCss,
    generateChromeTokenScope,
} from "./NidaraTheme"
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

/**
 * The range the Accessibility text slider offers, and the range the reflowing
 * windows are known to survive. ⚠️ MEASURED, not chosen — see the comment on the
 * slider in `pages/Accessibility.tsx` and tech-debt #62. It lives here because
 * `applyAll` has to clamp a value stored by an older build (the slider used to go
 * to 2.0) — a factor above the maximum is a state the UI cannot represent.
 */
export const TEXT_SCALE_MIN = 0.75
export const TEXT_SCALE_MAX = 1.5

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
 * ThemeManager — GTK theme, dark mode, and Nidara token management
 * Orchestrates GTK theming, Nidara token engine, and GSettings.
 */
class ThemeManager extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: "ThemeManager",
            Signals: { 
                "changed": {},
                "ready": {},
                // Emitted once `hyprctl setcursor` has RESOLVED — `changed` fires with
                // that write still in flight. Consumed by common/CursorRefresh.ts.
                "cursor-applied": {}
            }
        }, this)
    }

    private state: ThemeState = {
        themeFamily: "",   // populated by syncFromSystem() on first run
        iconTheme: "",     // populated by syncFromSystem() on first run
        cursorTheme: "",   // populated by syncFromSystem() on first run
        isDark: true,
    }

    private fcConfig: NidaraThemeConfig = { ...DEFAULT_CONFIG }
    private configPath = `${GLib.get_user_config_dir()}/nidara/appearance.json`
    private _lastTokensCss: string = ""

    private mainProvider = new Gtk.CssProvider()
    private fontProvider = new Gtk.CssProvider()
    private themeProvider = new Gtk.CssProvider()
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

    /**
     * Round the font's ascent/descent to whole pixels, so a line box is an integer
     * and the baseline lands ON a pixel row.
     *
     * 🔑 This is the mechanism behind years of "the tops of the letters look
     * shaved". Measured with the SAME font at the SAME size (14.667px — what the
     * 11pt default resolves to at 96dpi):
     *
     *   hint metrics OFF → ascent 14.208984375 → the T's crossbar smears across two
     *                      rows (`#######+` over `+++##++.`)
     *   hint metrics ON  → ascent 15.0        → one crisp row (`.########`)
     *
     * Flat-topped glyphs (T E F H I L) are where it shows, because their top row is
     * a full-width bar and losing half its coverage is obvious. Round ones (G O C S)
     * put three or four pixels up there and look fine — which is why it reads as
     * "the T is cut but the G isn't" rather than as blurry text.
     *
     * GTK turns this off to serve fractional display scaling; we never asked for it
     * either way and inherited whatever the default was.
     */
    private syncFontMetrics() {
        // One lever, shared by all three bundles — see ui/lib/font-rendering.ts for
        // why `gtk-hint-font-metrics` alone did nothing for months.
        applyCrispFontRendering()
    }

    private syncFont() {
        this.syncFontMetrics()
        try {
            const fontName = this.interfaceSettings.get_string("font-name")
            // ⚠️ PARSE WITH PANGO, NEVER A REGEX. `gtk-font-name` is a Pango font
            // string, and only its simplest form is "Family <int>". A style word
            // ("Inter Variable Medium 11"), a fractional size ("Inter 11.5") or a
            // variation axis ("… @wght=500") are all legal — and the font button in
            // Settings → Appearance emits exactly those. The old
            // `/^(.*?) (\d+)$/` matched none of them and fell through to
            // "sans-serif", so picking a font could SILENTLY drop the whole desktop
            // onto fontconfig's default (measured 2026-08-11: a machine set to
            // "Inter Variable Medium 11 @wght=500" had been rendering Noto Sans for
            // months, and the only trace was this log line saying `sans-serif`).
            // Nothing warned because falling back is what the code did on purpose.
            const family = Pango.FontDescription.from_string(fontName).get_family() || "sans-serif"
            const fontCss = `* { font-family: "${family}", "Symbols Nerd Font", sans-serif; }`

            this.ensureProvidersLinked()
            this.fontProvider.load_from_string(fontCss)
            console.log(`[ThemeManager] Font Sync: ${family}`)
        } catch (e) { }
    }

    // ── Discovery API ────────────────────────────────────────────────

    getAvailableGtkThemes(): string[] {
        const paths = ["/usr/share/themes", `${GLib.get_home_dir()}/.local/share/themes`, `${GLib.get_home_dir()}/.themes`]
        return this.listDirs(paths).filter(t => !["Default", "Emacs", "nidara"].includes(t))
    }

    getAvailableIconThemes(): string[] {
        const paths = ["/usr/share/icons", `${GLib.get_home_dir()}/.local/share/icons`, `${GLib.get_home_dir()}/.icons`]
        // System plumbing, never user-selectable: "default" is the Xcursor pointer
        // (we write it ourselves in writeXcursorDefault), "hicolor" is the freedesktop
        // fallback every theme inherits, "nidara" is our per-app icon overlay.
        const reserved = ["default", "hicolor", "nidara"]
        const themes = this.listDirs(paths).filter(t => {
            if (reserved.includes(t)) return false
            for (const p of paths) {
                if (this.isRealIconTheme(`${p}/${t}/index.theme`)) return true
            }
            return false
        })
        // Keep the configured theme selectable even if it no longer passes the
        // filter (e.g. it was uninstalled or is Hidden) so the dropdown can
        // still display the current value.
        const current = this.state.iconTheme
        if (current && !themes.includes(current)) themes.push(current)
        return themes.sort()
    }

    /**
     * A directory only counts as a selectable icon theme if its index.theme has an
     * [Icon Theme] group with a Directories key (cursor pointers like "default" only
     * carry Inherits=) and is not marked Hidden per the icon-theme spec.
     */
    private isRealIconTheme(indexPath: string): boolean {
        if (!GLib.file_test(indexPath, GLib.FileTest.EXISTS)) return false
        try {
            const kf = new GLib.KeyFile()
            kf.load_from_file(indexPath, GLib.KeyFileFlags.NONE)
            if (!kf.has_group("Icon Theme")) return false
            if (kf.get_string("Icon Theme", "Directories").trim() === "") return false
            try {
                if (kf.get_boolean("Icon Theme", "Hidden")) return false
            } catch (e) { } // Hidden key absent → not hidden
            return true
        } catch (e) {
            return false // unreadable or no Directories key → not a real icon theme
        }
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

    // `getAvailableCursorSizes()` lived here and is gone (2026-08-16). It fed the
    // Appearance dropdown a fixed 16/24/32/48/64 and then had to append whatever
    // value it actually found, because the OTHER control over the same setting —
    // Accessibility's 16–96 slider — could land on 37. A list that has to be
    // patched with the live value is a control admitting it is not the only one.
    // The slider is now the single owner, and a continuous range needs no list.

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
    get barOpacity()     { return this.fcConfig.barOpacity }
    get overlayOpacity() { return this.fcConfig.overlayOpacity }
    get dockOpacity()    { return this.fcConfig.dockOpacity }
    get windowOpacity()  { return this.fcConfig.windowOpacity }
    get shellAppearance(): ShellAppearance { return this.fcConfig.shellAppearance }

    /** Effective dark/light for the WHOLE shell skin (bar, dock, overlays),
     *  honouring shellAppearance ("system" = the app/global mode). Shell painters
     *  (SquircleContainer, dock + CC + NC + app-grid Cairo) read this instead of
     *  `isDark` so a pinned shell flips text AND glass together. App-mode windows
     *  (Settings, About) keep `isDark`. Opacity stays WYSIWYG with the slider. */
    get chromeIsDark(): boolean {
        const a = this.fcConfig.shellAppearance
        return a === "dark" ? true : a === "light" ? false : this.state.isDark
    }

    /** Effective dark/light for the SURFACE a widget is painted on. Cairo widgets
     *  shared between the shell skin and app-mode windows (the slider, drawn into
     *  both the CC/system-menu AND Settings) can't use one global flag: a slider in
     *  a shell overlay must follow the shell pin (chromeIsDark), while the same
     *  component in Settings/About follows the app/system mode (isDark). Resolved by
     *  the widget's ROOT window name — overlays are children of `nidara-bar`, the
     *  app grid of `nidara-dock`; anything else (Settings/About/unrealized) → isDark. */
    surfaceIsDark(widget: Gtk.Widget): boolean {
        try {
            const name = (widget.get_root() as Gtk.Window | null)?.get_name?.() ?? ""
            if (name === "nidara-bar" || name === "nidara-dock") return this.chromeIsDark
        } catch (_) { /* not realized yet → fall through to the app/system mode */ }
        return this.state.isDark
    }
    get accentPalette() { return ACCENT_PALETTE }
    /** The interface font as stored: family + POINT size, unscaled. The
     *  accessibility text scale is applied downstream by GTK, via the dpi — it is
     *  deliberately not folded in here (see `fontToPoints`). */
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
        hs.setCursor(cursor, size).then(() => this.emit("cursor-applied"))
        if (this.state.themeFamily) this.updateSettingsIni(this.state.themeFamily)
        this.saveSettings()
        this.emit("changed")
    }

    async setCursorSize(size: number) {
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-size", String(size)])
        // Same three consumers as the theme — push the size everywhere it's read.
        if (this.state.cursorTheme) hs.setCursor(this.state.cursorTheme, size).then(() => this.emit("cursor-applied"))
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

    /**
     * Rewrite a font string so its size is in POINTS, whatever unit it arrived in.
     *
     * 🔑 The unit is load-bearing for accessibility, and this is the whole reason
     * the function exists. `text-scaling-factor` is applied by GTK by multiplying
     * `gtk-xft-dpi` (gdkdisplay-wayland folds it in), and an absolute PIXEL size is
     * immune to dpi by definition. So when #123 started storing "Inter 14px" the
     * Accessibility text slider went dead — and the workaround for that (Nidara
     * rescaling both fonts itself from an unscaled base) made the slider WORSE than
     * dead: the effective size was `round(basePx × factor)`, so with a 15px base the
     * whole 0.75–2.0 range held 20 distinct sizes and ~5 of every 6 thumb positions
     * changed nothing. A pixel is the smallest step there is; a factor needs a
     * smaller one. In points the factor lands in the dpi, where it belongs, and the
     * slider is continuous again with no code of ours in the path.
     *
     * ⚠️ The px form was introduced to put the type ramp on whole pixels FOR CRISP
     * TEXT. That was the wrong lever, measured: at a fractional 14.667px,
     * `gtk-hint-font-metrics` already rounds the ascent to 15.0 and the T's crossbar
     * lands on one row (see `syncFontMetrics` and ui/lib/font-rendering.ts).
     * Crispness comes from the hint, not from the size — so points cost nothing.
     *
     * Whole points, because that is the granularity every font picker offers; the
     * historical default "Inter 11" is what 15px rounds back to.
     */
    private fontToPoints(fontName: string): string {
        try {
            const desc = Pango.FontDescription.from_string(fontName)
            if (!desc.get_size_is_absolute()) return fontName
            const px = desc.get_size() / Pango.SCALE
            const pt = Math.round(px * 72 / this.unscaledDpi())
            if (!(pt > 0)) return fontName
            desc.set_size(pt * Pango.SCALE)
            return desc.to_string()
        } catch (e) {
            return fontName
        }
    }

    /**
     * `gtk-xft-dpi` with the accessibility text scale taken back out.
     *
     * ⚠️ GTK folds `text-scaling-factor` INTO the dpi, so converting px→pt against
     * the raw value while the slider is up would bake the scale into the stored
     * size — and then GTK would scale it a second time.
     */
    private unscaledDpi(): number {
        const scaledDpi = (Gtk.Settings.get_default()?.gtk_xft_dpi ?? 96 * 1024) / 1024
        return scaledDpi / (this.textScaling || 1)
    }

    /**
     * Migrate a font stored in absolute pixels back to points.
     *
     * Needed because #123/#124 wrote "<family> 15px" into gsettings on machines that
     * already ran them, and `applyAll`'s seed only fires when the key has no user
     * value — so without this an upgrading user keeps the pixel size and keeps the
     * dead text slider. Idempotent: a point-sized font is returned untouched, so
     * this can run on every boot. It also picks up a px font set by another tool
     * (nwg-look, GNOME Tweaks, a dotfile).
     */
    private migrateFontsToPoints() {
        for (const key of ["font-name", "monospace-font-name"]) {
            const live = this.interfaceSettings.get_string(key)
            const pts = this.fontToPoints(live)
            if (pts !== live) {
                console.log(`[ThemeManager] ${key}: "${live}" → "${pts}" (px → pt, so text scaling works)`)
                this.interfaceSettings.set_string(key, pts)
            }
        }
    }

    async setFont(fontName: string) {
        this.interfaceSettings.set_string("font-name", this.fontToPoints(fontName))
        if (this.state.themeFamily) this.updateSettingsIni(this.state.themeFamily)
        this.emit("changed")
    }

    async setMonoFont(fontName: string) {
        this.interfaceSettings.set_string("monospace-font-name", this.fontToPoints(fontName))
        this.emit("changed")
    }

    get textScaling(): number {
        try { return this.interfaceSettings.get_double("text-scaling-factor") } catch (_) { return 1.0 }
    }

    async setTextScaling(factor: number) {
        const rounded = Math.round(factor * 100) / 100
        // ⚠️ In-process `set_double`, NOT `execAsync(["gsettings", …])`. This runs on
        // every step of a drag, and spawning a subprocess per step is what forced the
        // slider to commit only on release — so the size jumped into place after the
        // fact instead of following the thumb.
        //
        // Nothing else to do: the fonts are stored in POINTS (fontToPoints), so GTK
        // applies the factor itself through `gtk-xft-dpi`, continuously. settings.ini
        // needs no rewrite either — it carries the unscaled point size, and a GTK3
        // app reads the factor from the same portal we just wrote to.
        this.interfaceSettings.set_double("text-scaling-factor", rounded)
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
        this.syncHyprlandGroupAccent()
        execAsync(["gsettings", "set", "org.gnome.desktop.interface", "accent-color", accent]).catch(() => {})
        this.schedulePersistence()
        this.emit("changed")
    }

    /** Push the accent into Hyprland's groupbar (active tab = persistent
     *  selection — the one place accent enters compositor chrome; window
     *  borders stay neutral glass on purpose). The rest of the groupbar
     *  styling is static in hyprland.lua's `group` block. Gotcha: a groupbar
     *  bakes its colors at group creation, so this colors FUTURE groups —
     *  existing ones keep the old accent until recreated. */
    private syncHyprlandGroupAccent() {
        const hex = ACCENT_PALETTE[this.fcConfig.accent].color.slice(1)
        const col = `rgba(${hex}99)`
        hs.evalLua(`hl.config({ group = { groupbar = { col = { active = '${col}', locked_active = '${col}' } } } })`)
    }

    // One opacity range for every shell surface. The bounds and the reason the
    // floor is what it is live in ONE place — `GLASS_RANGE` in NidaraTheme.ts.
    private clampOpacity(v: number) { return clampGlass(v) }

    async setBarOpacity(value: number) {
        this.fcConfig.barOpacity = this.clampOpacity(value)
        this.applyTokens()
        this.schedulePersistence()
        this.emit("changed")
    }

    async setOverlayOpacity(value: number) {
        this.fcConfig.overlayOpacity = this.clampOpacity(value)
        this.applyTokens()
        this.schedulePersistence()
        this.emit("changed")
    }

    async setDockOpacity(value: number) {
        this.fcConfig.dockOpacity = this.clampOpacity(value)
        this.applyTokens()
        this.schedulePersistence()
        this.emit("changed")
    }

    async setWindowOpacity(value: number) {
        this.fcConfig.windowOpacity = this.clampOpacity(value)
        this.applyTokens()
        this.schedulePersistence()
        this.emit("changed")
    }

    /** Master "Glass" control: set every surface (bar + overlays + dock + window). */
    async setGlassOpacity(value: number) {
        const v = this.clampOpacity(value)
        this.fcConfig.barOpacity = v
        this.fcConfig.overlayOpacity = v
        this.fcConfig.dockOpacity = v
        this.fcConfig.windowOpacity = v
        this.applyTokens()
        this.schedulePersistence()
        this.emit("changed")
    }

    async setShellAppearance(value: ShellAppearance) {
        this.fcConfig.shellAppearance = value
        // Regenerates the scoped chrome override; "changed" repaints the bar/dock
        // Cairo (capsule glass + dock plates + running dots read chromeIsDark live).
        this.applyTokens()
        this.schedulePersistence()
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

    /** Regenerate + apply the Nidara token CSS (accent / opacities), deduped. */
    private applyTokens() {
        this.ensureProvidersLinked()
        const tokens = generateTokensCss(this.fcConfig, this.state.isDark)
            + "\n" + generateChromeTokenScope(this.fcConfig, this.chromeIsDark, this.state.isDark)
        if (this._lastTokensCss !== tokens) {
            this.themeProvider.load_from_string(tokens)
            this._lastTokensCss = tokens
        }
    }

    private async syncGtkTheme() {
        const theme = this.state.themeFamily

        this.applyTokens()
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
            // On a clean install these dirs don't exist yet (no GTK app created them),
            // and writeFile would throw — swallowed by the caller's catch, leaving
            // settings.ini unwritten AND skipping setPreferDark. So GTK apps rendered
            // light Adwaita with no Papirus icons (clean-install bug, VM 06-22).
            const dir = `${GLib.get_user_config_dir()}/${d}`
            if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
            writeFile(`${dir}/settings.ini`, ini)
        }
    }

    private _isReady = false
    get isReady() { return this._isReady }

    private async applyAll() {
        // Seed Nidara's default interface font on first boot. Unlike icon-theme/accent,
        // the font isn't part of appearance.json — it's delegated to the GNOME gsetting,
        // whose schema default on GTK ≥4.22 is "Adwaita Sans 11". Seed Inter ONLY when the
        // user hasn't picked one (get_user_value === null distinguishes the factory default
        // from an explicit choice), so a deliberate pick is never clobbered on later boots.
        // Runs before syncGtkTheme so the settings.ini it writes also gets Inter.
        if (this.interfaceSettings.get_user_value("font-name") === null)
            // ⚠️ "Inter 11" — POINTS, and the same 11 every install has shipped since
            // PR #6. #123 replaced it with "14px" to put the type ramp on whole pixels
            // (which quietly shrank the default by 4.5%, since 11pt is 14.667px), and
            // #124 then moved it to "15px". Both were chasing crisp text through the
            // font SIZE; the lever turned out to be `gtk-hint-font-metrics`, which
            // rounds the ascent at a fractional size just as well. An absolute size
            // also kills the accessibility text scale outright — see `fontToPoints`.
            this.interfaceSettings.set_string("font-name", "Inter 11")
        // Same deal for the monospace font: the schema default ("Adwaita Mono 11")
        // names a font we don't even install, while ttf-jetbrains-mono-nerd ships
        // with every Nidara install. Seed it once; never clobber a user's pick.
        if (this.interfaceSettings.get_user_value("monospace-font-name") === null)
            this.interfaceSettings.set_string("monospace-font-name", "JetBrainsMono Nerd Font 11")

        // Undo #123/#124 on machines that already ran them: a font stored in absolute
        // pixels makes the accessibility text slider a no-op. Idempotent.
        this.migrateFontsToPoints()

        // Bring a factor stored by an older build (whose slider went to 2.0) back into
        // the range the layout actually survives. Only downwards, and logged: this
        // REDUCES someone's text size, so it must be findable in the log rather than
        // just mysterious.
        const scale = this.textScaling
        if (scale > TEXT_SCALE_MAX) {
            console.log(`[ThemeManager] text-scaling-factor ${scale} → ${TEXT_SCALE_MAX} (above the range the reflowing windows support)`)
            this.interfaceSettings.set_double("text-scaling-factor", TEXT_SCALE_MAX)
        }

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
        this.syncHyprlandGroupAccent()
        const target = this.state.isDark ? "prefer-dark" : "prefer-light"
        if (settings.get_string("color-scheme") !== target) execAsync(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", target])
        if (settings.get_string("accent-color") !== this.fcConfig.accent) execAsync(["gsettings", "set", "org.gnome.desktop.interface", "accent-color", this.fcConfig.accent]).catch(() => {})

        this._isReady = true
        this.emit("ready")
        console.log("[ThemeManager] Global Styles READY! ")
    }

    private saveSettings() {
        const dir = `${GLib.get_user_config_dir()}/nidara`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        const merged = {
            ...this.state,
            accent: this.fcConfig.accent,
            barOpacity: this.fcConfig.barOpacity,
            overlayOpacity: this.fcConfig.overlayOpacity,
            dockOpacity: this.fcConfig.dockOpacity,
            windowOpacity: this.fcConfig.windowOpacity,
            shellAppearance: this.fcConfig.shellAppearance,
            glassModel: GLASS_MODEL,
        }
        const json = JSON.stringify(merged, null, 2)
        writeFile(this.configPath, json)

        // Mirror to /var/tmp so the greeter (which runs as a system user without
        // access to the user home dir) can read the accent on next login screen.
        try {
            const sharedDir = "/var/tmp/nidara"
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
                const oldFcPath = `${GLib.get_user_config_dir()}/nidara/nidara.json`
                const oldThemePath = `${GLib.get_user_config_dir()}/nidara/theme_settings.json`
                if (GLib.file_test(oldFcPath, GLib.FileTest.EXISTS))
                    data = { ...data, ...JSON.parse(readFile(oldFcPath)) }
                if (GLib.file_test(oldThemePath, GLib.FileTest.EXISTS))
                    data = { ...data, ...JSON.parse(readFile(oldThemePath)) }
                if (Object.keys(data).length === 0) this.syncFromSystem()
            }

            const rawTheme = data.themeFamily as string
            this.state = {
                themeFamily: (rawTheme && rawTheme !== "nidara") ? rawTheme : (this.state.themeFamily || "Adwaita"),
                iconTheme:   (data.iconTheme as string)   ?? this.state.iconTheme,
                cursorTheme: (data.cursorTheme as string) ?? this.state.cursorTheme,
                isDark:      (data.isDark as boolean)     ?? this.state.isDark,
            }
            // ⚠️ The glass migration applies ONLY to a value that was actually
            // stored. Running it over DEFAULT_CONFIG would move a fresh install's
            // floor to 0.392 — the defaults are already expressed in the new model.
            const staleGlass = data.glassModel !== GLASS_MODEL
            const glass = (stored: unknown, dflt: number) => readGlass(stored, dflt, staleGlass)
            this.fcConfig = {
                accent:       (data.accent as AccentKey)                  ?? DEFAULT_CONFIG.accent,
                // Migrate: the old single `shellOpacity` seeds both bar + overlays.
                barOpacity:     glass(data.barOpacity     ?? data.shellOpacity, DEFAULT_CONFIG.barOpacity),
                overlayOpacity: glass(data.overlayOpacity ?? data.shellOpacity, DEFAULT_CONFIG.overlayOpacity),
                dockOpacity:    glass(data.dockOpacity,                         DEFAULT_CONFIG.dockOpacity),
                // Migrate the old `transparency` (transparency sense) → window OPACITY (1 − t).
                windowOpacity:  glass(data.windowOpacity ?? (typeof data.transparency === "number" ? 1 - (data.transparency as number) : undefined),
                                      DEFAULT_CONFIG.windowOpacity),
                shellAppearance: (data.shellAppearance as ShellAppearance) ?? DEFAULT_CONFIG.shellAppearance,
            }
            // Stamp the new model NOW, not through the 500 ms persistence debounce.
            // The migration is idempotent only because this marker stops it running a
            // second time (`0.2 + 0.8·0.24 = 0.392`), so a shell that died inside the
            // debounce window would come back and migrate an already-migrated file.
            // Its own try/catch: a stamp that cannot be written must not throw into the
            // outer catch, which would discard a config we just read correctly.
            if (staleGlass) {
                try { this.saveSettings() }
                catch (e) { console.warn("[ThemeManager] could not stamp glassModel:", e) }
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
            this.state.themeFamily = (gtk && gtk !== "nidara") ? gtk : "Adwaita"
            const sysAccent = s.get_string("accent-color") as AccentKey
            if (sysAccent && sysAccent in ACCENT_PALETTE) this.fcConfig.accent = sysAccent
        } catch (e) {
            this.state.themeFamily = "Adwaita"
        }
    }
}

export const Theme = new ThemeManager()
export default Theme
