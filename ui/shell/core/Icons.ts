import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import { SHELL_ROOT } from "./Paths"

/**
 * Nidara — the interface icons, as CONCEPTS rather than file names (#587).
 *
 * A surface asks for a concept (`Icons.wifi`, `Icons.battery`) and gets back a
 * `Gio.FileIcon`, exactly as before. What changed is where that icon comes from:
 *
 *   1. the INTERFACE icon theme, if one is set — a private `Gtk.IconTheme`, NOT
 *      the display's. The display keeps serving the user's APP icon theme
 *      (`org.gnome.desktop.interface icon-theme`), which is what the dock, the
 *      tray and the app grid resolve against. GTK gives one theme per process,
 *      and these are the two we need at once;
 *   2. our own shipped drawing, as the last link — `assets/icons/hicolor/
 *      scalable/actions/<name>-symbolic.svg`. With no interface theme set, which
 *      is the default, every concept resolves here.
 *
 * ⚠️ A theme icon is asked for under its STANDARD name (freedesktop Icon Naming
 * Spec plus the de-facto GNOME symbolic names), never ours. That is the contract
 * a user's chosen theme is measured against, and the vocabulary third-party
 * widgets will use.
 *
 * ⚠️ Measured, GTK 4.22.5 (the A/B prototype on #587): a `Gio.FileIcon` pointing
 * at a `*-symbolic.svg` recolours from CSS `color` EXACTLY like an icon looked up
 * on the display theme — same rendered pixels. That is why the ~172 call sites did
 * not have to change when this became a registry.
 *
 * ⚠️ Our own drawings are symbolic too now — `<name>-symbolic.svg`, with the
 * symbolic classes on every shape. GTK gates recolouring on the FILENAME, so the
 * suffix is not decoration. Before that, they rendered black and every consumer
 * had to remember `.nd-icon`'s `-gtk-icon-filter: invert(1)` — which then turned
 * a theme's already-white symbolic icon BLACK the moment an interface theme was
 * set. That inversion is gone; icons take CSS `color` like any other glyph.
 *
 * ⚠️ `instanceof Gtk.SymbolicPaintable` does NOT tell you whether an icon
 * recolours: a non-symbolic file reports `true` and still draws black. Only the
 * render distinguishes them.
 */

// Assets resolve against SHELL_ROOT (source tree in dev, /usr/share in prod).
// See core/Paths.ts. install.sh ships assets/ into both.
const DIR = `${SHELL_ROOT}/assets/icons/hicolor/scalable/actions`
const f = (name: string) => Gio.FileIcon.new(Gio.File.new_for_path(`${DIR}/${name}-symbolic.svg`))

/** Absolute path of a shipped asset icon — for chains that fall back to our
 *  own art only when the icon theme has nothing (see AppService.resolveIconChain). */
export const iconAssetPath = (name: string) => `${DIR}/${name}-symbolic.svg`

/**
 * concept → [ standard icon name, our shipped drawing ].
 *
 * The standard names come from the icon study on #587, which audited all 85
 * against the Naming Spec, Adwaita and Papirus. Two corrections were needed on
 * the way in, both because the study graded each icon on its own and so could
 * not see them:
 *
 *   - four pairs had landed on ONE name (`user`/`userRound`,
 *     `bluetooth`/`bluetoothConnected`, `wifiCog`/`globe`, `filePen`/`wifiPen`).
 *     A theme has one drawing per name, so a shared name makes two concepts
 *     indistinguishable the moment a theme is chosen;
 *   - `filePen` and `wifiPen` are dropped outright. Neither had a caller, and
 *     the only name that fitted them was `document-edit`, which one of them had
 *     to give up anyway.
 *
 * 🔑 **`null` means there is no standard name for this concept, so no theme is
 * ever asked and the drawing is always ours.** It is not a gap to fill in later.
 * The Icon Naming Spec is from 2006 and simply does not name an AI assistant, a
 * CPU chip, a dock, a clipboard history or a floating-window mode — and a theme
 * asked for the nearest-sounding name answers with something that MEANS something
 * else. The study had to give all 85 concepts a name, so it forced one: the
 * assistant glyph was mapped to `system-help`, and picking Adwaita turned Nidara's
 * AI into a question mark. Owner's rule, 2026-09-16: when there is no standard
 * name, fall back to ours rather than to something "similar" from the theme.
 *
 * Not every real name is in every theme either, and that is fine — same last
 * link. Measured by `scripts/dev/icon-registry-probe.sh` against Adwaita, the
 * theme every Arch install has: 66 of the 83 concepts resolve to it and 17 fall
 * through — the 11 `null`s, plus `moon` (`system-suspend`) and
 * `bluetoothConnected` (`bluetooth-paired`), which it does not carry, and `check`,
 * `settings`, `palette` and `mousePointer`, which it has ONLY as full-colour PNGs
 * in `legacy/` — and `resolve` refuses anything that is not a symbolic SVG.
 *
 * ⚠️ Do NOT check that list by looking for files under a theme's directory. That
 * is how it was first written here and it was wrong in both directions: GTK
 * resolves through the theme's `Inherits` chain, so it finds names the directory
 * does not hold. Ask the resolver — that is what the probe is.
 */
