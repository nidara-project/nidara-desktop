import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gdk from "gi://Gdk?version=4.0"
import Gsk from "gi://Gsk"
import Graphene from "gi://Graphene"
import { SHELL_ROOT } from "./Paths"

/**
 * Nidara — the interface icons, by NIDARA ICON SPEC name (#587).
 *
 * A surface asks for a name (`uiIcon("nd-network-wireless")`) and gets back a
 * `Gio.FileIcon`. That name is looked for in two places, in order:
 *
 *   1. the INTERFACE icon theme, if one is set AND it declares the spec — a
 *      private `Gtk.IconTheme`, NOT the display's. The display keeps serving the
 *      user's APP icon theme (`org.gnome.desktop.interface icon-theme`), which is
 *      what the dock, the tray and the app grid resolve against. GTK gives one
 *      theme per process, and these are the two we need at once;
 *   2. our own drawing, as the last link — `assets/icons/nidara/scalable/
 *      actions/<name>-symbolic.svg`, named with that SAME name. With no interface
 *      theme set, which is the default, every icon resolves here.
 *
 * `assets/icons/nidara/` IS the Nidara icon theme — the spec's reference theme, and
 * the only copy of these drawings. It is a complete theme directory (index.theme,
 * both sizes, SPEC.md), installed to /usr/share/icons/nidara as a symlink to itself,
 * which is where a theme author finds it to start from. Reading the files straight
 * from it, rather than through a `Gtk.IconTheme`, keeps the default path free of any
 * lookup; the result is the same file. It used to be two copies — these files and a
 * `nidara-symbolic` theme generated from Lucide at install — and nine of the 83
 * drawings had drifted apart between them (owner: one copy, 2026-09-17).
 *
 * 🔑 Every name is OURS — `nd-` — and is defined in `assets/icons/nidara/SPEC.md`, which
 * says what each one represents. They used to be freedesktop names, asked of
 * whatever theme the user picked, and that kept drawing the wrong THING: dark mode
 * came out as a suspend button, the Control Centre as a toolbox, the bell as a
 * speech bubble (all fixed one by one in #591). The Icon Naming Spec is frozen
 * since 2007, and GNOME itself calls Adwaita's UI icons a private set with no API.
 * So Nidara has its own spec, and only a theme made for it changes these icons
 * (owner decision on #587, 2026-09-17). APP icons keep their freedesktop names —
 * there the name comes from each application's `.desktop` file, and it works.
 *
 * A theme opts in with `X-Nidara-Icon-Spec=<version>` in its `index.theme`. It is
 * DECLARED, not detected: a partial theme (ten icons redrawn, the rest ours) is
 * legitimate, so counting `nd-` files would need a threshold nobody can justify.
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
const DIR = `${SHELL_ROOT}/assets/icons/nidara/scalable/actions`
const f = (name: string) => Gio.FileIcon.new(Gio.File.new_for_path(`${DIR}/${name}-symbolic.svg`))

/** Absolute path of a shipped asset icon — for chains that fall back to our
 *  own art only when the icon theme has nothing (see AppService.resolveIconChain). */
export const iconAssetPath = (name: string) => `${DIR}/${name}-symbolic.svg`

/**
 * Every interface icon Nidara asks for, by name.
 *
 * This is a LIST, not a mapping — it exists so the compiler can refuse a name we
 * do not ship and so `scripts/ci/icon-registry-check.mjs` can check that each one
 * has a drawing and a line in `assets/icons/nidara/SPEC.md`. Adding one is adding all
 * three. Name by MEANING, one meaning per name: two uses sharing a name become
 * the same glyph in every theme made for the spec.
 */
