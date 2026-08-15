import { Gtk } from "ags/gtk4"
import { ACCENT_HEX } from "../accent"

/**
 * NIDARA KIT — the appearance seam
 * ================================
 *
 * Everything in `ui/lib/nidara-kit/` had, until now, one thing in common: it needed
 * nothing from the bundle hosting it beyond GTK. `slider.ts` broke that. A slider is
 * CAIRO-painted, and Cairo cannot read CSS: the accent has to arrive as an actual
 * `#rrggbb` string, and "is the surface under me dark?" has to be answered by whoever
 * knows what that surface is. In the shell that knowledge lives in
 * `core/ThemeManager` — which the kit may not import, or the kit stops being usable
 * from the greeter and the lockscreen.
 *
 * So the bundle injects it, exactly like the greeter injects its `t()` into the shared
 * login card. One registration per bundle, in its `app.ts`, before any kit widget is
 * built.
 *
 *   setKitAppearance({
 *       accent:        () => Theme.accentPalette[Theme.accentColor].color,
 *       surfaceIsDark: (w) => Theme.surfaceIsDark(w),
 *       onChange:      (cb) => { const id = Theme.connect("changed", cb)
 *                                return () => safeDisconnect(Theme, id) },
 *   })
 *
 * ⚠️ An unregistered bundle does NOT fail — it renders a blue slider on a light
 * surface. That is the same silent-default trap the kit's token contract warns about
 * (`ui/lib/styles/_components.scss`), and the greeter/lock have no dev mode to notice
 * it in, so the fallback logs once, on first use, rather than staying quiet.
 */
export interface KitAppearance {
    /** The live accent as "#rrggbb" — a Cairo source color, not a CSS token. */
    accent(): string
    /**
     * Is the surface this widget is painted ON dark? NOT the same question as the
     * global dark mode: a light-pinned control centre over a dark system needs a dark
     * track, not a white one. The widget is passed so the source can look at what it
     * is actually rooted in.
     */
    surfaceIsDark(widget: Gtk.Widget): boolean
    /** Subscribe to appearance changes (accent, mode). Returns an unsubscribe. */
    onChange(cb: () => void): () => void
}

let warned = false

const FALLBACK: KitAppearance = {
    accent: () => {
        if (!warned) {
            warned = true
            console.warn("[nidara-kit] no appearance source registered — "
                       + "painting with the default accent. Call setKitAppearance() in this bundle's app.ts.")
        }
        return ACCENT_HEX.blue
    },
    surfaceIsDark: () => false,
    onChange: () => () => {},
}

let current: KitAppearance = FALLBACK

/** Register this bundle's appearance source. Call once, from `app.ts`. */
export function setKitAppearance(source: KitAppearance): void {
    current = source
}

/** The active appearance source (the fallback until a bundle registers one). */
export function kitAppearance(): KitAppearance {
    return current
}