const CONCEPTS = {
    app:                 [null,                                "app-window"],
    mic:                 ["audio-input-microphone",            "mic"],
    speaker:             ["audio-speakers",                    "speaker"],
    volumeHigh:          ["audio-volume-high",                 "volume-2"],
    volumeMedium:        ["audio-volume-medium",               "volume-1"],
    volumeLow:           ["audio-volume-low",                  "volume"],
    volumeMuted:         ["audio-volume-muted",                "volume-x"],
    user:                ["system-users",                      "user"],
    userRound:           ["avatar-default",                    "user-round"],
    userRoundPlus:       ["contact-new",                       "user-round-plus"],
    battery:             ["battery",                           "battery"],
    bluetooth:           ["bluetooth-active",                  "bluetooth"],
    cpu:                 [null,                                "cpu"],
    hand:                [null,                                "hand"],
    hardDrive:           ["drive-harddisk",                    "hard-drive"],
    wifi:                ["network-wireless",                  "wifi"],
    ethernet:            ["network-wired",                     "ethernet-port"],
    moon:                ["system-suspend",                    "moon"],
    sun:                 ["display-brightness",                "sun"],
    sunset:              ["daytime-sunset",                    "sunset"],
    info:                ["dialog-information",                "info"],
    key:                 ["dialog-password",                   "key"],
    trash:               ["user-trash",                        "trash"],
    search:              ["system-search",                     "search"],
    chevronRight:        ["pan-end",                           "chevron-right"],
    chevronLeft:         ["pan-start",                         "chevron-left"],
    chevronUp:           ["pan-up",                            "chevron-up"],
    chevronDown:         ["pan-down",                          "chevron-down"],
    plus:                ["value-increase",                    "plus"],
    minus:               ["value-decrease",                    "minus"],
    zoomIn:              ["zoom-in",                           "zoom-in"],
    zoomOut:             ["zoom-out",                          "zoom-out"],
    pause:               ["media-playback-pause",              "pause"],
    play:                ["media-playback-start",              "play"],
    skipBack:            ["media-skip-backward",               "skip-back"],
    skipForward:         ["media-skip-forward",                "skip-forward"],
    wifiOff:             ["network-wireless-disabled",         "wifi-off"],
    wifiCog:             [null,                                "wifi-cog"],
    wifiHigh:            ["network-wireless-signal-ok",        "wifi-high"],
    wifiLow:             ["network-wireless-signal-weak",      "wifi-low"],
    wifiZero:            ["network-wireless-signal-none",      "wifi-zero"],
    wifiSync:            ["network-wireless-acquiring",        "wifi-sync"],
    bell:                ["preferences-system-notifications",  "bell"],
    bellOff:             ["notifications-disabled",            "bell-off"],
    check:               ["emblem-default",                    "check"],
    menu:                ["open-menu",                         "menu"],
    settings2:           ["preferences-system",                "settings-2"],
    settings:            ["preferences-desktop",               "settings"],
    terminal:            ["utilities-terminal",                "terminal"],
    grid:                ["view-grid",                         "grid"],
    sidebar:             ["sidebar-show",                      "sidebar"],
    close:               ["window-close",                      "x"],
    lock:                ["system-lock-screen",                "lock"],
    logOut:              ["application-exit",                  "log-out"],
    power:               ["system-shutdown",                   "power"],
    rotateCcw:           ["system-reboot",                     "rotate-ccw"],
    palette:             ["preferences-desktop-theme",         "palette"],
    monitor:             ["video-display",                     "monitor"],
    keyboard:            ["input-keyboard",                    "keyboard"],
    clock:               ["preferences-system-time",           "clock"],
    type:                ["preferences-desktop-font",          "type"],
    mousePointer:        ["preferences-desktop-peripherals",   "mouse-pointer"],
    zap:                 ["power-profile-performance",         "zap"],
    leaf:                ["power-profile-power-saver",         "leaf"],
    dock:                [null,                                "dock"],
    accessibility:       ["preferences-desktop-accessibility", "accessibility"],
    puzzle:              [null,                                "puzzle"],
    panelTop:            [null,                                "panel-top"],
    rocket:              [null,                                "rocket"],
    bluetoothConnected:  ["bluetooth-paired",                  "bluetooth-connected"],
    bluetoothOff:        ["bluetooth-disabled",                "bluetooth-off"],
    bluetoothSearching:  ["bluetooth-acquiring",               "bluetooth-searching"],
    globe:               ["preferences-system-network",        "globe"],
    clipboard:           [null,                                "clipboard"],
    clipboardList:       [null,                                "clipboard-list"],
    camera:              ["camera-photo",                      "camera"],
    record:              ["media-record",                      "record"],
    recordStop:          ["media-playback-stop",               "record-stop"],
    shield:              ["network-vpn",                       "shield"],
    shieldOff:           ["network-vpn-disconnected",          "shield-off"],
    sparkles:            [null,                                "sparkles"],
    music:               ["audio-x-generic",                   "music"],
    gamepad:             ["input-gaming",                      "gamepad-2"],
} as const satisfies Record<string, readonly [standard: string | null, asset: string]>

