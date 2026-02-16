import { Gtk, Gdk } from "ags/gtk4"
import GLib from "gi://GLib"

export function debugWidgetState(widget: Gtk.Widget, name: string) {
    if (!widget) return

    const dump = () => {
        const state = widget.get_state_flags()
        const flags: string[] = []
        if (state & Gtk.StateFlags.NORMAL) flags.push("NORMAL")
        if (state & Gtk.StateFlags.ACTIVE) flags.push("ACTIVE")
        if (state & Gtk.StateFlags.PRELIGHT) flags.push("PRELIGHT (Hover)")
        if (state & Gtk.StateFlags.SELECTED) flags.push("SELECTED")
        if (state & Gtk.StateFlags.INSENSITIVE) flags.push("INSENSITIVE")
        if (state & Gtk.StateFlags.INCONSISTENT) flags.push("INCONSISTENT")
        if (state & Gtk.StateFlags.FOCUSED) flags.push("FOCUSED")
        if (state & Gtk.StateFlags.BACKDROP) flags.push("BACKDROP")
        if (state & Gtk.StateFlags.DIR_LTR) flags.push("DIR_LTR")
        if (state & Gtk.StateFlags.DIR_RTL) flags.push("DIR_RTL")
        if (state & Gtk.StateFlags.LINK) flags.push("LINK")
        if (state & Gtk.StateFlags.VISITED) flags.push("VISITED")
        if (state & Gtk.StateFlags.CHECKED) flags.push("CHECKED")
        if (state & Gtk.StateFlags.DROP_ACTIVE) flags.push("DROP_ACTIVE")
        if (state & Gtk.StateFlags.FOCUS_VISIBLE) flags.push("FOCUS_VISIBLE")
        if (state & Gtk.StateFlags.FOCUS_WITHIN) flags.push("FOCUS_WITHIN")

        console.log(`[StateDebug] ${name}: [${flags.join(", ")}]`)
        return GLib.SOURCE_CONTINUE
    }

    // Dump every 500ms
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, dump)
}
