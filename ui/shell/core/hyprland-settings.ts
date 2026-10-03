// hyprland-settings.ts — `CompositorSettings` on Hyprland (#682).
//
// Every setting the shell gives Hyprland, in one place: applied live with `hl.config` /
// `hl.monitor` through `hyprctl eval`, persisted as the `~/.config/nidara/nidara-*.lua`
// files `hyprland.lua` requires at login, and read back with `hyprctl getoption` — the
// effective value, `hyprland-user.lua` included. Until #682 this lived in each module that
// owned a setting (InputConfig, MonitorConfig, WorkspaceModes, GamingSync, ReduceMotion,
// GlassBlur, AdaptiveGlass, AppearanceSync); they now ask `settings` in CompositorState.ts
// and know no compositor.
//
// ⚠️ `hl.config`, NOT `hyprctl keyword`: the Lua config answers `keyword` with "Use eval."
// and changes nothing — a refusal that costs nothing and looks like success.
//
// ⚠️ Nothing here writes a file in answer to "config-reloaded". `hyprland.lua` requires
// these files, and a write on reload is a reload loop: the 09-12 freeze was Hyprland's
// config rewritten twice in a second (project memory `project_freeze_after_533_checkout`).

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync, spawn } from "../../lib/process"
import { writeFile } from "../../lib/nidara-kit/platform/file"
import type { HyprlandStateClass } from "./HyprlandState"
import {
    luaConfigBlock, luaConfigExpr, luaLiteral, luaWorkspaceModesBlock, type LuaValue,
} from "./hyprland-lua"
import { GLASS_BLUR } from "./NidaraTheme"
import type {
    IdleConfig,
    BlurColour, BlurStrength, CompositorSettings, InputKey, InputSettings, MonitorSetting,
} from "./compositor-types"

const nidaraFile = (name: string) => GLib.build_filenamev([GLib.get_home_dir(), ".config", "nidara", name])

/** `writeFile` rather than `GLib.file_set_contents`: both rename a temporary into place,
 *  so neither can be caught half-written, but only this one fsyncs — and `hyprland.lua`
 *  requires these files at every login, where a truncated require is the session with no
 *  Nidara config at all. */
function save(name: string, text: string) {
    try { writeFile(nidaraFile(name), text) }
    catch (e) { console.error(`[HyprlandSettings] Failed to write ${name}:`, e) }
}

// ── Options ──────────────────────────────────────────────────────────────────

type OptionKind = "bool" | "int" | "float" | "str"

/**
 * One Hyprland option, named ONCE, with both halves of what it takes to own it.
 *
 * The effective value is our file + `hyprland-user.lua` + defaults merged, and only
 * Hyprland computes that sum — so reading asks the compositor. Writing is TWO steps and
 * both are required: `apply` changes the running session and does not survive a restart,
 * while the `.lua` file survives a restart and does not apply.
 *
 * 🔑 What this pairing prevents is the two halves drifting. They used to be written
 * separately — the reader naming `input:touchpad:tap_to_click` and typing it, the writer
 * naming it again as a bare string and spelling its boolean `1` — with nothing checking
 * that the two agreed about where the option lives or what its values look like.
 *
 * ⚠️ The typed readers are not a style preference. A bool option's `getoption -j` has no
 * `int` field, so reading it as `.int === 1` is false for every boolean, silently (#338).
 */
interface Option {
    readonly name: string
    /** `fallback` is what you ALREADY believe: a read that cannot reach the compositor
     *  leaves your state as it was, because the whole file is rewritten from that state. */
    read(fallback: any): Promise<any>
    apply(value: LuaValue): void
}

