import { Gtk } from "ags/gtk4"
import Theme, { TEXT_SCALE_MIN, TEXT_SCALE_MAX } from "../../../core/ThemeManager"
import { listGroup, createRow, toggleRow, sliderRow, pageBox } from "../SettingsHelpers"
import Icons from "../../../core/Icons"
import { safeDisconnect } from "../../../core/signals"
import { reduceMotion, setReduceMotion, onReduceMotionChange } from "../../../core/ReduceMotion"
import { t } from "../../../core/i18n"

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

    // ⚠️ `Theme.setCursorSize`, never a bare `set_int("cursor-size")` on the
    // gsetting. The
    // gsetting is only ONE of three consumers — Hyprland's live compositor cursor
    // takes `hyprctl setcursor` and XWayland apps read gtk `settings.ini`, neither
    // of which watches dconf. This row wrote the gsetting alone until 2026-08-16,
    // so the slider moved the pointer inside GTK apps and left the actual desktop
    // cursor untouched. ThemeManager is the one place that knows all three.
    //
    // This is also the ONLY cursor-size control now. Appearance had a second one (a
    // 16/24/32/48/64 dropdown) which was correctly wired but in the wrong room:
    // GNOME and macOS both file pointer size under accessibility, and two controls
    // over one setting is how the keyboard-layout variant got wiped in #145.
    visionGroup.listBox.append(sliderRow(
        t("settings.accessibility.cursor-size"),
        t("settings.accessibility.cursor-size.desc"),
        Theme.cursorSize, 16, 96,
        (v) => void Theme.setCursorSize(v),
        {
            unit: "px",
            icons: [Icons.mousePointer, Icons.mousePointer],
            // Applying costs two subprocesses (`gsettings set`, `hyprctl setcursor`)
            // plus a settings.ini rewrite, so this one commits on RELEASE — unlike
            // the text-scale slider above, whose apply is in-process and therefore
            // affordable per step. The value label still follows the thumb.
            commitOnRelease: true,
            // The page is cached; the cursor size can move underneath it (the About
            // page's reset, an agent, `gsettings` from a terminal). Re-read on realize.
            onExtChange: (cb) => {
                const id = Theme.connect("changed", () => cb(Theme.cursorSize))
                cb(Theme.cursorSize)
                return () => safeDisconnect(Theme, id)
            },
        },
    ))

    page.append(visionGroup.box)

    // ── Motion ────────────────────────────────────────────────────────────────
    // Phrased as the ACCOMMODATION ("Reduce motion", on = less movement), like
    // GNOME, macOS and `prefers-reduced-motion`, not as the mechanism it flips.
    // The underlying gsetting is still `enable-animations` and still the inverse;
    // `core/ReduceMotion.ts` owns that inversion and is the only place it happens.
    //
    // Until 2026-08-16 this row wrote that gsetting and NOTHING in the shell read
    // it, so the switch reached the animations inside applications and left the
    // desktop's own — every overlay, the dock springs, the island morph, all of
    // Hyprland's window and workspace motion — running. On an accessibility page
    // that reads as a promise about the desktop.
    const motionGroup = listGroup(t("settings.accessibility.group.motion"))

    motionGroup.listBox.append(toggleRow(
        t("settings.accessibility.reduce-motion"),
        t("settings.accessibility.reduce-motion.desc"),
        reduceMotion(),
        (v) => setReduceMotion(v),
        // Also reachable from `setConfig accessibility.reduceMotion` and from
        // `gsettings` directly, and the page is cached — re-read on realize.
        (apply) => {
            apply(reduceMotion())
            return onReduceMotionChange(apply)
        },
    ))

    page.append(motionGroup.box)

    return page
}
