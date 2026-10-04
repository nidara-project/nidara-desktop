import Gio from "gi://Gio"
import { settings } from "./CompositorState"

/**
 * A window's buttons — which, and on which side — have ONE source: the key every app that draws
 * its own title bar reads, `org.gnome.desktop.wm.preferences button-layout` (GTK's client-side
 * decorations, Chrome's web apps, Telegram; directly or through the Settings portal). Owner,
 * 2026-10-04: Settings writes it, the compositor's controls follow it — so a change made
 * elsewhere (GNOME Tweaks: close alone) shrinks Hyalo's capsule too, as mutter follows it on
 * GNOME. The shell carries it to Hyalo's `[windows.controls]`; where the compositor draws no
 * controls (Hyprland) nothing is carried, and Settings offers no choice.
 *
 * The key is `left:right`, comma-separated names (`appmenu:minimize,maximize,close`). The side
 * is the half close is in; the order within it is the compositor's (close outermost), not the
 * key's. Nidara's default is a system dconf default (`scripts/gen-dconf-defaults.sh`):
 * maximize and close — no minimize until Hyalo minimizes (#724), since an app's own button
 * cannot be shown disabled.
 */

export type Side = "right" | "left"
export type WindowButton = "close" | "minimize" | "maximize"

const OURS: readonly WindowButton[] = ["minimize", "maximize", "close"]
const ORDER: Record<Side, readonly WindowButton[]> = {
    right: ["minimize", "maximize", "close"],
    left: ["close", "minimize", "maximize"],
}

/** What a `button-layout` value says: the side and the buttons. Unknown names (appmenu, icon,
 *  spacer) are not ours and are left to the apps. */
export function parseButtonLayout(layout: string): { side: Side, buttons: WindowButton[] } {
    const [left = "", right = ""] = layout.split(":")
    const names = (half: string) => half.split(",").map(n => n.trim()).filter((n): n is WindowButton => OURS.includes(n as WindowButton))
    const l = names(left), r = names(right)
    const side: Side = l.includes("close") ? "left" : r.includes("close") ? "right" : l.length > r.length ? "left" : "right"
    const buttons = OURS.filter(b => l.includes(b) || r.includes(b))
    return { side, buttons }
}

/** The value for `buttons` on `side`, in the compositor's order. */
export function formatButtonLayout(side: Side, buttons: readonly WindowButton[]): string {
    const half = ORDER[side].filter(b => buttons.includes(b)).join(",")
    return side === "right" ? `appmenu:${half}` : `${half}:appmenu`
}

let prefs: InstanceType<typeof Gio.Settings> | null = null
function wm(): InstanceType<typeof Gio.Settings> {
    // Held for the life of the process: an unreferenced Gio.Settings is collected with its handlers.
    prefs ??= new Gio.Settings({ schema_id: "org.gnome.desktop.wm.preferences" })
    return prefs
}

export function readWindowButtons(): { side: Side, buttons: WindowButton[] } {
    return parseButtonLayout(wm().get_string("button-layout"))
}

/** Settings' choice of side: the same buttons, moved. */
export function setWindowButtonsSide(side: Side): void {
    const layout = formatButtonLayout(side, readWindowButtons().buttons)
    if (wm().get_string("button-layout") !== layout) wm().set_string("button-layout", layout)
}

/** `fn` on every change of the key, from Settings or from anywhere else. */
export function onWindowButtonsChanged(fn: () => void): () => void {
    const id = wm().connect("changed::button-layout", fn)
    return () => wm().disconnect(id)
}

let started = false
/** Keeps the compositor's controls equal to the key, from now on. Idempotent. */
export function startWindowButtonsSync(): void {
    if (started || !settings.caps.windowControls) return
    started = true
    const push = () => {
        const { side, buttons } = readWindowButtons()
        settings.setWindowControls(side, buttons)
    }
    onWindowButtonsChanged(push)
    push()
}
