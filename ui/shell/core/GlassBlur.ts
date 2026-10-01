import { settings } from "./CompositorState"
import Theme from "./ThemeManager"
import { GLASS_BLUR, GLASS_MATERIAL_DEFAULT, type GlassMaterial } from "./NidaraTheme"

/**
 * The compositor half of the glass material (#674): the blur's size and passes, from
 * `GLASS_BLUR`. The opacity half is the token engine's.
 *
 * On Hyprland that is ONE blur for the whole compositor — it has no per-layer size — so a
 * material reaches every translucent window as well as our layers. That is the scope the
 * owner chose: one control for all of it. Hyalo's blur is per surface and comes with #684
 * (`settings.caps.sharedBlur`).
 *
 * The default material (`regular`) is what the compositor's config ships, so at that
 * position the shell asks for nothing (`setBlur(null)`) and the compositor shows what its
 * own config says, a user override included. Leaving another material for the default
 * restores THAT, never a hard-coded `size 2, passes 2`; the baseline and its re-assertion
 * after a config reload are the backend's (core/hyprland-settings.ts).
 *
 * Reduce transparency does not touch the blur: every one of our surfaces is opaque then,
 * and switching the blur off would reach every other app's window too.
 */

let pushed: GlassMaterial | null = null

function push(material: GlassMaterial) {
    settings.setBlur(material === GLASS_MATERIAL_DEFAULT ? null : GLASS_BLUR[material])
    pushed = material
}

/** The blur in force now, as far as the shell knows: the material's, or at the default the
 *  compositor's own config. The adaptive glass's model reads its `passes` from here. */
export function glassBlurInForce(): { size: number; passes: number } {
    // From the material itself, not from what was last pushed: a reader in another `Theme`
    // "changed" handler may run before `push` does.
    const m = Theme.glassMaterial
    return m === GLASS_MATERIAL_DEFAULT ? settings.blurBaseline() : GLASS_BLUR[m]
}

/** Called once from core/AppearanceSync.ts. Applies the stored material to the compositor
 *  (a separate process, which knows nothing of dconf) and follows it. */
export function initGlassBlur() {
    push(Theme.glassMaterial)
    Theme.connect("changed", () => {
        if (Theme.glassMaterial !== pushed) push(Theme.glassMaterial)
    })
}