export const ICON_NAMES = [
    "nd-ai",
    "nd-audio-input-microphone",
    "nd-audio-speakers",
    "nd-audio-volume-high",
    "nd-audio-volume-low",
    "nd-audio-volume-medium",
    "nd-audio-volume-muted",
    "nd-audio-x-generic",
    "nd-avatar-default",
    "nd-bar",
    "nd-battery",
    "nd-bluetooth-active",
    "nd-bluetooth-disabled",
    "nd-clipboard",
    "nd-contact-new",
    "nd-control-center",
    "nd-conversation-reset",
    "nd-cpu",
    "nd-dark-mode",
    "nd-dialog-information",
    "nd-dialog-password",
    "nd-display-brightness",
    "nd-display-brightness-low",
    "nd-dock",
    "nd-drive-harddisk",
    "nd-emblem-default",
    "nd-hand",
    "nd-input-gaming",
    "nd-input-keyboard",
    "nd-light-mode",
    "nd-media-playback-pause",
    "nd-media-playback-start",
    "nd-media-playback-stop",
    "nd-media-record",
    "nd-media-skip-backward",
    "nd-media-skip-forward",
    "nd-network-vpn",
    "nd-network-vpn-disconnected",
    "nd-network-wired",
    "nd-network-wireless",
    "nd-network-wireless-acquiring",
    "nd-network-wireless-configure",
    "nd-network-wireless-disabled",
    "nd-network-wireless-signal-none",
    "nd-network-wireless-signal-ok",
    "nd-network-wireless-signal-weak",
    "nd-night-light",
    "nd-notifications",
    "nd-notifications-disabled",
    "nd-pan-down",
    "nd-pan-end",
    "nd-pan-start",
    "nd-pan-up",
    "nd-power-profile-balanced",
    "nd-power-profile-performance",
    "nd-power-profile-power-saver",
    "nd-preferences-desktop",
    "nd-preferences-desktop-accessibility",
    "nd-preferences-desktop-peripherals",
    "nd-preferences-desktop-theme",
    "nd-preferences-system",
    "nd-preferences-system-network",
    "nd-preferences-system-notifications",
    "nd-preferences-system-time",
    "nd-screenshot",
    "nd-sidebar-show",
    "nd-system-lock-screen",
    "nd-system-log-out",
    "nd-system-reboot",
    "nd-system-search",
    "nd-system-shutdown",
    "nd-system-suspend",
    "nd-user-trash",
    "nd-utilities-terminal",
    "nd-value-decrease",
    "nd-value-increase",
    "nd-video-display",
    "nd-view-grid",
    "nd-window-close",
    "nd-window-floating",
    "nd-window-tiling",
    "nd-zoom-in",
    "nd-zoom-out",
] as const

export type IconName = typeof ICON_NAMES[number]

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

/**
 * The spec version this shell implements, and the `index.theme` key a theme
 * declares it with. A theme written for an OLDER version is still used — the
 * names added since simply fall back to ours; a newer one is used too, and the
 * names we do not know are never asked for. Bump this when `SPEC.md` gains names.
 */
export const ICON_SPEC_VERSION = 1
const SPEC_KEY = "X-Nidara-Icon-Spec"

/**
 * The spec version theme directory `dir` declares, or 0 when it declares none.
 * `X-` keys are the index.theme format's own extension mechanism; GTK ignores
 * them, so declaring the spec costs a theme nothing anywhere else.
 */
function declaredSpec(dir: string): number {
    try {
        const kf = new GLib.KeyFile()
        kf.load_from_file(`${dir}/index.theme`, GLib.KeyFileFlags.NONE)
        const v = kf.get_integer("Icon Theme", SPEC_KEY)
        return v > 0 ? v : 0
    } catch {
        return 0   // no index.theme, no [Icon Theme], no key, or not a number
    }
}

/**
 * The spec version theme `name` declares, looked up the way GTK finds the theme:
 * the FIRST `index.theme` along the search path is the one that counts.
 */
function themeSpec(theme: Gtk.IconTheme, name: string): number {
    for (const dir of theme.get_search_path() ?? []) {
        if (GLib.file_test(`${dir}/${name}/index.theme`, GLib.FileTest.EXISTS)) return declaredSpec(`${dir}/${name}`)
    }
    return 0
}

