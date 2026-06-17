import { Gtk } from "ags/gtk4"

/**
 * NidaraOverlayManager
 *
 * Manages all floating UI (dropdowns, tooltips, menus) through a single
 * window-level Gtk.Overlay. This avoids Gtk.Popover's separate Wayland
 * surface, which causes CSS to be unreliable in layer-shell contexts.
 *
 * Pattern: every window that needs floating UI creates one manager from
 * its root Gtk.Overlay and passes it down to child components.
 *
 * Only one popup is open at a time. Opening a second one closes the first.
 */
export class NidaraOverlayManager {
  readonly overlay: Gtk.Overlay

  private activeWidget: Gtk.Widget | null = null
  private backdrop: Gtk.Box | null = null

  constructor(overlay: Gtk.Overlay) {
    this.overlay = overlay
  }

  /**
   * Show a widget floating at (anchorX, anchorY) in overlay coordinates.
   * The widget is placed above a transparent fullscreen backdrop that
   * catches any outside click to close the popup automatically.
   */
  show(widget: Gtk.Widget, anchorX: number, anchorY: number) {
    // Close any existing popup first
    this._hide()

    // ── Backdrop (transparent, fullscreen, below the popup) ──────────────────
    // Catches clicks outside the popup and closes it.
    const bd = new Gtk.Box({ hexpand: true, vexpand: true })
    bd.halign = Gtk.Align.FILL
    bd.valign = Gtk.Align.FILL
    const bdClick = new Gtk.GestureClick()
    bdClick.connect("pressed", () => this._hide())
    bd.add_controller(bdClick)
    this.overlay.add_overlay(bd)
    this.backdrop = bd

    // ── Popup (positioned with margin, above backdrop) ───────────────────────
    widget.margin_start = Math.round(anchorX)
    widget.margin_top   = Math.round(anchorY)
    widget.halign  = Gtk.Align.START
    widget.valign  = Gtk.Align.START
    widget.hexpand = false
    widget.vexpand = false
    this.overlay.add_overlay(widget)
    this.activeWidget = widget
  }

  hide() {
    this._hide()
  }

  get isOpen(): boolean {
    return this.activeWidget !== null
  }

  private _hide() {
    if (this.backdrop) {
      try { this.overlay.remove_overlay(this.backdrop) } catch (_) {}
      this.backdrop = null
    }
    if (this.activeWidget) {
      try { this.overlay.remove_overlay(this.activeWidget) } catch (_) {}
      this.activeWidget = null
    }
  }
}
