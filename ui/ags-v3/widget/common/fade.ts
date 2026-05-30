import GLib from "gi://GLib"
import { Gtk } from "ags/gtk4"

// Unified overlay fade for in-bar-window panels (CC, NC, Prism, system menu,
// overview). Pairs with the `.overlay-fade` / `.overlay-open` CSS (a pure
// opacity crossfade). Pattern: map the widget first, then add `.overlay-open`
// so the CSS transition runs; on close, remove the class and DEFER
// set_visible(false) until the fade-out finishes — and run `onHidden` then, so
// callers can refresh the layer-shell input region once the panel is truly gone
// (otherwise it would keep catching clicks while fading out).
//
// Must stay ≥ the CSS transition duration (240ms) so the fade-out completes.
export const FADE_HIDE_MS = 260

export function makeFadeToggle(widget: Gtk.Widget, onHidden?: () => void) {
  let timer: number | null = null
  return (open: boolean) => {
    if (timer) { GLib.source_remove(timer); timer = null }
    if (open) {
      widget.set_visible(true)
      // Defer one frame so the widget is mapped at opacity 0 before we flip the
      // class — otherwise GTK skips the transition and it pops in instantly.
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        widget.add_css_class("overlay-open")
        timer = null
        return GLib.SOURCE_REMOVE
      })
    } else {
      widget.remove_css_class("overlay-open")
      timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FADE_HIDE_MS, () => {
        // Re-check the class so a reopen during the fade-out cancels the hide.
        if (!widget.has_css_class("overlay-open")) {
          widget.set_visible(false)
          onHidden?.()
        }
        timer = null
        return GLib.SOURCE_REMOVE
      })
    }
  }
}