/**
 * Every installed icon theme that declares the Nidara icon spec — what Settings
 * offers as interface icon themes. Directory names, sorted, each once even when
 * it is installed in more than one place.
 */
export function specIconThemes(): string[] {
    const theme = new Gtk.IconTheme()
    const found = new Set<string>()
    for (const dir of theme.get_search_path() ?? []) {
        let e
        try { e = GLib.Dir.open(dir, 0) } catch { continue }
        let n
        while ((n = e.read_name())) {
            if (!found.has(n) && themeSpec(theme, n) > 0) found.add(n)
        }
    }
    return [...found].sort()
}

/** Icons already resolved under the current theme. Cleared when it changes. */
const cache = new Map<IconName, Gio.FileIcon>()

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
            if (themeSpec(t, name) > 0) {
                t.set_theme_name(name)
                interfaceTheme = t
            } else {
                // Settings never offers such a theme, but the key can be written by
                // hand — and an install upgraded from before the spec may still hold
                // "Adwaita". It would resolve nothing anyway; say why instead.
                console.warn(`[Icons] Interface icon theme "${name}" does not follow Nidara's icon spec (no ${SPEC_KEY} in its index.theme). Using Nidara's own drawings.`)
            }
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

/** The setting, once it has been opened — null on a schema that predates the key. */
let settings: InstanceType<typeof Gio.Settings> | null = null

/** Everyone listening for a change of interface theme (Settings' row, `describeConfig`). */
const listeners = new Set<(name: string) => void>()

/**
 * Follow the setting. The key is Nidara's own (#573 keeps the keys the desktop
 * standard does not name in `org.nidara.appearance`); an install whose schema
 * predates it simply has no interface theme, and every concept keeps resolving
 * to our shipped drawing.
 */
function watchSetting() {
    const source = Gio.SettingsSchemaSource.get_default()
    if (!source?.lookup(APPEARANCE_SCHEMA, true)?.has_key(THEME_KEY)) return
    const s = new Gio.Settings({ schema_id: APPEARANCE_SCHEMA })
    settings = s
    setInterfaceTheme(s.get_string(THEME_KEY))
    s.connect(`changed::${THEME_KEY}`, () => {
        setInterfaceTheme(s.get_string(THEME_KEY))
        console.log(`[Icons] Interface icon theme: ${themeName || "(none — shipped drawings)"}`)
        for (const cb of listeners) cb(themeName)
    })
}
try { watchSetting() } catch (e) { console.warn("[Icons] Interface icon theme setting unreadable:", e) }

/**
 * The interface icon theme as the user CHOSE it — `""` for our own drawings.
 *
 * ⚠️ Not what is drawing: a chosen theme that is not installed still reads back
 * here (see `setInterfaceTheme`), because the value is the user's and the row
 * has to keep saying what was picked.
 */
export const interfaceIconTheme = (): string => themeName

/** Choose the interface icon theme; `""` goes back to our own drawings. */
export function setInterfaceIconTheme(name: string) {
    if (!settings) {
        console.warn("[Icons] Interface icon theme cannot be set: this install's schema has no interface-icon-theme key.")
        return
    }
    settings.set_string(THEME_KEY, name)
}

/** Call `cb` with the theme name whenever it changes, from anywhere. Returns the unsubscribe. */
export function onInterfaceIconThemeChange(cb: (name: string) => void): () => void {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
}

