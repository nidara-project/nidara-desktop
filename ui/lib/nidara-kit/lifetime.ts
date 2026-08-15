import { Gtk } from "ags/gtk4"

/**
 * Bind a live subscription to a widget's REALIZED lifetime.
 *
 * Use this instead of `widget.connect("unrealize", dispose)` for anything a widget
 * needs in order to stay CURRENT: service watches, signal handlers, GLib timers.
 *
 * Why it must exist: any surface that CACHES its widgets instead of rebuilding them
 * — Settings is the one that produced this, with its `pageCache` — only `remove()`s
 * a page from the content area when you navigate away. That unrealizes it WITHOUT
 * destroying it, and coming back re-realizes the very same widget. A plain
 * unrealize-cleanup therefore fires the first time the user leaves and is never
 * undone: the page returns looking alive but frozen — a device list that no longer
 * notices a headset, a clock preview stuck at the minute you left. `safeDisconnect`
 * and once-guards (tech-debt #12) only made that silent; they never re-armed
 * anything.
 *
 * `subscribe` runs on every realize and its returned disposer on every unrealize,
 * so put the initial refresh inside it too: a widget you come back to should show
 * the world as it is now, not as it was when the window opened.
 *
 * It lives in the kit because the kit's composed rows need it — `NidaraToggleRow`
 * and `NidaraDropDownRow` re-arm their external-sync callback through it, and a
 * component in `ui/lib/` may not import from `ui/shell/`. Settings re-exports it
 * from `SettingsHelpers` so its pages keep their import path.
 */
export function bindWhileRealized(
    widget: Gtk.Widget,
    subscribe: () => (() => void) | void,
): void {
    let dispose: (() => void) | null = null
    const start = () => {
        if (dispose) return
        const d = subscribe()
        dispose = typeof d === "function" ? d : () => {}
    }
    const stop = () => { if (dispose) { dispose(); dispose = null } }
    widget.connect("realize", start)
    widget.connect("unrealize", stop)
    if (widget.get_realized()) start()
}
