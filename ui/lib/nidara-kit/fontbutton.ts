import { Gtk } from "ags/gtk4"
import Pango from "gi://Pango"
import { NidaraButton } from "./button"

export interface NidaraFontButtonOpts {
    /** Current font as a GTK font-name string, e.g. "Inter Variable 14". */
    font: string
    /** Called with the new font-name string when the user picks one. */
    onFontSet: (font: string) => void
    /** Dialog title. */
    title?: string
}

/**
 * NidaraFontButton — pill button showing the current font (previewed in that
 * font) that opens a Gtk.FontDialog. Replaces the default Gtk.FontButton so the
 * trigger matches the Nidara look. The chooser dialog itself is GTK's (not
 * restyleable), but it opens parented/modal over its window.
 */
export function NidaraFontButton(opts: NidaraFontButtonOpts): Gtk.Button {
    const btn = NidaraButton({ variant: "secondary", pill: true, valign: Gtk.Align.CENTER })

    const label = new Gtk.Label({
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: 22,
    })
    btn.set_child(label)

    let current = opts.font

    const refresh = () => {
        const desc = Pango.FontDescription.from_string(current)
        const family = desc.get_family() || "Sans"
        const size = desc.get_size() > 0 ? Math.round(desc.get_size() / Pango.SCALE) : 0
        label.set_text(size ? `${family}  ${size}` : family)
        // Preview: render the label text in the selected font (like Gtk.FontButton).
        const attrs = Pango.AttrList.new()
        attrs.insert(Pango.attr_font_desc_new(desc))
        label.set_attributes(attrs)
    }
    refresh()

    btn.connect("clicked", () => {
        const fd = new Gtk.FontDialog({ title: opts.title ?? "Choose a font" })
        const parent = btn.get_root() as Gtk.Window
        const initial = Pango.FontDescription.from_string(current)
        fd.choose_font(parent, initial, null, (_: any, res: any) => {
            try {
                const desc = fd.choose_font_finish(res)
                if (!desc) return
                current = desc.to_string()
                refresh()
                opts.onFontSet(current)
            } catch (_) { /* cancelled */ }
        })
    })

    return btn
}
