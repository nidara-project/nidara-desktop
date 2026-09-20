// What an appearance change does to the rest of the desktop — run once, by the shell (#571).
//
// ThemeManager is what any process needs to LOOK like the desktop. This module is what
// the desktop needs DONE when the look changes, and it used to live in ThemeManager's
// setters and constructor — so it ran in whichever process called a setter, and ran
// AGAIN when the shell heard the change and called the same setter. With Settings in its
// own process that meant the settings.ini was written twice per mode switch, two
// `hyprctl setcursor`s, two writers of settings.ini and of the greeter's mirror.
//
// So the shell watches the keys and does each thing once, whoever wrote them:
//
//   key (org.gnome.desktop.interface)     →  effect
//   gtk-theme, icon-theme, font-name,        ~/.config/gtk-{3,4}.0/settings.ini
//     color-scheme, cursor-theme/-size
//   cursor-theme, cursor-size                Hyprland's cursor + the Xcursor default
//   accent-color                             Hyprland's groupbar accent
//   color-scheme, accent-color, gtk/icon/    the greeter's appearance mirror
//     cursor theme, org.nidara.appearance
//
// and, at start only, the first-boot font seeds, the px→pt font migration and the
// text-scale clamp — writes to gsettings that must happen once, not once per process.
//
// ⚠️ SHELL ONLY — started from app.ts, beside AppearanceHooks (which fires the user hooks
// from the same changes). The effects read ThemeManager's snapshot on the NEXT main-loop
// turn: the shell's ThemeManager hears the same `changed` on its own Gio.Settings, and GTK
// promises no order between two objects' handlers, so reading at once could see the value
// before the one that just arrived.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { writeFile } from "../../lib/file"
import Theme, { TEXT_SCALE_MAX } from "./ThemeManager"
import hs from "./HyprlandState"
import { ACCENT_PALETTE, type AccentKey } from "./NidaraTheme"
import { GREETER_MIRROR_DIR } from "./Paths"

type Effect = "ini" | "cursor" | "groupbar" | "mirror"

let started = false
const keep: InstanceType<typeof Gio.Settings>[] = []
const pending = new Set<Effect>()
let flushId = 0
let lastMode: "dark" | "light" | null = null
let lastRefusedCursor = ""

function schedule(...effects: Effect[]): void {
    for (const e of effects) pending.add(e)
    if (flushId) return
    flushId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        flushId = 0
        const run = [...pending]
        pending.clear()
        for (const e of run) {
            try { EFFECTS[e]() } catch (err) { console.error(`[AppearanceSync] ${e}:`, err) }
        }
        return GLib.SOURCE_REMOVE
    })
}

const EFFECTS: Record<Effect, () => void> = {
    ini: writeSettingsIni,
    cursor: applyCursor,
    groupbar: syncGroupbarAccent,
    mirror: writeGreeterMirror,
}

/**
 * GTK3 apps (and the GTK3 file chooser served by xdg-desktop-portal-gtk) don't read the
 * portal's color-scheme — they switch dark/light via this flag. Without it, every GTK3
 * surface renders light Adwaita even though gsettings says prefer-dark.
 */
function writeSettingsIni(): void {
    const snap = Theme.snapshot()
    if (!snap.themeFamily) return
    const iface = keep[0]
    const cursorSize = iface.get_int("cursor-size") || 24
    // 🔑 One theme name for both files, and it must be one GTK3 can resolve — its
    // built-in is `Adwaita` and GTK4's is `Default`, and only the first has a dark
    // variant GTK3 can find. That is settled at the VALUE (`GTK_BUILTIN_THEME` in
    // ui/lib/gtk-theme.ts, with the measurements), not here: the Settings portal
    // serves `gtk-theme`, so a Wayland app reads gsettings directly and never sees
    // what we write into a per-toolkit file. Mapping the name here was the first
    // attempt and it changed nothing on screen.
    for (const d of ["gtk-3.0", "gtk-4.0"]) {
        let ini = `[Settings]\n`
            + `gtk-theme-name=${snap.themeFamily}\n`
            + `gtk-application-prefer-dark-theme=${snap.isDark ? 1 : 0}\n`
            + `gtk-icon-theme-name=${snap.iconTheme}\n`
            + `gtk-font-name=${Theme.interfaceFont}\n`
        if (snap.cursorTheme) {
            ini += `gtk-cursor-theme-name=${snap.cursorTheme}\n`
                + `gtk-cursor-theme-size=${cursorSize}\n`
        }
        // On a clean install these dirs don't exist yet (no GTK app created them), and
        // writeFile would throw — which once left settings.ini unwritten, so GTK apps
        // rendered light Adwaita with no Papirus icons (clean-install bug, VM 06-22).
        const dir = `${GLib.get_user_config_dir()}/${d}`
        if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
        writeFile(`${dir}/settings.ini`, ini)
    }
}