function option(hs: HyprlandStateClass, name: string, kind: OptionKind): Option {
    return {
        name,
        read(fallback: any): Promise<any> {
            switch (kind) {
                case "bool":  return hs.getOptionBoolAsync(name, fallback)
                case "int":   return hs.getOptionIntAsync(name, fallback)
                case "float": return hs.getOptionFloatAsync(name, fallback)
                case "str":   return hs.getOptionStrAsync(name, fallback)
            }
        },
        apply(value: LuaValue) {
            hs.evalLua(luaConfigExpr(name, value))
        },
    }
}

/**
 * The input options, the WHOLE declaration. It used to be three hand-maintained lists of
 * the same ten options — the re-sync, the generated file's template and the setters —
 * with nothing checking that they agreed; `kb_variant` had a place in two of them and had
 * to be smuggled through a second eval in the third.
 *
 * Order is the order of the generated file — `touchpad` last, so its nested table closes
 * the block.
 */
const INPUT: readonly [InputKey, string, OptionKind, ((v: any) => string)?][] = [
    // Two decimals so the file does not churn between `0` and `0.00`.
    ["pointerSpeed",          "input:sensitivity", "float", (v: number) => v.toFixed(2)],
    ["accelProfile",          "input:accel_profile", "str"],
    ["mouseNaturalScroll",    "input:natural_scroll", "bool"],
    ["numlockOnBoot",         "input:numlock_by_default", "bool"],
    ["kbLayout",              "input:kb_layout", "str"],
    ["kbVariant",             "input:kb_variant", "str"],
    ["kbRepeatDelay",         "input:repeat_delay", "int"],
    ["kbRepeatRate",          "input:repeat_rate", "int"],
    ["touchpadNaturalScroll", "input:touchpad:natural_scroll", "bool"],
    ["touchpadTap",           "input:touchpad:tap_to_click", "bool"],
]

const SETTINGS_HEADER = [
    "-- NIDARA SHELL SETTINGS",
    "-- Auto-generated by the Nidara Settings UI. Do not edit manually.",
].join("\n")

// Moved from core/PowerConfig.ts (2026-10-02) when Hyalo took idle over: on Hyprland the
// idle steps are hypridle's, unchanged.
// ── hypridle config ───────────────────────────────────────────────────────────
// The symlink at ~/.config/hypr/hypridle.conf always resolves to the per-user
// copy in ~/.config/nidara/ (nidara-setup). It used to point into the dev REPO
// on dev installs — writing here then dirtied the repo working tree, so that
// mode was removed (2026-07-10): this file is user state, not shipped config.
const HYPRIDLE_CONF = `${GLib.get_home_dir()}/.config/hypr/hypridle.conf`

const parseHypridle = (): IdleConfig => {
    try {
        const [, bytes] = Gio.File.new_for_path(HYPRIDLE_CONF).load_contents(null)
        // Drop comment lines first: a commented-out `# listener { ... }` block
        // otherwise parses as real and gets silently re-enabled on the next save
        // (this is how a phantom 30-min auto-suspend shipped on 2026-06-10).
        const content = new TextDecoder().decode(bytes)
            .split("\n").filter(l => !/^\s*#/.test(l)).join("\n")
        const regex = /listener\s*\{([^}]+)\}/g
        let m
        const blocks: { timeout: number; onTimeout: string }[] = []
        while ((m = regex.exec(content)) !== null) {
            const body = m[1]
            const timeout = parseInt(body.match(/timeout\s*=\s*(\d+)/)?.[1] ?? "0")
            const onTimeout = body.match(/on-timeout\s*=\s*(.+)/)?.[1]?.trim() ?? ""
            blocks.push({ timeout, onTimeout })
        }
        return {
            screenOff: blocks.find(b => /dpms.*(off|disable)/.test(b.onTimeout))?.timeout ?? 0,
            lock:      blocks.find(b => b.onTimeout.includes("nidara-lock") || b.onTimeout.includes("lock-session"))?.timeout ?? 0,
            suspend:   blocks.find(b => b.onTimeout.includes("suspend"))?.timeout ?? 0,
        }
    } catch {
        return { screenOff: 300, lock: 600, suspend: 0 }
    }
}

