import Gtk from "gi://Gtk?version=4.0"
import { execAsync } from "./process"
import { withGlassCapsule } from "./glass-capsule"
import { ndImageProps } from "./icons"

// Suspend / restart / shut down, for the greeter and the lockscreen.
//
// ── WHY IT TAKES ITS STRINGS AS A PARAMETER ─────────────────────────────────
// `t()` lives in each bundle's own `lib/i18n.ts` and STAYS there on purpose: the
// two catalogs are deliberately different sizes (greeter 12 keys, lockscreen 7)
// and read different config paths. A widget in `ui/lib/` therefore cannot import
// one, so the bundle hands its own in. That is the general shape for anything
// promoted here that needs to speak: **inject the bundle's i18n, do not reach for
// it.**
//
// `onLocaleChange` is optional for the same reason, and the reason is not
// squeamishness about an unused hook — it is the single fact that every difference
// between the two old copies came from: **the greeter can change language while it
// is on screen, the lockscreen cannot.** The greeter has a language dropdown that
// calls `setlocale()` live; the lockscreen has no picker and no `onLocaleChange` to
// export. Pass it where it exists and the labels re-string; omit it and they are
// simply built once.

/**
 * The keys this component asks its host to translate — the contract, spelled out
 * rather than left as `any`. Both catalogs carry all three (checked, 2026-08-10);
 * naming them here is what makes a future catalog that DOESN'T a visible break at
 * the call site instead of three buttons silently labelled with their own key.
 */
export type PowerBarKey = "suspend" | "restart" | "shutdown"

export interface PowerBarDeps {
    /** The bundle's own `t()`. See PowerBarKey for what it will be asked for. */
    t: (key: PowerBarKey) => string
    /** The bundle's locale-change subscription, where it HAS one (greeter only). */
    onLocaleChange?: (fn: () => void) => void
}

// The three actions the shell's system menu also offers, drawn with the SAME
// shipped art it uses (Icons.moon / rotateCcw / power) instead of whatever the
// user's icon theme supplies — see ui/lib/icons.ts. The theme names stay as a
// last resort for a tree with no shipped assets.
const ACTION_ICONS = {
    suspend: { name: "moon", themeFallback: "media-playback-pause-symbolic" },
    restart: { name: "rotate-ccw", themeFallback: "system-reboot-symbolic" },
    shutdown: { name: "power", themeFallback: "system-shutdown-symbolic" },
} as const

function PowerButton(
    deps: PowerBarDeps,
    icon: { name: string; themeFallback: string },
    key: PowerBarKey,
    action: () => void,
): Gtk.Button {
    const label = new Gtk.Label({ label: deps.t(key) })
    const inner = new Gtk.Box({ spacing: 6, halign: Gtk.Align.CENTER })
    inner.append(new Gtk.Image(ndImageProps(icon.name, icon.themeFallback, 14)))
    inner.append(label)

    const btn = new Gtk.Button({ css_classes: ["greeter-power-btn"], child: inner })
    btn.connect("clicked", action)
    deps.onLocaleChange?.(() => { label.label = deps.t(key) })
    return btn
}

export function NidaraPowerBar(deps: PowerBarDeps): Gtk.Widget {
    const bar = new Gtk.Box({ spacing: 4, halign: Gtk.Align.CENTER, css_classes: ["greeter-power-bar"] })

    bar.append(PowerButton(deps, ACTION_ICONS.suspend, "suspend",
        () => execAsync(["systemctl", "suspend"]).catch(console.error)))
    bar.append(PowerButton(deps, ACTION_ICONS.restart, "restart",
        () => execAsync(["systemctl", "reboot"]).catch(console.error)))
    bar.append(PowerButton(deps, ACTION_ICONS.shutdown, "shutdown",
        () => execAsync(["systemctl", "poweroff"]).catch(console.error)))

    // The bar's pill is the translucent surface; the buttons are only their
    // content until you touch them. Wrapped WITHOUT followFocus on purpose: a
    // container reports FOCUS_WITHIN whenever any child has focus, which would
    // paint the whole bar accent when what is focused is one button inside it.
    //
    // ⚠️ The lockscreen's copy of this comment claimed the buttons were "accent and
    // opaque" — a design REMOVED in #99/#100, when accent went back to meaning
    // state only. It was still there on 2026-08-10, describing pixels that had not
    // existed for a day, which is the cheapest possible demonstration of what two
    // copies cost: the code was fixed in both and the explanation in one.
    return withGlassCapsule(bar)
}
