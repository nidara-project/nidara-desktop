import hyprlandState from "./HyprlandState"
import agentService from "./AgentService"
import agentConfig from "./AgentConfig"

// "The Assistant is working in THIS window" — the one signal that lives outside
// the shell's own pixels, because the thing it has to point at is a third-party
// window we do not draw.
//
// Hyprland's inner glow (0.56+) does the drawing; this only decides WHEN. The
// whole look is configured once in config/hypr/hyprland.lua — range, the
// violet→cyan gradient, and the transparent `color_inactive` that limits the
// glow to the focused window. Here we flip `enabled` and nothing else.
//
// WHY IT READS AS OWNERSHIP RATHER THAN AS DECORATION: the `glowangle`
// animation is armed in the config, so every focus change runs the gradient once
// around the border and stops (~3 s). While the Assistant works, the moment it
// focuses its target the border sweeps — the movement marks the TRANSITION,
// where the information actually is — and then the static glow just sits there
// saying "still mine". Measured: the sweep is a transient, the static glow is
// free, and a SUSTAINED rotation would cost ~32% GPU forever (see the hyprland.lua
// comment). Continuous motion is not available to us at any price worth paying.
//
// NO FOCUS GUARD, on purpose. If the user clicks another window mid-turn the
// glow follows them, and that is not a lie: every tool the daemon has acts on the
// FOCUSED window and refuses otherwise (see bin/nidara-agent), so whatever is
// focused is what the next action will touch. A window the Assistant is about to
// act in is exactly the window that should be glowing.

let supported = false
let applied = false          // last state we actually pushed to Hyprland
let started = false

function desired(): boolean {
    return supported && agentConfig.assistantGlow && agentService.busy
}

// Deduped: agentService notifies on EVERY streamed token, so without this a
// single turn would fire hundreds of `hyprctl eval` subprocesses.
function sync(force = false) {
    const want = desired()
    if (!force && want === applied) return
    applied = want
    hyprlandState.setGlow(want)
}

export function initAgentGlow() {
    if (started) return
    started = true

    hyprlandState.supportsGlow().then(ok => {
        supported = ok
        if (!ok) {
            console.log("[AgentGlow] no decoration:glow — Hyprland < 0.56, staying out of the way")
            return
        }
        // Force it off at boot even though the config already says false: a shell
        // that died mid-turn (crash, kill, restart) left the glow ON in the live
        // config, and nothing else would ever turn it back off. Idempotent.
        sync(true)

        agentService.subscribe(() => sync())
        agentConfig.onChange(() => sync())

        // `hyprctl reload` (or an edit to hyprland-user.lua) re-reads the config,
        // which sets glow.enabled = false — mid-turn that would silently drop the
        // signal. Re-assert whatever we currently want.
        hyprlandState.connect("config-reloaded", () => sync(true))
    })
}

export default { initAgentGlow }