/**
 * The size the theme lookup asks for — deliberately far larger than anything we
 * draw, to land on the theme's SCALABLE drawing.
 *
 * A `Gio.FileIcon` is ONE file, so the size is chosen here rather than by the
 * widget, and the choice decides WHICH of a theme's variants we get. Themes ship
 * fixed-size directories beside the scalable one, and those are often drawn with
 * padding: measured on Colloid, its `status/24` icons fill 63% of their box while
 * its per-context `symbolic` ones fill 97%, and ours fill 92%. Asking for 24 hit that
 * directory exactly — the owner saw it as "the ethernet icon is smaller" — and it
 * was the ONLY size that did: 16, 32, 48, 128 and 512 all resolve to the scalable
 * drawing. Adwaita and Papirus give the same file at every size.
 *
 * So: ask big. A theme with no scalable variant hands back its largest fixed one,
 * which is still the best it has.
 *
 * ⚠️ This is also why our own `16x16` variant (the 2px stroke) never reaches a
 * `Gio.FileIcon`: it only wins when a lookup asks for 16 at scale 1, and this one
 * never does. Bar-sized icons getting that variant needs the size at the call
 * site, which is a separate step of #587.
 */
const ICON_SIZE = 512

/**
 * The `Gio.FileIcon` for a name: the interface theme's drawing when it has one, ours
 * otherwise.
 *
 * `has_icon` is the test, not the lookup: `lookup_icon` never fails — it hands
 * back `image-missing` — so asking it whether a theme covers a name is asking
 * the wrong question.
 *
 * ⚠️ The resolved FILE has to end in `-symbolic.svg`, and that is checked rather
 * than assumed. The name asked is `<name>-symbolic`, but GTK also falls back along
 * `Inherits`, and a theme that inherits from one shipping bitmaps can hand back a
 * PNG — Adwaita did exactly that from `legacy/` while these were freedesktop names.
 * A bitmap does not recolour and does not follow the dark/light mode, so anything
 * that is not a symbolic SVG falls through to our own drawing.
 */
let inkTestFailed = false

/**
 * Does this icon actually put ink on the screen?
 *
 * ⚠️ Measured, GTK 4.22.5: a theme can ship a perfectly valid `*-symbolic.svg`
 * that GTK resolves, reports as symbolic, and then draws as NOTHING. It happens
 * when the drawing hangs off a `<g transform="translate(…)">` and the file has no
 * `viewBox`: the symbolic path of GTK's own SVG renderer drops the group's matrix,
 * the geometry lands hundreds of units outside the 16-unit viewport, and the clip
 * leaves an empty square. The same file through `new_from_file` (librsvg) draws
 * correctly, so it is the pipeline, not the file. Upstream: GNOME/gtk#7834.
 *
 * Across the ten independent theme families measured for #587 (while these were
 * still freedesktop names) this hit **two** of them — Suru++ (12 of our concepts:
 * battery, wi-fi, terminal, disks…) and La Capitaine (5: audio, wi-fi). A theme
 * made for the spec is built the same way, by people starting from those same
 * files, so the test stays: without it such a theme silently loses those icons,
 * with nothing in the log.
 *
 * 🔑 The test is the RENDER, not the file's shape. Flagging the structure instead
 * (a `<g transform>` and no `viewBox`) catches all 17 real holes — and also 59
 * icons that draw perfectly, 36 of them in Arc alone, which would then be replaced
 * by ours for no reason. Neither does the size of the translation separate them:
 * holes span 2–1073 units, healthy ones 0–3221. Only drawing it tells.
 *
 * Cost: 0.21 ms per icon, once per concept per theme, behind the same cache as
 * the lookup. Fails OPEN — if the renderer cannot be had, the theme's icon is
 * used, because a broken instrument must not cost the user their whole theme.
 */
