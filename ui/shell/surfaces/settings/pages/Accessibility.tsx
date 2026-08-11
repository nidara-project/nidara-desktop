import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import Theme, { TEXT_SCALE_MIN, TEXT_SCALE_MAX } from "../../../core/ThemeManager"
import { listGroup, createRow, toggleRow, sliderRow, pageBox } from "../SettingsHelpers"
import Icons from "../../../core/Icons"
import { t } from "../../../core/i18n"

const iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })

function getCursorSize(): number {
    try { return iface.get_int("cursor-size") } catch { return 24 }
}
function setCursorSize(size: number) {
    try { iface.set_int("cursor-size", Math.round(size)) } catch (e) {
        console.error("[Accessibility] cursor-size:", e)
    }
}
function getAnimations(): boolean {
    try { return iface.get_boolean("enable-animations") } catch { return true }
}
function setAnimations(v: boolean) {
    try { iface.set_boolean("enable-animations", v) } catch (e) {
        console.error("[Accessibility] enable-animations:", e)
    }
}

export default function AccessibilityPage() {
    const page = pageBox("accessibility-page")

    // ── Vision ────────────────────────────────────────────────────────────────
    const visionGroup = listGroup(t("settings.accessibility.group.vision"))

    visionGroup.listBox.append(sliderRow(
        t("settings.accessibility.text-scale"),
        t("settings.accessibility.text-scale.desc"),
        // ⚠️ The ceiling is 1.5, and it is a MEASURED limit of the geometry, not a
        // taste call. Only the reflowing windows (Settings, About, the alert dialog)
        // follow this factor — chrome is px-pinned in `_reset.scss` — and their boxes
        // are still fixed px while their text is em (tech-debt #62). Looked at on
        // screen at factor 2.0 (2026-08-11): nothing overflows any more now that the
        // sidebar label ellipsizes, but the Settings nav truncates to "Notificatio…"
        // and a row carrying two trailing controls (Top bar → Custom icon) squeezes
        // its subtitle into four lines. At 1.5 nothing truncates in the content pane
        // and every row still reads. Raise this when the geometry scales too — not
        // before, and only after looking at it again.
        //
        // For reference: GNOME's own accessibility "Large Text" is 1.25.
        Theme.textScaling, TEXT_SCALE_MIN, TEXT_SCALE_MAX,
        (v) => Theme.setTextScaling(v),
        {
            decimals: 2,
            // ⚠️ DETENTS of 0.05, and this is the direct answer to "the slider only
            // changes in certain positions". Font rendering hints glyph advances to
            // whole pixels, so a 0.01 slider offers precision the screen cannot show:
            // measured over 0.75–1.50, only 37 of 75 one-hundredth steps changed the
            // rendered width of a label, while all 75 moved the number. (The version
            // this replaces was far worse — it rewrote the font size in whole PIXELS,
            // so ~5 of every 6 positions were byte-identical, in runs of six or seven
            // consecutive dead steps.) At 0.05 every stop moves the em by 0.73px and
            // every stop changes what you see. 16 stops is ample for a text size.
            step: 0.05,
            // Follows the thumb. It used to commit only on release, because each step
            // spawned a `gsettings` subprocess — the reason was cost, not design, and
            // the result was a slider whose effect you could not see while choosing it.
            // `setTextScaling` now writes the gsetting in-process, and the resize costs
            // nothing beyond that: the fonts are stored in points, so GTK applies the
            // factor through the dpi (measured 2026-08-11: factor 1.10 → 16.13px,
            // 1.13 → 16.57px, 1.17 → 17.16px — continuous, where the pixel-based
            // rewrite it replaced gave 17px for all three).
            commitOnRelease: false,
            endpoints: [
                new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-sm"], valign: Gtk.Align.CENTER }),
                new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-lg"], valign: Gtk.Align.CENTER }),
            ],
        },
    ))

    visionGroup.listBox.append(sliderRow(
        t("settings.accessibility.cursor-size"),
        t("settings.accessibility.cursor-size.desc"),
        getCursorSize(), 16, 96,
        (v) => setCursorSize(v),
        { unit: "px", icons: [Icons.mousePointer, Icons.mousePointer] },
    ))

    page.append(visionGroup.box)

    // ── Motion ────────────────────────────────────────────────────────────────
    const motionGroup = listGroup(t("settings.accessibility.group.motion"))

    motionGroup.listBox.append(toggleRow(
        t("settings.accessibility.animations"),
        t("settings.accessibility.animations.desc"),
        getAnimations(),
        (v) => setAnimations(v),
    ))

    page.append(motionGroup.box)

    return page
}
