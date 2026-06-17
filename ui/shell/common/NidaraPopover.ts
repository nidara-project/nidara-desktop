import { Gtk } from "ags/gtk4"
import GObject from "gi://GObject"

// NidaraPopover: Gtk.Popover with nidara shell styling applied via CSS.
// The glass background, border and rounded corners come from
// popover.nidara-popover > contents { ... } in _components.scss.
// The native GTK arrow is kept and re-coloured to match the contents box.
// Blur comes from Hyprland: popups=true on the parent layer + alpha ≥ 0.38.

export class NidaraPopover extends Gtk.Popover {
    static {
        GObject.registerClass({ GTypeName: "NidaraPopover" }, this)
    }

    constructor(params?: Partial<Gtk.Popover.ConstructorProps>) {
        super(params)
        this.add_css_class("nidara-popover")
    }
}