function drawsInk(icon: Gio.FileIcon, theme: Gtk.IconTheme): boolean {
    if (inkTestFailed) return true
    // ⚠️ The renderer is built and torn down per call, and the `unrealize()` lives
    // in a `finally`. A realized `GskRenderer` that reaches disposal aborts the
    // process outright — `gsk_renderer_dispose: assertion failed (!is_realized)`
    // is a `g_error`, not a warning, so it takes the shell with it. Keeping one
    // alive for the session cost nothing in speed (0.21 ms per icon either way)
    // and cost the whole process on exit: the first version of this did exactly
    // that and the off-screen probe died with SIGABRT after resolving, with no
    // message, before it could print a single result.
    let renderer: Gsk.Renderer | null = null
    try {
        const paintable = theme.lookup_by_gicon(icon, 16, 1, Gtk.TextDirection.NONE, 0)
        const snapshot = Gtk.Snapshot.new()
        paintable.snapshot_symbolic(snapshot, 16, 16,
            [new Gdk.RGBA({ red: 1, green: 1, blue: 1, alpha: 1 })])
        const node = snapshot.to_node()
        // No node at all is the clearest possible empty: nothing was recorded.
        if (!node) return false
        // The viewport is given explicitly: a hole's node measures 0×0, and
        // `render_texture` refuses a zero-sized one rather than reporting empty.
        renderer = Gsk.CairoRenderer.new()
        renderer.realize(null)
        const texture = renderer.render_texture(node, Graphene.Rect.alloc().init(0, 0, 16, 16))
        const downloaded = new Gdk.TextureDownloader(texture).download_bytes()
        const bytes = Array.isArray(downloaded) ? downloaded[0] : downloaded
        const data = bytes.get_data()
        if (!data) return true
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
        return false
    } catch (e) {
        console.warn("[Icons] Ink test unavailable, taking theme icons as drawn:", e)
        inkTestFailed = true
        return true
    } finally {
        renderer?.unrealize()
    }
}

function resolve(name: IconName): Gio.FileIcon {
    if (interfaceTheme) {
        const symbolic = `${name}-symbolic`
        if (interfaceTheme.has_icon(symbolic)) {
            const paintable = interfaceTheme.lookup_icon(
                symbolic, null, ICON_SIZE, 1, Gtk.TextDirection.NONE, 0)
            const path = paintable?.get_file()?.get_path()
            if (path && path.endsWith("-symbolic.svg")
                && GLib.file_test(path, GLib.FileTest.EXISTS)) {
                const themed = Gio.FileIcon.new(Gio.File.new_for_path(path))
                // Resolving is not the same as drawing — see drawsInk.
                if (drawsInk(themed, interfaceTheme)) return themed
            }
        }
    }
    return f(name)
}


/**
 * `uiIcon("nd-system-search")` — a `Gio.FileIcon`, resolved on first use and cached
 * until the interface theme changes. Lazy on purpose: nothing is looked up for a
 * name nobody draws.
 */
export function uiIcon(name: IconName): Gio.FileIcon {
    const hit = cache.get(name)
    if (hit) return hit
    const resolved = resolve(name)
    cache.set(name, resolved)
    const path = resolved.get_file().get_path()
    if (path) handedOut.set(path, name)
    return resolved
}

/**
 * Every file `uiIcon` has ever answered with, and the name it answered for.
 *
 * Never cleared, on purpose: it is what lets an icon resolved under the PREVIOUS
 * theme be recognised after a change, when the cache no longer knows it. It is
 * bounded by concepts × themes the user has tried in one session.
 */
const handedOut = new Map<string, IconName>()

/**
 * The name behind a file `uiIcon` handed out, or null if it never did.
 * What `common/IconThemeRefresh.ts` uses to find the icons already on screen.
 */
export function uiIconNameForFile(path: string): IconName | null {
    return handedOut.get(path) ?? null
}

/**
 * `icon` as the CURRENT theme draws it — for an icon captured once, at module load,
 * and turned into a widget later (a widget's catalogue icon, a slider's end icons).
 *
 * ⚠️ A `Gio.FileIcon` is one file and cannot change, so anything that stored
 * `uiIcon(…)` keeps the old theme's drawing forever. Icons already inside a widget
 * are swapped by `common/IconThemeRefresh.ts`; this is for the ones that are not in
 * a widget YET. Anything that is not ours passes through untouched.
 */
export function currentUiIcon<T extends Gio.FileIcon | null | undefined>(icon: T): T {
    const path = icon?.get_file().get_path()
    const name = path ? handedOut.get(path) : undefined
    return (name ? uiIcon(name) : icon) as T
}

export type IconGIcon = Gio.FileIcon
