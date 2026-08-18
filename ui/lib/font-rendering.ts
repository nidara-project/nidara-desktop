import Gtk from "gi://Gtk?version=4.0"

/**
 * Put text on the pixel grid. Call once per bundle, before any window is built.
 *
 * 🔑 This is the whole cure for "the tops of the letters are shaved", and it is a
 * GLOBAL one — there is no per-surface, per-font or per-size half of it. The bug is
 * that a glyph's baseline lands in the MIDDLE of a device pixel row, so a flat-topped
 * letter (T E F H I L) spreads its full-width top stroke over two rows at half
 * intensity, while a round one (G O C S) puts three or four pixels up there and looks
 * fine. "The T is cut but the G isn't" is the signature.
 *
 * The baseline is `size × ascender/upem`, which is fractional for essentially every
 * size — so rounding the FONT SIZE never fixed it (measured: JetBrainsMono at a clean
 * 15px has its baseline at 15.300, and 11pt/14.667px was actually CLOSER to the grid
 * at 14.209). `gtk-hint-font-metrics` is what rounds ascent/descent to whole pixels
 * and puts the baseline on a row.
 *
 * ⚠️ But that setting does nothing on its own. GTK 4.16 added `gtk-font-rendering`,
 * and its default `AUTOMATIC` means "GTK decides", which includes ignoring the
 * low-level font settings — `gtk-hint-font-metrics` among them. Nidara set the hint
 * for months with no effect. Measured, same process, same font:
 *
 *   AUTOMATIC + hint  → Inter 15px baseline 14.531, mono 15px baseline 15.300
 *   MANUAL    + hint  → Inter 15px baseline 15.000, mono 15px baseline 16.000
 *   MANUAL    + no hint → back to 14.531 / 15.300
 *
 * The third line is the control: MANUAL is only the gate, the hint does the work.
 *
 * ⚠️ MANUAL also hands the other `gtk-xft-*` settings back to fontconfig — including
 * `rgba`, so a machine configured for subpixel rendering will now actually get it
 * instead of the grayscale AUTOMATIC picks. That is the intended meaning of the mode
 * (follow the user's font configuration), but it is a visible change, so it belongs in
 * the same comment as the reason for the mode.
 */
export function applyCrispFontRendering() {
    try {
        const settings = Gtk.Settings.get_default()
        if (!settings) return
        settings.gtk_font_rendering = Gtk.FontRendering.MANUAL
        settings.gtk_hint_font_metrics = true
    } catch (e) {
        console.warn("[fonts] could not set crisp font rendering:", e)
    }
}