/**
 * The cursor has three consumers and three mechanisms: gsettings (GTK/GNOME Wayland apps —
 * already the home), `hyprctl setcursor` (the compositor's live cursor), and the Xcursor
 * default (XWayland/X apps like Steam, which ignore the other two). A name that is not
 * installed reaches none of them: Hyprland, handed a theme it cannot load, draws its own
 * fallback (the Hyprland logo), and the Xcursor default would point X apps at nothing.
 */
function applyCursor(): void {
    const iface = keep[0]
    const cursor = iface.get_string("cursor-theme")
    const size = iface.get_int("cursor-size") || 24
    if (!Theme.cursorThemeInstalled(cursor)) {
        if (cursor !== lastRefusedCursor) {
            lastRefusedCursor = cursor
            console.warn(`[AppearanceSync] cursor theme "${cursor}" is not installed (names are case-sensitive; installed: ${Theme.getAvailableCursorThemes().join(", ")}) — keeping "${Theme.snapshot().cursorTheme}"`)
        }
        return
    }
    lastRefusedCursor = ""   // an installed theme clears the silence, so a later bad pick warns
    writeXcursorDefault(cursor)
    hs.setCursor(cursor, size).then(() => Theme.emit("cursor-applied"))
}

/**
 * Pin the "default" Xcursor theme that XWayland and legacy X apps resolve against.
 * Without this, those apps stay on whatever Inherits= was last written (e.g. by nwg-look)
 * regardless of gsettings/hyprctl — which is why Steam ignored the picker.
 */
function writeXcursorDefault(cursor: string): void {
    const dir = `${GLib.get_home_dir()}/.local/share/icons/default`
    if (!GLib.file_test(dir, GLib.FileTest.EXISTS)) GLib.mkdir_with_parents(dir, 0o755)
    writeFile(`${dir}/index.theme`,
        `[Icon Theme]\nName=Default\nComment=Default Cursor Theme\nInherits=${cursor}\n`)
}

/*
 * ⛔ `restartPortalGtk` lived here until 2026-09-20 and must NOT come back.
 *
 * It ran `systemctl --user restart xdg-desktop-portal-gtk.service` on every mode
 * change, because the GTK3 file chooser that backend serves reads the dark flag once
 * at process start. The premise is true; the remedy was not.
 *
 * 🔴 **It destroys requests that are in flight.** Measured with a probe that opened a
 * `FileChooser.OpenFile` through the portal and then killed an ISOLATED backend: the
 * dialog vanishes from the screen and the client gets
 * `Backend call failed: Message recipient disconnected from message bus without
 * replying`. Whatever the person was typing into that picker is gone — and the same
 * applies to a `Secret` request, a screenshot or a consent prompt mid-flight.
 *
 * No desktop does this: GNOME's portal backend is GTK4 and reacts live, KDE's is Qt6.
 * Nobody restarts a systemd unit in response to a UI event. It is also NOT the cause of
 * the duplicated `SettingChanged` — that is two backends serving the same interface.
 *
 * The chooser's staleness is real and is left unsolved on purpose: it is one dialog,
 * against a restart that can eat somebody's work.
 */

/**
 * Push the accent into Hyprland's groupbar (active tab = persistent selection — the one
 * place accent enters compositor chrome; window borders stay neutral glass on purpose).
 * The rest of the groupbar styling is static in hyprland.lua's `group` block. Gotcha: a
 * groupbar bakes its colors at group creation, so this colors FUTURE groups — existing
 * ones keep the old accent until recreated.
 */
function syncGroupbarAccent(): void {
    const accent = keep[0].get_string("accent-color")
    if (!(accent in ACCENT_PALETTE)) return
    const hex = ACCENT_PALETTE[accent as AccentKey].color.slice(1)
    const col = `rgba(${hex}99)`
    hs.evalLua(`hl.config({ group = { groupbar = { col = { active = '${col}', locked_active = '${col}' } } } })`)
}

/**
 * The greeter's MIRROR — the one surface outside any session, with no portal to ask
 * (ui/lib/appearance.ts, rule 3). An export written from the two homes, never read back.
 * 0644, stated: the default of `writeFile` is 0600, and a mirror nobody else can read is
 * #488 — the login screen stuck on blue on every machine installed after 0.11.0.
 */
