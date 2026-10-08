import Theme from "./ThemeManager"
import { safeDisconnect } from "./signals"
import { glassBlurInForce } from "./GlassBlur"
import { registerGlassMaterial } from "../../lib/nidara-kit/platform/glass-material"

/**
 * The shell's half of the glass material (`ui/lib/nidara-kit/platform/glass-material.ts`, which
 * holds the material itself and its documentation): Reduce transparency and the panels' blur
 * come from the shell's Settings.
 */

/** Called once from core/AppearanceSync.ts, beside the blur. */
export function initCompositorGlass() {
    registerGlassMaterial({
        reduceTransparency: () => Theme.reduceTransparency,
        panelBlur: glassBlurInForce,
        // The dock's glass follows the system mode (`trackModeGlass`, owner 2026-10-08).
        lightMode: () => !Theme.isDark,
        onChange: (cb) => {
            const id = Theme.connect("changed", cb)
            return () => safeDisconnect(Theme, id)
        },
    })
}
