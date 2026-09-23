import GObject from "gi://GObject"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import Gdk from "gi://Gdk?version=4.0"
import Gtk from "gi://Gtk?version=4.0"
import { execAsync } from "../../lib/process"
import { applyCrispFontRendering } from "../../lib/nidara-kit/platform/font-rendering"
import {
    type NidaraThemeConfig,
    type AccentKey,
    type ShellAppearance,
    DEFAULT_CONFIG,
    clampGlass,
    ACCENT_PALETTE,
    generateTokensCss,
    generateChromeTokenScope,
    CHROME_SCOPE_WINDOWS,
} from "./NidaraTheme"
import { SHELL_ROOT } from "./Paths"
import { defineSettings } from "./configFile"
import { GTK_BUILTIN_THEME } from "../../lib/nidara-kit/platform/gtk-theme"

// ── WHERE APPEARANCE LIVES (#573) ────────────────────────────────────
// Two homes, no file:
//  - what the desktop standard already names — accent, colour scheme, GTK / icon /
//    cursor theme, fonts — in `org.gnome.desktop.interface`, where every app reads it;
//  - what only Nidara has — the four glass opacities and the shell's own skin — in
//    `org.nidara.appearance`, below. bin/nidara-portal serves it to applications.
// A change made by `gsettings set`, an agent or another process reaches this class
// through `changed`, exactly like one made from Settings.
//
// ⚠️ This class is what ANY process needs to look like the desktop: the state, the
// setters (which only write keys), and its own CSS/GTK settings. What the change does to
// the rest of the desktop — settings.ini, the Xcursor default, Hyprland's cursor and
// groupbar, the portal-gtk restart, the greeter's mirror, first-boot font seeds — is
// core/AppearanceSync.ts, shell-only (#571). Do not add a file write, a subprocess or a
// compositor call here: in a second process it runs a second time.
// (appearance.json was imported once by migrations/2026-09-14c-appearance-to-gsettings.sh.)
interface NidaraAppearance {
    barOpacity: number
    overlayOpacity: number
    dockOpacity: number
    windowOpacity: number
    shellAppearance: ShellAppearance
}

const nidaraAppearance = defineSettings<NidaraAppearance>("appearance", {
    barOpacity: DEFAULT_CONFIG.barOpacity,
    overlayOpacity: DEFAULT_CONFIG.overlayOpacity,
    dockOpacity: DEFAULT_CONFIG.dockOpacity,
    windowOpacity: DEFAULT_CONFIG.windowOpacity,
    shellAppearance: DEFAULT_CONFIG.shellAppearance,
}, {
    shellAppearance: v => v === "system" || v === "dark" || v === "light",
})

/** The fields of `NidaraThemeConfig` that live in `org.nidara.appearance`. */
const NIDARA_KEYS = ["barOpacity", "overlayOpacity", "dockOpacity", "windowOpacity", "shellAppearance"] as const

// ── DARK/LIGHT in-process ────────────────────────────────────────────────────
// Plain `Gtk.Settings`. This used to probe libadwaita first (loading its typelib
// to ask `Adw.is_initialized()`), because AGS's host called `Adw.init()` and an
// initialised libadwaita owns this property. Our host never does
// (`ui/lib/nidara-kit/platform/host.ts`), so the probe could only ever answer "no" — at the price of
// mapping libadwaita into a process that uses none of it.
// ⚠️ With no GTK theme loaded (tech-debt #107) this repaints nothing of ours —
// our colours come from the token CSS. Kept as the process's honest statement of
// its mode; nothing of ours is known to depend on it any more (unmeasured).
export function setPreferDark(dark: boolean) {
    const gtkSettings = Gtk.Settings.get_default()
    if (gtkSettings) gtkSettings.gtk_application_prefer_dark_theme = dark
}