function writeGreeterMirror(): void {
    const json = JSON.stringify(Theme.snapshot(), null, 2)
    try {
        if (!GLib.file_test(GREETER_MIRROR_DIR, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(GREETER_MIRROR_DIR, 0o755)
        writeFile(`${GREETER_MIRROR_DIR}/appearance.json`, json, 0o644)
    } catch (e) {
        console.warn("[AppearanceSync] could not write shared appearance:", e)
    }
}

/**
 * Seeds and repairs that WRITE gsettings, once per session, before the first effects run.
 * They were ThemeManager.applyAll's, which ran in every process that built it.
 */
function seedAndRepair(iface: InstanceType<typeof Gio.Settings>): void {
    // Seed Nidara's default interface font on first boot: the schema default on
    // GTK ≥4.22 is "Adwaita Sans 11". ONLY when the user hasn't picked one
    // (get_user_value === null distinguishes the factory default from an explicit
    // choice), so a deliberate pick is never clobbered on later boots.
    // ⚠️ "Inter 11" — POINTS, and the same 11 every install has shipped since PR #6.
    // #123/#124 chased crisp text through a px size, which also killed the accessibility
    // text scale outright; the lever was `gtk-hint-font-metrics` — see Theme.fontToPoints.
    if (iface.get_user_value("font-name") === null)
        iface.set_string("font-name", "Inter 11")
    // Same for monospace: the schema default ("Adwaita Mono 11") names a font we don't
    // install, while ttf-jetbrains-mono ships with every Nidara install.
    // ⚠️ The family is "JetBrains Mono", NOT "JetBrainsMono Nerd Font" — that was the
    // patched build, dropped for costing 232 MiB; naming it here would silently resolve to
    // whatever fontconfig substitutes.
    if (iface.get_user_value("monospace-font-name") === null)
        iface.set_string("monospace-font-name", "JetBrains Mono 11")

    // Undo #123/#124 on machines that already ran them: a font stored in absolute pixels
    // makes the accessibility text slider a no-op. Idempotent — a point-sized font comes
    // back untouched — and it also picks up a px font set by another tool (nwg-look,
    // GNOME Tweaks, a dotfile).
    for (const key of ["font-name", "monospace-font-name"]) {
        const live = iface.get_string(key)
        const pts = Theme.fontToPoints(live)
        if (pts !== live) {
            console.log(`[AppearanceSync] ${key}: "${live}" → "${pts}" (px → pt, so text scaling works)`)
            iface.set_string(key, pts)
        }
    }

    // Bring a factor stored by an older build (whose slider went to 2.0) back into the
    // range the layout survives. Only downwards, and logged: this REDUCES someone's text
    // size, so it must be findable in the log rather than just mysterious.
    const scale = iface.get_double("text-scaling-factor")
    if (scale > TEXT_SCALE_MAX) {
        console.log(`[AppearanceSync] text-scaling-factor ${scale} → ${TEXT_SCALE_MAX} (above the range the reflowing windows support)`)
        iface.set_double("text-scaling-factor", TEXT_SCALE_MAX)
    }
}

/** Idempotent: a second call does nothing. */
export function startAppearanceSync(): void {
    if (started) return
    started = true

    // Held for the life of the process: an unreferenced Gio.Settings is collected and its
    // handlers with it. keep[0] is the interface schema — the effects read it.
    const iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
    const nidara = new Gio.Settings({ schema_id: "org.nidara.appearance" })
    keep.push(iface, nidara)

    const mode = () => iface.get_string("color-scheme") === "prefer-dark" ? "dark" : "light"
    lastMode = mode()
    // A cursor theme that is not installed AT START is skipped silently, as it always was
    // (a container or a fresh system may hold `default`); the warning is for a CHANGE to one.
    lastRefusedCursor = iface.get_string("cursor-theme")

    iface.connect("changed::gtk-theme", () => schedule("ini", "mirror"))
    iface.connect("changed::icon-theme", () => schedule("ini", "mirror"))
    iface.connect("changed::font-name", () => schedule("ini"))
    iface.connect("changed::cursor-theme", () => schedule("ini", "cursor", "mirror"))
    iface.connect("changed::cursor-size", () => schedule("ini", "cursor"))
    iface.connect("changed::accent-color", () => schedule("groupbar", "mirror"))
    iface.connect("changed::color-scheme", () => {
        const now = mode()
        if (now === lastMode) return
        lastMode = now
        schedule("ini", "mirror")
    })
    nidara.connect("changed", () => schedule("mirror"))

    seedAndRepair(iface)

    // Everything the desktop needs from the current values, once.
    // `cursor` at start is what makes apps launched later (Steam…) inherit the cursor
    // instead of a stale default. No push INTO gsettings: the values are read from there
    // since #536 — pushing a copy over them at start is what reverted a theme set elsewhere.
    schedule("ini", "cursor", "groupbar", "mirror")
}