export type IconConcept = keyof typeof CONCEPTS

/**
 * The interface icon theme, or null while none is set.
 *
 * A freshly constructed `Gtk.IconTheme` already carries the full XDG search path
 * (verified: ~/.local/share/icons … /usr/share/icons … the Flatpak and Snap
 * exports), so it finds any installed theme without help. It is deliberately NOT
 * `Gtk.IconTheme.get_for_display()`: that one is the display singleton, it
 * belongs to the user's app icons, and it refuses `set_theme_name` outright
 * (`assertion '!self->is_display_singleton' failed`).
 */
let interfaceTheme: Gtk.IconTheme | null = null
let themeName = ""

const APPEARANCE_SCHEMA = "org.nidara.appearance"
const THEME_KEY = "interface-icon-theme"

/** Icons already resolved under the current theme. Cleared when it changes. */
const cache = new Map<IconConcept, Gio.FileIcon>()

/**
 * Is `name` an icon theme on this machine, and spelled the way the disk spells it?
 *
 * ⚠️ A theme name is a DIRECTORY name, so it is case-sensitive: `adwaita` is not
 * `Adwaita`. `set_theme_name` accepts anything — it does not look, and there is no
 * error — and a theme that is not there resolves NOTHING, so every concept
 * quietly falls back to our drawing and the desktop looks exactly as if the
 * setting had never been touched. The owner hit this within minutes of the
 * setting existing (2026-09-16), and `ThemeManager.cursorThemeInstalled` exists
 * because the cursor theme had already taught the same lesson (tech-debt #72).
 *
 * The test is the one GTK itself would use: an `index.theme` under one of the
 * search path's directories.
 */
function installedIconTheme(theme: Gtk.IconTheme, name: string): boolean {
    return theme.get_search_path()?.some(dir =>
        GLib.file_test(`${dir}/${name}/index.theme`, GLib.FileTest.EXISTS)) ?? false
}

/** The same name as the disk spells it, when only the case is wrong. */
function spelledOnDisk(theme: Gtk.IconTheme, name: string): string | null {
    const wanted = name.toLowerCase()
    for (const dir of theme.get_search_path() ?? []) {
        // No type annotations on these two: the generated GI typings do not
        // export Gio.FileEnumerator or Gio.FileInfo as types (same gap as Gio.Icon).
        let e
        try {
            e = Gio.File.new_for_path(dir).enumerate_children(
                "standard::name", Gio.FileQueryInfoFlags.NONE, null)
        } catch { continue }
        let info
        while ((info = e.next_file(null))) {
            const candidate = info.get_name()
            if (candidate.toLowerCase() === wanted && candidate !== name
                && GLib.file_test(`${dir}/${candidate}/index.theme`, GLib.FileTest.EXISTS)) {
                return candidate
            }
        }
    }
    return null
}

