import hs from "./HyprlandState"
import Theme from "./ThemeManager"
import { GLASS_BLUR, GLASS_MATERIAL_DEFAULT, type GlassMaterial } from "./NidaraTheme"

/**
 * The compositor half of the glass material (#674): Hyprland's `decoration:blur`
 * size and passes, from `GLASS_BLUR`. The opacity half is the token engine's.
 *
 * ONE blur for the whole compositor — Hyprland has no per-layer size — so a material
 * reaches every translucent window as well as our layers. That is the scope the owner
 * chose: one control for all of it.
 *
 * ## The baseline, as in ReduceMotion.ts
 *
 * The default material (`regular`) is what `config/hypr/hyprland.lua` ships, so at
 * that position the shell pushes NOTHING back and says nothing: the compositor shows
 * what its own config asks for, including a `hyprland-user.lua` override. Leaving
 * another material for the default restores THAT baseline, read from the compositor
 * before the shell ever touched it — never a hard-coded `size 2, passes 2`, which would
 * overrule someone's own config from a settings page that does not own it.
 *
 * ⚠️ `hl.config`, NOT `hyprctl keyword` — the Lua config answers `keyword` with "Use
 * eval." and changes nothing (ReduceMotion.ts has the long form of that trap).
 *
 * Reduce transparency does not touch the blur: every one of our surfaces is opaque
 * then, and switching the blur off would reach every other app's window too.
 */

let baseline = { size: GLASS_BLUR.regular.size, passes: GLASS_BLUR.regular.passes }
let pushed: GlassMaterial = GLASS_MATERIAL_DEFAULT

function readLive() {
    return {
        size: hs.getOptionInt("decoration:blur:size", GLASS_BLUR.regular.size),
        passes: hs.getOptionInt("decoration:blur:passes", GLASS_BLUR.regular.passes),
    }
}

function push(material: GlassMaterial) {
    const b = material === GLASS_MATERIAL_DEFAULT ? baseline : GLASS_BLUR[material]
    hs.evalLua(`hl.config({ decoration = { blur = { size = ${b.size}, passes = ${b.passes} } } })`)
    pushed = material
}

/** The blur in force now, as far as the shell knows: the material's, or at the default
 *  the compositor's own config. The adaptive glass's model reads its `passes` from here —
 *  a push goes through `hl.config`, which fires no "config-reloaded" to re-read on. */
export function glassBlurInForce(): { size: number; passes: number } {
    // From the material itself, not from what was last pushed: a reader in another
    // `Theme` "changed" handler may run before `push` does.
    const m = Theme.glassMaterial
    return m === GLASS_MATERIAL_DEFAULT ? baseline : GLASS_BLUR[m]
}

/** Called once from core/AppearanceSync.ts. Applies the stored material to the
 *  compositor (a separate process, which knows nothing of dconf) and follows it. */
export function initGlassBlur() {
    // Only trust the LIVE option as the baseline while the default is in force: a shell
    // reloaded (Super+Shift+R) with `frosted` on finds the compositor still holding
    // what the previous instance pushed, and must not take that for the user's config.
    // Otherwise the shipped value stands until the config is re-read (below).
    if (Theme.glassMaterial === GLASS_MATERIAL_DEFAULT) baseline = readLive()
    else push(Theme.glassMaterial)

    Theme.connect("changed", () => {
        if (Theme.glassMaterial !== pushed) push(Theme.glassMaterial)
    })
    // A `hyprctl reload` (or an edit to hyprland-user.lua) re-reads the config and
    // silently discards what we pushed. Re-read the baseline from the config that just
    // loaded — it is the user's last word — and re-assert a non-default material.
    hs.connect("config-reloaded", () => {
        baseline = readLive()
        if (Theme.glassMaterial !== GLASS_MATERIAL_DEFAULT) push(Theme.glassMaterial)
    })
}
