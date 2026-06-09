import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"

/**
 * Run `tick` every `interval` ms, but ONLY while `widget` is mapped.
 *
 * Why this exists: overlay content (CC tiles, bar expansions) is built once and
 * then hidden, not destroyed — a plain `GLib.timeout_add` in a tile keeps
 * polling for the whole session even though nobody can see the value. Gate the
 * timer on map/unmap instead: fresh value the instant the widget becomes
 * visible, zero wakeups while it isn't.
 */
export function pollWhileMapped(widget: Gtk.Widget, interval: number, tick: () => void) {
    let id: number | null = null
    const start = () => {
        if (id !== null) return
        tick()
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            tick()
            return GLib.SOURCE_CONTINUE
        })
    }
    const stop = () => {
        if (id !== null) {
            GLib.source_remove(id)
            id = null
        }
    }
    widget.connect("map", start)
    widget.connect("unmap", stop)
    if (widget.get_mapped()) start()
}
