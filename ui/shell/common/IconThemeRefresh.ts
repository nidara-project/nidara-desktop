import Gio from "gi://Gio"
import Gtk from "gi://Gtk?version=4.0"
import { onInterfaceIconThemeChange, uiIcon, uiIconNameForFile } from "../core/Icons"

/**
 * A new interface icon theme reaches the icons ALREADY on screen.
 *
 * `uiIcon` hands back a `Gio.FileIcon`, which is one file: the widget holds that
 * file, and a new theme clears the cache without anyone asking the widget again.
 * Before this, choosing a theme in Settings changed nothing until the shell was
 * restarted (seen by the owner on the first try, 2026-09-16).
 *
 * So, after a change, walk every window we own — hidden ones too: Settings hides on
 * close and keeps its tree — and give each `Gtk.Image` holding one of OUR files the
 * current theme's answer for the same name. An image showing anything else (an app
 * icon, a tray icon, an avatar) is not ours and is left alone.
 *
 * 🔑 Popovers are reached by the same walk: a `Gtk.Popover` is a child of the widget
 * it is attached to (`gtk_widget_set_parent`), so `get_first_child` finds it.
 *
 * ⚠️ Two holes, one handled elsewhere:
 *  - an icon stored at module load and made into a widget LATER does not exist yet
 *    to be walked → its consumer passes it through `currentUiIcon`;
 *  - a widget that was built and then unparented (kept aside, not in any window)
 *    is not reached, and shows the old drawing until it is rebuilt.
 */
function walk(widget: Gtk.Widget, swap: (img: Gtk.Image) => void) {
    if (widget instanceof Gtk.Image) swap(widget)
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        walk(child, swap)
    }
}

export function refreshInterfaceIcons(): number {
    let swapped = 0
    const swap = (img: Gtk.Image) => {
        const gicon = img.gicon
        if (!(gicon instanceof Gio.FileIcon)) return
        const path = (gicon as Gio.FileIcon).get_file().get_path()
        const name = path ? uiIconNameForFile(path) : null
        if (!name) return
        const fresh = uiIcon(name)
        if (fresh !== gicon) { img.gicon = fresh; swapped++ }
    }
    const windows = Gtk.Window.list_toplevels()
    for (const w of windows) walk(w, swap)
    return swapped
}

export function bindInterfaceIconRefresh(): () => void {
    return onInterfaceIconThemeChange(() => {
        const n = refreshInterfaceIcons()
        // One line per theme change: when this does not run, nothing is visibly wrong
        // until someone notices the bar did not change.
        console.log(`[IconThemeRefresh] ${n} icon(s) redrawn`)
    })
}
