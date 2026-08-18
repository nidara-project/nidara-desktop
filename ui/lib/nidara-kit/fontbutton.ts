import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import { NidaraButton } from "./button"
import { bindWhileRealized } from "./lifetime"

export interface NidaraFontButtonOpts {
    /** Current font as a GTK font-name string, e.g. "Inter Variable 14". */
    font: string
    /** Called with the new font-name string when the user picks one. */
    onFontSet: (font: string) => void
    /** Dialog title. */
    title?: string
    /**
     * Live external-sync, the same guarded contract the composed rows use: register
     * a callback invoked when the font changes OUTSIDE this button (another Settings
     * window — there is one per monitor — or anything else that writes the setting).
     * It repaints the label WITHOUT firing `onFontSet`, and returns a disposer.
     *
     * Prime it (call `apply` once before subscribing): it is armed through
     * `bindWhileRealized`, so a primed hook is what makes the button re-read every
     * time its page comes back rather than keep the string it was built with.
     */
    onExtChange?: (apply: (font: string) => void) => (() => void)
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
        // ⚠️ The unit is not decoration. A Pango size is points OR pixels depending
        // on `size_is_absolute`, and both reach this button: Nidara stores points
        // (ThemeManager.fontToPoints) but another tool — or a pre-migration install —
        // can leave a `<n>px` font in gsettings, where a bare "15" would read as 15pt
        // and be 15px. The suffix is how the difference is visible at all.
        const unit = desc.get_size_is_absolute() ? "px" : "pt"
        label.set_text(size ? `${family}  ${size}${unit}` : family)
        // Preview: render the label text in the selected font (like Gtk.FontButton).
        const attrs = Pango.AttrList.new()
        attrs.insert(Pango.attr_font_desc_new(desc))
        label.set_attributes(attrs)
    }
    refresh()

    if (opts.onExtChange) {
        bindWhileRealized(btn, () => opts.onExtChange!((font: string) => {
            if (font === current) return
            current = font
            refresh()
        }))
    }

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