const writeHypridle = (cfg: IdleConfig) => {
    const lines = [
        "# --- HYPRIDLE - Nidara Idle Management ---",
        "# Managed by Nidara Settings → Power → Idle & Lock",
        "",
        "general {",
        "    lock_cmd = nidara-lock",
        "    before_sleep_cmd = nidara-before-sleep",
        "    after_sleep_cmd = nidara-after-sleep",
        "    ignore_dbus_inhibit = false",
        "}",
        "",
    ]
    if (cfg.screenOff > 0) lines.push(
        "listener {",
        `    timeout = ${cfg.screenOff}`,
        // Lua-parser syntax — the legacy `hyprctl dispatch dpms off` is a Lua
        // error on Nidara's Hyprland and leaves the screen unrecoverable on wake
        `    on-timeout = hyprctl dispatch 'hl.dsp.dpms({ action = "disable" })'`,
        `    on-resume  = hyprctl dispatch 'hl.dsp.dpms({ action = "enable" })'`,
        "}", ""
    )
    if (cfg.lock > 0) lines.push(
        "listener {",
        `    timeout = ${cfg.lock}`,
        "    on-timeout = nidara-lock",
        "}", ""
    )
    if (cfg.suspend > 0) lines.push(
        "listener {",
        `    timeout = ${cfg.suspend}`,
        "    on-timeout = systemctl suspend",
        "}", ""
    )
    try {
        // FileCreateFlags.NONE follows the symlink and writes through to the real
        // target. REPLACE_DESTINATION would replace the symlink itself with a
        // plain file, silently detaching the config from its install-mode target.
        // ⚠️ Note for atomic writes (#340): writing to a temp file and renaming
        // replaces the destination inode, which breaks symlinks in the same way.
        // Any replacement write must resolve through the symlink to the real target.
        Gio.File.new_for_path(HYPRIDLE_CONF).replace_contents(
            new TextEncoder().encode(lines.join("\n")),
            null, false, Gio.FileCreateFlags.NONE, null
        )
        // Single-owner restart. The session launches hypridle via `uwsm app -s b`
        // (hyprland.lua), but the hypridle package ALSO ships a user unit, and
        // `systemctl --user restart hypridle` would start a SECOND instance next
        // to the session one — both register idle timers and fight over the
        // org.freedesktop.ScreenSaver name, dropping app inhibitors (videos kept
        // playing while the screen went dark — incident 2026-06-10). Stop the
        // unit if present, kill any stragglers, wait until truly dead, relaunch.
        execAsync(["bash", "-c",
            "systemctl --user stop hypridle.service 2>/dev/null; " +
            "pkill -x -TERM hypridle 2>/dev/null; " +
            "for i in $(seq 1 30); do pgrep -x hypridle >/dev/null || break; sleep 0.1; done; " +
            "pkill -x -KILL hypridle 2>/dev/null; " +
            "exec uwsm app -s b -- hypridle"
        ]).catch(() => {})
    } catch (e) {
        console.error("[PowerConfig] Failed to write hypridle config:", e)
    }
}


// Night light on Hyprland is hyprsunset, a process of its own (moved from NightLightSync.ts on
// 2026-10-02, when Hyalo took the gamma over): restarted for a new temperature, killed for none.
// A slider drag sends many temperatures; each would be a restart, so one is started once they
// settle (moved here from NightLightSync.ts on 2026-10-03: Hyalo takes every one).
let hyprsunset: Gio.Subprocess | null = null
let hyprsunsetDebounce = 0
const setNightLightHyprland = (kelvin: number | null) => {
    if (hyprsunsetDebounce > 0) GLib.source_remove(hyprsunsetDebounce)
    hyprsunsetDebounce = 0
    if (kelvin !== null && hyprsunset) {
        hyprsunsetDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            hyprsunsetDebounce = 0
            restartHyprsunset(kelvin)
            return GLib.SOURCE_REMOVE
        })
        return
    }
    restartHyprsunset(kelvin)
}
const restartHyprsunset = (kelvin: number | null) => {
    if (hyprsunset) {
        try { hyprsunset.force_exit() } catch (_) {}
        hyprsunset = null
    }
    if (kelvin === null) return
    try {
        hyprsunset = spawn(["hyprsunset", "-t", String(kelvin)], Gio.SubprocessFlags.NONE)
    } catch (e) {
        console.error("[NightLight] Failed to start hyprsunset:", e)
    }
}