function setInterfaceTheme(name: string) {
    if (name === themeName) return
    themeName = name
    interfaceTheme = null
    if (name) {
        const t = new Gtk.IconTheme()
        if (installedIconTheme(t, name)) {
            t.set_theme_name(name)
            interfaceTheme = t
        } else {
            // Left unset rather than guessed at: the value is the user's, and
            // correcting it here would write over what they typed. Say what is
            // wrong instead — silence is what made this hard to notice.
            const onDisk = spelledOnDisk(t, name)
            console.warn(onDisk
                ? `[Icons] Interface icon theme "${name}" is not installed — did you mean "${onDisk}"? Theme names are case-sensitive directory names. Using Nidara's own drawings.`
                : `[Icons] Interface icon theme "${name}" is not installed. Using Nidara's own drawings.`)
        }
    }
    cache.clear()
}

/**
 * Follow the setting. The key is Nidara's own (#573 keeps the keys the desktop
 * standard does not name in `org.nidara.appearance`); an install whose schema
 * predates it simply has no interface theme, and every concept keeps resolving
 * to our shipped drawing.
 */
function watchSetting() {
    const source = Gio.SettingsSchemaSource.get_default()
    if (!source?.lookup(APPEARANCE_SCHEMA, true)?.has_key(THEME_KEY)) return
    const settings = new Gio.Settings({ schema_id: APPEARANCE_SCHEMA })
    setInterfaceTheme(settings.get_string(THEME_KEY))
    settings.connect(`changed::${THEME_KEY}`, () => {
        setInterfaceTheme(settings.get_string(THEME_KEY))
        console.log(`[Icons] Interface icon theme: ${themeName || "(none — shipped drawings)"}`)
    })
}
try { watchSetting() } catch (e) { console.warn("[Icons] Interface icon theme setting unreadable:", e) }

/**
 * The size the theme lookup asks for.
 *
 * A `Gio.FileIcon` is ONE file, so the size has to be chosen here rather than by
 * the widget. 24 is the scalable drawing, which every size renders from. It is
 * deliberately not 16: measured on #587, a theme's `16x16` directory only wins at
 * exactly 16px and scale 1 — so picking it here would hand a 16px drawing to the
 * 28px icons too. Bar-sized icons getting their own heavier variant is a separate
 * step of #587, and it needs the size at the call site.
 */
const ICON_SIZE = 24

/**
 * The `Gio.FileIcon` for a concept: the interface theme's drawing when it has a
 * SYMBOLIC one under the standard name, ours otherwise.
 *
 * `has_icon` is the test, not the lookup: `lookup_icon` never fails — it hands
 * back `image-missing` — so asking it whether a theme covers a name is asking
 * the wrong question.
 *
 * ⚠️ The resolved FILE has to end in `-symbolic.svg`, and that is checked rather
 * than assumed. Asking a theme for the bare standard name is not the same
 * question: Adwaita answers `emblem-default`, `preferences-desktop`,
 * `preferences-desktop-theme` and `preferences-desktop-peripherals` out of its
 * `legacy/` folder, with full-colour PNGs. A bitmap does not recolour and does
 * not follow the dark/light mode, so the menu tick would have become a small
 * coloured picture pinned to one palette. Anything that is not a symbolic SVG
 * falls through to our own drawing, which is the whole point of having one.
 */
function resolve(concept: IconConcept): Gio.FileIcon {
    const [standard, asset] = CONCEPTS[concept]
    if (standard && interfaceTheme) {
        const symbolic = `${standard}-symbolic`
        const name = interfaceTheme.has_icon(symbolic) ? symbolic
            : interfaceTheme.has_icon(standard) ? standard
            : null
        if (name) {
            const paintable = interfaceTheme.lookup_icon(
                name, null, ICON_SIZE, 1, Gtk.TextDirection.NONE, 0)
            const path = paintable?.get_file()?.get_path()
            if (path && path.endsWith("-symbolic.svg")
                && GLib.file_test(path, GLib.FileTest.EXISTS)) {
                return Gio.FileIcon.new(Gio.File.new_for_path(path))
            }
        }
    }
    return f(asset)
}


/**
 * `Icons.<concept>` — a `Gio.FileIcon`, resolved on first use and cached until the
 * interface theme changes. Lazy on purpose: the theme is read from GSettings at
 * module load, and a concept nobody draws costs nothing.
 */
const Icons = Object.defineProperties(
    {} as { [K in IconConcept]: Gio.FileIcon },
    Object.fromEntries((Object.keys(CONCEPTS) as IconConcept[]).map(k => [k, {
        enumerable: true,
        get: () => {
            const hit = cache.get(k)
            if (hit) return hit
            const icon = resolve(k)
            cache.set(k, icon)
            return icon
        },
    }])),
)

export type IconGIcon = Gio.FileIcon
export type IconName = IconConcept
export default Icons
