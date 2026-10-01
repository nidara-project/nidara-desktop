// hyalo-settings.ts — `CompositorSettings` on Hyalo (#682).
//
// Hyalo keeps what Settings chose in `~/.config/nidara/hyalo-settings.toml`, the layer it
// reads between its shipped defaults and the user's own `hyalo.toml` (which wins, as
// `hyprland-user.lua` does). The shell never writes that file: it sends a patch in the
// config's own shape (`settings`), and Hyalo merges it, checks the whole stack, writes the
// file and reloads once (hyalo/compositor/src/config.rs, `apply_settings`). One writer, so
// two settings changed one after the other cannot drop each other's tables — which they
// would have when MonitorConfig wrote the file whole. A patch that changes nothing writes
// nothing and reloads nothing, so re-stating settings on "config-reloaded" cannot loop.
//
// Reads ask `config`: the three layers merged, the keyboard with the system's layout filled
// in — what is in force, not what Settings last said.
//
// What Hyalo does not have yet is a no-op here and false in `caps`: its own animations, its
// per-surface blur (both #684) and game mode (#682's game-mode item).

import * as hyalo from "./hyalo-ipc"
import { GLASS_BLUR } from "./NidaraTheme"
import {
    TRANSFORM_NAMES, type CompositorSettings, type InputKey, type InputSettings, type MonitorSetting,
} from "./compositor-types"

/** The config in force, or null when Hyalo cannot be asked. */
function config(): any | null {
    return hyalo.request({ request: "config" })?.ok?.config ?? null
}

/** A change to the settings layer. A refusal is said with "Hyalo refused", which the CI
 *  smoke looks for (scripts/ci/hyalo-smoke.sh). */
function patch(what: string, p: object) {
    const reply = hyalo.request({ request: "settings", patch: p })
    if (!reply) console.error(`[HyaloSettings] ${what}: Hyalo could not be reached`)
    else if (reply.error) console.error(`[HyaloSettings] Hyalo refused ${what}: ${reply.error}`)
}

/** Where each input setting lives in Hyalo's config. Hyprland's sensitivity and profile
 *  reach every pointing device; Hyalo has them per kind, so both kinds get them. */
const INPUT: Record<InputKey, string[]> = {
    pointerSpeed: ["pointer.accel_speed", "touchpad.accel_speed"],
    accelProfile: ["pointer.accel_profile", "touchpad.accel_profile"],
    mouseNaturalScroll: ["pointer.natural_scroll"],
    numlockOnBoot: ["keyboard.numlock"],
    kbLayout: ["keyboard.layout"],
    kbVariant: ["keyboard.variant"],
    kbRepeatDelay: ["keyboard.repeat_delay"],
    kbRepeatRate: ["keyboard.repeat_rate"],
    touchpadNaturalScroll: ["touchpad.natural_scroll"],
    touchpadTap: ["touchpad.tap"],
}

function at(obj: any, path: string): any {
    return path.split(".").reduce((o, k) => o?.[k], obj)
}

function put(obj: any, path: string, value: unknown) {
    const keys = path.split(".")
    let o = obj
    for (const k of keys.slice(0, -1)) o = o[k] ??= {}
    o[keys[keys.length - 1]] = value
}

export function createHyaloSettings(): CompositorSettings {
    return {
        caps: { animations: false, sharedBlur: false, gameMode: false, vrrFullscreenOnly: false },

        async readInput(current) {
            const input = config()?.input
            if (!input) return current
            const next = { ...current }
            for (const [key, [path]] of Object.entries(INPUT) as [InputKey, string[]][]) {
                const v = at(input, path)
                if (typeof v === typeof current[key]) (next as any)[key] = v
            }
            return next
        },

        setInput(next: InputSettings, changed) {
            const input = {}
            for (const key of changed) for (const path of INPUT[key]) put(input, path, next[key])
            patch(`input ${changed.join(", ")}`, { input })
        },

        readVrr(current) {
            const outputs = hyalo.getOutputs()
            return outputs.length ? (outputs.some(o => o.vrr_enabled) ? 1 : 0) : current
        },

        applyMonitor(name, m) {
            const err = hyalo.setOutput(name, {
                scale: m.scale,
                transform: TRANSFORM_NAMES[m.transform] ?? "normal",
                ...(m.mode ? { mode: m.mode } : {}),
            })
            if (err) console.error(`[HyaloSettings] Hyalo refused ${name}: ${err}`)
        },

        // Per output, on those that have it (the rest would refuse). No "fullscreen only"
        // (`caps.vrrFullscreenOnly`): 2 is off here.
        applyVrr(vrr) {
            for (const o of hyalo.getOutputs().filter(o => o.vrr_supported)) {
                const err = hyalo.setOutput(o.name, { vrr: vrr === 1 })
                if (err) console.error(`[HyaloSettings] Hyalo refused VRR on ${o.name}: ${err}`)
            }
        },

        saveMonitors(monitors: ReadonlyMap<string, MonitorSetting>, vrr: number) {
            const vrrCapable = new Set(hyalo.getOutputs().filter(o => o.vrr_supported).map(o => o.name))
            const outputs: Record<string, object> = {}
            for (const [name, m] of monitors) {
                outputs[name] = {
                    // null removes it: back to the preferred mode.
                    mode: m.mode ?? null,
                    scale: m.scale,
                    transform: TRANSFORM_NAMES[m.transform] ?? "normal",
                    vrr: vrr === 1 && vrrCapable.has(name),
                }
            }
            patch("display", { outputs })
        },

        saveWorkspaceModes(defaultMode, overrides) {
            // Every workspace the shell offers is stated, a `null` where it follows the default,
            // so one set back to "default" leaves the layer.
            const modes: Record<string, string | null> = {}
            for (let ws = 1; ws <= 5; ws++) modes[String(ws)] = null
            Object.assign(modes, overrides)
            patch("workspace modes", { workspaces: { default_mode: defaultMode, modes } })
        },

        setGamingPolicy() { /* caps.gameMode */ },
        setReduceMotion() { /* caps.animations: Hyalo draws no animation yet */ },
        setBlur() { /* caps.sharedBlur: Hyalo's blur is per surface (#684) */ },
        blurBaseline: () => ({ size: GLASS_BLUR.regular.size, passes: GLASS_BLUR.regular.passes }),
        // The shell's surfaces declare no material yet (#684), so Hyalo does nothing to the
        // backdrop's colour: the glass lies on the wallpaper as it is.
        blurColour: () => null,
        setAccent() { /* no tab groups (CompositorState caps.groups) */ },

        effectiveLayout() {
            const l = config()?.layout
            return {
                gapsIn: l?.gaps_in ?? null,
                gapsOut: l?.gaps_out ?? null,
                rounding: null,
                borderSize: l?.border ?? null,
            }
        },
    }
}