export function createHyprlandSettings(hs: HyprlandStateClass): CompositorSettings {
    const input = INPUT.map(([key, name, kind, literal]) => ({ key, opt: option(hs, name, kind), literal }))

    /** `misc:vrr`, a GLOBAL int (0 off, 1 always, 2 fullscreen only). */
    const VRR = option(hs, "misc:vrr", "int")

    // ── Reduce motion: `animations:enabled`, against the user's own value.
    //
    // 🔑 Turning reduce motion OFF restores what `animations:enabled` was BEFORE the shell
    // touched it — never a hard-coded `true`, which would overrule someone who turned
    // animations off in `hyprland-user.lua` from a page that does not own that file.
    let animBaseline = true
    /** null until the shell has said anything. */
    let reduced: boolean | null = null
    const pushMotion = (reduce: boolean) =>
        hs.evalLua(`hl.config({ animations = { enabled = ${reduce ? false : animBaseline} } })`)

    // ── The glass material's blur (#674): `decoration:blur` size and passes, ONE blur for
    // the whole compositor. Same baseline rule: the default material shows what the config
    // asks for, and leaving another one restores that.
    const shipped: BlurStrength = { size: GLASS_BLUR.regular.size, passes: GLASS_BLUR.regular.passes }
    let blurBase: BlurStrength = shipped
    let blurPushed: BlurStrength | null = null
    let blurSaid = false
    const readBlur = (): BlurStrength => ({
        size: hs.getOptionInt("decoration:blur:size", shipped.size),
        passes: hs.getOptionInt("decoration:blur:passes", shipped.passes),
    })
    const pushBlur = (b: BlurStrength) =>
        hs.evalLua(`hl.config({ decoration = { blur = { size = ${b.size}, passes = ${b.passes} } } })`)

    /** Read once and on every reload (`getoption` is a synchronous spawn: never per measurement). */
    let colour: BlurColour | null = null
    const readColour = (): BlurColour => ({
        contrast: hs.getOptionFloat("decoration:blur:contrast", 1.2),
        brightness: hs.getOptionFloat("decoration:blur:brightness", 1.0),
        vibrancy: hs.getOptionFloat("decoration:blur:vibrancy", 0.4),
        vibrancyDarkness: hs.getOptionFloat("decoration:blur:vibrancy_darkness", 0.1),
    })

    // A `hyprctl reload` (or an edit to hyprland-user.lua) re-reads the config and silently
    // discards what was pushed with `hl.config`. Re-read the baselines from the config that
    // just loaded — it is the user's last word — and re-assert what the shell chose.
    // Connected here, at construction, so it runs before any module's own reload handler
    // reads `blurColour()`.
    hs.connect("config-reloaded", () => {
        colour = null
        if (reduced !== null) {
            animBaseline = hs.getOptionBool("animations:enabled", true)
            if (reduced) pushMotion(true)
        }
        if (blurSaid) {
            blurBase = readBlur()
            if (blurPushed) pushBlur(blurPushed)
        }
    })

    return {
        setNightLight: setNightLightHyprland,
        readIdle: parseHypridle,
        setIdle: writeHypridle,
        caps: { animations: true, sharedBlur: true, vrrFullscreenOnly: true, windowBackdrop: false },

        // One blur for windows and layers (`decoration:blur`): no switch of its own here.
        readWindowBackdrop: () => true,
        setWindowBackdrop() {},

        async readInput(current) {
            const next = { ...current }
            for (const { key, opt } of input) (next as any)[key] = await opt.read(current[key])
            return next
        },

        setInput(next, changed) {
            for (const { key, opt } of input) if (changed.includes(key)) opt.apply(next[key])
            const entries = input.map(({ key, opt, literal }) =>
                [opt.name, literal ? literal(next[key]) : luaLiteral(next[key])] as const)
            save("nidara-settings.lua", `${SETTINGS_HEADER}\n${luaConfigBlock(entries)}\n`)
        },

        readVrr(current) {
            return hs.getOptionInt(VRR.name, current)
        },

        applyMonitor(name, m) {
            hs.evalLua(`hl.monitor({ output = '${name}', mode = '${m.mode ?? "preferred"}', position = 'auto', scale = ${m.scale}, transform = ${m.transform} })`)
        },

        applyVrr(vrr) {
            VRR.apply(vrr)
        },

        saveMonitors(monitors: ReadonlyMap<string, MonitorSetting>, vrr: number) {
            const lines = [
                "-- NIDARA SHELL MONITOR SETTINGS",
                "-- Auto-generated by Nidara Settings UI. Do not edit manually.",
                "",
            ]
            for (const [name, m] of monitors) {
                const mode = m.mode ?? "preferred"
                lines.push(m.transform !== 0
                    ? `hl.monitor({ output = "${name}", mode = "${mode}", position = "auto", scale = ${m.scale}, transform = ${m.transform} })`
                    : `hl.monitor({ output = "${name}", mode = "${mode}", position = "auto", scale = ${m.scale} })`)
            }
            if (vrr !== 0) {
                // The SAME expression `applyVrr` sends live: two halves of one change, one spelling.
                lines.push("", luaConfigExpr(VRR.name, vrr))
            }
            save("nidara-monitor.lua", lines.join("\n") + "\n")
        },

        saveWorkspaceModes(defaultMode, overrides) {
            save("nidara-workspaces.lua", luaWorkspaceModesBlock(defaultMode, overrides))
        },

        setReduceMotion(reduce) {
            if (reduced === null) {
                // Only trust the LIVE option as the baseline when not reducing: a shell
                // reloaded (Super+Shift+R) with reduce motion on finds the compositor holding
                // the previous instance's `false`, and must not take it for the user's wish.
                animBaseline = reduce ? true : hs.getOptionBool("animations:enabled", true)
                reduced = reduce
                // Not reducing at start: the compositor already shows what its config asks.
                if (reduce) pushMotion(true)
                return
            }
            if (reduce === reduced) return
            reduced = reduce
            pushMotion(reduce)
        },

        setBlur(b) {
            if (!blurSaid) {
                blurSaid = true
                // Same rule as motion: the live value is the baseline only at the default.
                if (b === null) { blurBase = readBlur(); return }
            } else if (b === null && blurPushed === null) {
                return
            }
            pushBlur(b ?? blurBase)
            blurPushed = b
        },

        blurBaseline: () => blurBase,

        blurColour() {
            return colour ??= readColour()
        },

        // The active tab of a group — the one place accent enters Hyprland's chrome (borders
        // stay neutral glass on purpose). A groupbar bakes its colours when the group is
        // made, so this colours FUTURE groups.
        setAccent(rgbaHex) {
            const col = `rgba(${rgbaHex})`
            hs.evalLua(`hl.config({ group = { groupbar = { col = { active = '${col}', locked_active = '${col}' } } } })`)
        },

        effectiveLayout() {
            return {
                gapsIn: hs.getOptionInt("general:gaps_in"),
                gapsOut: hs.getOptionInt("general:gaps_out"),
                rounding: hs.getOptionInt("decoration:rounding"),
                borderSize: hs.getOptionInt("general:border_size"),
            }
        },
    }
}