/**
 * The range the Accessibility text slider offers, and the range the reflowing
 * windows are known to survive. ⚠️ MEASURED, not chosen — see the bounds on
 * `accessibility.textScale` in `config-entries.ts` and tech-debt #62. It lives here
 * because core/AppearanceSync.ts has to clamp a value stored by an older build (the slider used
 * to go to 2.0) — a factor above the maximum is a state the UI cannot represent.
 */
export const TEXT_SCALE_MIN = 0.75
export const TEXT_SCALE_MAX = 1.5

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
                // that write still in flight. EMITTED BY core/AppearanceSync.ts (the
                // shell's side-effect half, #571); consumed by common/CursorRefresh.ts.
                "cursor-applied": {}
            }
        }, this)
    }

    private state: ThemeState = {
        themeFamily: "",   // read from org.gnome.desktop.interface by loadSettings()
        iconTheme: "",
        cursorTheme: "",
        isDark: true,
    }

    private fcConfig: NidaraThemeConfig = { ...DEFAULT_CONFIG }
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
        
        // The accent and the mode LIVE in gsettings (the contract in
        // ui/lib/nidara-kit/platform/appearance.ts), so a change made anywhere else — `gsettings set`, an
        // agent, another tool — is a change of the desktop, exactly as in GNOME. The
        // `!==` guards are what stop our own writes from echoing back as a loop:
        // the setters update the in-memory value BEFORE they write the key.
        this.interfaceSettings.connect("changed::color-scheme", () => {
            const scheme = this.interfaceSettings.get_string("color-scheme")
            const isDark = scheme === "prefer-dark"
            if (this.state.isDark !== isDark) {
                console.log(`[ThemeManager] External Dark Mode change detected: ${scheme}`)
                this.setDarkMode(isDark)
            }
        })
        this.interfaceSettings.connect("changed::accent-color", () => {
            const accent = this.interfaceSettings.get_string("accent-color")
            if (accent in ACCENT_PALETTE && accent !== this.fcConfig.accent) {
                console.log(`[ThemeManager] External accent change detected: ${accent}`)
                this.setAccentColor(accent as AccentKey)
            }
        })

        // The three themes live there too (#536): a theme picked by `gsettings set`,
        // GNOME Tweaks or an agent is the desktop's theme, and used to be reverted at
        // the next login by the file this class pushed over them. Same guard as above.
        this.interfaceSettings.connect("changed::gtk-theme", () => {
            const theme = this.interfaceSettings.get_string("gtk-theme")
            if (theme && theme !== this.state.themeFamily) this.setGtkTheme(theme)
        })
        this.interfaceSettings.connect("changed::icon-theme", () => {
            const icons = this.interfaceSettings.get_string("icon-theme")
            if (icons !== this.state.iconTheme) this.setIconTheme(icons)
        })
        this.interfaceSettings.connect("changed::cursor-theme", () => {
            // Not just a restyle: the cursor also has to reach Hyprland and the
            // Xcursor default (tech-debt #72), which setCursorTheme does.
            const cursor = this.interfaceSettings.get_string("cursor-theme")
            if (cursor !== this.state.cursorTheme) this.setCursorTheme(cursor)
        })

        // Nidara's own keys, changed by another process. Our own writes come back
        // here equal to what we hold, and stop at the comparison.
        nidaraAppearance.subscribeAll(key => {
            const value = nidaraAppearance.get(key)
            if (this.fcConfig[key] === value) return
            ;(this.fcConfig as unknown as Record<string, unknown>)[key] = value
            this.applyTokens()
            this.emit("changed")
        })

        // Monitor font preference changes
        this.interfaceSettings.connect("changed::font-name", () => this.syncFont())
        this.syncFont()
        
        // Hot-reload CSS in dev mode
        this.setupStyleMonitor()
        
        this.applyAll()
    }

    /**
     * Held on the instance, not in a local: a Gio.FileMonitor nothing references is collected
     * by GJS, and a collected monitor emits nothing. As a `const` this hot reload worked until
     * the first full GC and then never again — measured with scripts/dev/style-hot-reload-probe.ts
     * (reloads without `system.gc()`, silent after it).
     */
    private styleMonitor: Gio.FileMonitor | null = null

    private setupStyleMonitor() {
        const stylePath = `${SHELL_ROOT}/style.css`
        const file = Gio.File.new_for_path(stylePath)
        try {
            this.styleMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null)
            this.styleMonitor.connect("changed", (_m: any, _f: any, _o: any, event: number) => {
                // One reload per write. Both an in-place write (sass) and an atomic replace
                // (temp + rename) END with CHANGES_DONE_HINT; the CHANGED/CREATED events before
                // it would each load a file that is still being written.
                if (event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT) return
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
        // One lever, shared by all three bundles — see ui/lib/nidara-kit/platform/font-rendering.ts for
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

    /**
     * The GTK theme for THIRD-PARTY applications — never for ours, which load none
     * (commandment 11, `ui/lib/nidara-kit/platform/gtk-theme.ts`).
     *
     * ⚠️ Rewritten 2026-09-20 (tech-debt #107). The old version listed
     * `/usr/share/themes` and subtracted three names, which on a clean Arch is the
     * WHOLE directory — `Default` and `Emacs` are the only entries and both are
     * gtk-3.0 KEYBINDING themes (`gtk-keys.css`), not widget themes. So the row
     * offered an empty list while displaying a value that was not on disk either.
     * Same shape as `getAvailableIconThemes()`, and this is the same three rules:
     *
     *   · a directory counts only if it is a REAL GTK4 theme — a `gtk-4.0/`
     *     subdirectory. That is the whole test, and it is the one that matters:
     *     `gnome-themes-extra` ships `/usr/share/themes/Adwaita` with `gtk-2.0` and
     *     `gtk-3.0` only, so offering it would change nothing for a GTK4 app.
     *   · the built-in is always offered under `GTK_BUILTIN_THEME`. It is not on
     *     disk — it lives in libgtk's gresource — so no directory scan can find it,
     *     and it is the value a fresh install is seeded with. ⚠️ That name is
     *     `Adwaita`, NOT GTK4's own `Default`, and the reason is GTK3: see
     *     `ui/lib/nidara-kit/platform/gtk-theme.ts`, which holds the measurements. It also means a real
     *     `/usr/share/themes/Adwaita` is filtered out of the disk scan and re-added
     *     as the built-in — right, because under that name the two are the same
     *     offer to a GTK4 app (measured: 0 differing pixels).
     *   · the configured value stays selectable even if it fails the test, so the
     *     row can still display what is actually set.
     *
     * ⚠️ `enum:` is evaluated once, at registration (`ui/shell/config-entries.ts`),
     * so a theme installed afterwards does not appear until the shell restarts.
     */
    getAvailableGtkThemes(): string[] {
        const paths = ["/usr/share/themes", `${GLib.get_home_dir()}/.local/share/themes`, `${GLib.get_home_dir()}/.themes`]
        const themes = this.listDirs(paths).filter(t => {
            if (t === GTK_BUILTIN_THEME) return false // added below; never from disk
            for (const p of paths) {
                if (GLib.file_test(`${p}/${t}/gtk-4.0`, GLib.FileTest.IS_DIR)) return true
            }
            return false
        })
        themes.push(GTK_BUILTIN_THEME)
        const current = this.state.themeFamily
        if (current && !themes.includes(current)) themes.push(current)
        return themes.sort()
    }

    getAvailableIconThemes(): string[] {
        const paths = ["/usr/share/icons", `${GLib.get_home_dir()}/.local/share/icons`, `${GLib.get_home_dir()}/.icons`]
        // System plumbing, never user-selectable: "default" is the Xcursor pointer
        // (written by core/AppearanceSync.ts), "hicolor" is the freedesktop
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
     *  the widget's ROOT window name against `CHROME_SCOPE_WINDOWS` — the same list
     *  the CSS pin uses, so a Cairo widget and the tokens around it can never
     *  disagree about which mode a surface is in. Anything else (Settings/About/
     *  unrealized) → isDark.
     *
     *  ⚠️ This used to hardcode `nidara-bar || nidara-dock` and its comment said the
     *  app grid was a child of the dock. Both stopped being true when the island and
     *  the app grid moved to their own surfaces; see the note on
     *  `generateChromeTokenScope`. */
    surfaceIsDark(widget: Gtk.Widget): boolean {
        try {
            const name = (widget.get_root() as Gtk.Window | null)?.get_name?.() ?? ""
            if ((CHROME_SCOPE_WINDOWS as readonly string[]).includes(name)) return this.chromeIsDark
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
        this.emit("changed")
    }

    async setIconTheme(icons: string) {
        this.state.iconTheme = icons
        try {
            await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", icons])
            this.emit("changed")
        } catch (e) { console.error(e) }
    }

    /**
     * Is `name` a cursor theme on this machine? Theme names are CASE-SENSITIVE
     * directory names, and since #536 the key is followed live, so anything typed
     * into `gsettings set` reaches here — `qogir` for the installed `Qogir` did, and
     * Hyprland, handed a theme it cannot load, drew its own fallback (the Hyprland
     * logo) while the Xcursor default pointed every X app at nothing.
     */
    cursorThemeInstalled(name: string): boolean {
        return !!name && this.getAvailableCursorThemes().includes(name)
    }

    async setCursorTheme(cursor: string) {
        // A name that is not installed is not passed on to Hyprland, the Xcursor
        // default or settings.ini: the desktop keeps the cursor it has, and the log
        // says why. The key itself is left as written — it is the user's value, and
        // GTK falls back on its own — so fixing the name applies at once.
        // (The shell's AppearanceSync logs the refusal — once, for the desktop.)
        if (!this.cursorThemeInstalled(cursor)) return
        this.state.cursorTheme = cursor
        // gsettings is the home; Hyprland, the Xcursor default and settings.ini follow
        // it from core/AppearanceSync.ts, whichever process wrote the key.
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-theme", cursor])
        this.emit("changed")
    }

    async setCursorSize(size: number) {
        await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "cursor-size", String(size)])
        // Hyprland and settings.ini follow the key — core/AppearanceSync.ts.
        this.emit("changed")
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
     * lands on one row (see `syncFontMetrics` and ui/lib/nidara-kit/platform/font-rendering.ts).
     * Crispness comes from the hint, not from the size — so points cost nothing.
     *
     * Whole points, because that is the granularity every font picker offers; the
     * historical default "Inter 11" is what 15px rounds back to.
     */
    fontToPoints(fontName: string): string {
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

    async setFont(fontName: string) {
        this.interfaceSettings.set_string("font-name", this.fontToPoints(fontName))
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
        await this.syncGtkTheme()
        // settings.ini, the greeter's mirror and the xdg-desktop-portal-gtk restart follow
        // the key from core/AppearanceSync.ts — once, in the shell, whoever wrote it.
        this.emit("changed")
        // The user hook is NOT fired here: a setter runs in whichever process calls
        // it, and a change made elsewhere never passes through it. The shell fires it
        // once, from the change itself — core/AppearanceHooks.ts.
    }

    /**
     * Store Nidara's appearance keys (the shell's AppearanceSync refreshes the greeter's
     * mirror from the change), 500 ms after
     * the last call. A glass slider calls this on every frame of a drag: the tokens
     * are applied immediately (the caller does that), what waits is the WRITE, so
     * dconf and every portal listener see one change per gesture instead of sixty
     * per second.
     */
    private persistenceDebounceId = 0
    private schedulePersistence() {
        if (this.persistenceDebounceId > 0) GLib.source_remove(this.persistenceDebounceId)
        this.persistenceDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this.persistenceDebounceId = 0
            const patch: Partial<NidaraAppearance> = {}
            for (const key of NIDARA_KEYS) (patch as Record<string, unknown>)[key] = this.fcConfig[key]
            nidaraAppearance.update(patch)
            return GLib.SOURCE_REMOVE
        })
    }

    async setAccentColor(accent: AccentKey) {
        this.fcConfig.accent = accent
        this.applyTokens()
        // Hyprland's groupbar follows the key — core/AppearanceSync.ts.
        execAsync(["gsettings", "set", "org.gnome.desktop.interface", "accent-color", accent]).catch(() => {})
        this.schedulePersistence()
        this.emit("changed")
        // The user hook fires from the change itself, in the shell only —
        // core/AppearanceHooks.ts, and see setDarkMode.
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

        try {
            // The user's GTK theme is for THIRD-PARTY applications only: it goes to
            // gsettings (which the portal serves), never onto our own Gtk.Settings.
            // This process runs on no theme at all — `useNoGtkTheme()` in app.ts,
            // tech-debt #107 / commandment 11.
            if (theme) {
                const current = this.interfaceSettings.get_string("gtk-theme")
                if (current !== theme) {
                    await execAsync(["gsettings", "set", "org.gnome.desktop.interface", "gtk-theme", theme])
                }
            }
            setPreferDark(this.state.isDark)
        } catch (e) { }
    }

    /** What this process holds, for core/AppearanceSync.ts (settings.ini, the greeter's
     *  mirror). A copy: nothing outside writes Theme's state. */
    snapshot(): ThemeState & Pick<NidaraThemeConfig, "accent" | "barOpacity" | "overlayOpacity" | "dockOpacity" | "windowOpacity" | "shellAppearance"> {
        return {
            ...this.state,
            accent: this.fcConfig.accent,
            barOpacity: this.fcConfig.barOpacity,
            overlayOpacity: this.fcConfig.overlayOpacity,
            dockOpacity: this.fcConfig.dockOpacity,
            windowOpacity: this.fcConfig.windowOpacity,
            shellAppearance: this.fcConfig.shellAppearance,
        }
    }

    private _isReady = false
    get isReady() { return this._isReady }

    private async applyAll() {
        // This process's own look only. The first-boot font seeds, the px→pt migration,
        // the text-scale clamp, the cursor pushed to Hyprland and the Xcursor default,
        // and the groupbar accent are the DESKTOP's, and run once in the shell —
        // core/AppearanceSync.ts (#571).
        await this.syncGtkTheme()

        this._isReady = true
        this.emit("ready")
        console.log("[ThemeManager] Global Styles READY! ")
    }

    /**
     * Everything, from its home. No migration here: appearance.json was imported
     * into org.nidara.appearance once, before this process started, and the GNOME
     * keys already held the file's values on every existing machine — every start
     * used to push them there. A fresh install reads the system defaults
     * (/etc/dconf/db/local.d, generated from defaults/appearance.json).
     */
    private loadSettings() {
        try {
            const s = this.interfaceSettings
            const gtk = s.get_string("gtk-theme")
            this.state = {
                themeFamily: gtk || GTK_BUILTIN_THEME,
                iconTheme: s.get_string("icon-theme"),
                cursorTheme: s.get_string("cursor-theme"),
                isDark: s.get_string("color-scheme") === "prefer-dark",
            }
            const accent = s.get_string("accent-color")
            if (accent in ACCENT_PALETTE) this.fcConfig.accent = accent as AccentKey
        } catch (e) {
            console.warn("[ThemeManager] could not read org.gnome.desktop.interface:", e)
            this.state.themeFamily = this.state.themeFamily || GTK_BUILTIN_THEME
        }
        for (const key of NIDARA_KEYS) (this.fcConfig as unknown as Record<string, unknown>)[key] = nidaraAppearance.get(key)
    }
}

export const Theme = new ThemeManager()
export default Theme
