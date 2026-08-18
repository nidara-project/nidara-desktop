import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import { formatDatePart, type DateFormat } from "./date-names"
import { playEntrance } from "./entrance"

// The date + time block of the greeter and the lockscreen — the hero of both
// screens. Returns the two labels in a column with no container chrome, for
// embedding straight into the surface.
//
// ── WHAT WAS ACTUALLY DIFFERENT BETWEEN THE TWO COPIES ──────────────────────
// One thing, and it is not cosmetic: WHERE region.json is read from. The
// lockscreen runs AS the user, so it reads its own `XDG_CONFIG_HOME`. The greeter
// runs as a SYSTEM user who owns no such file and may not be able to read the
// user's, so it tries the last-logged-in user's home first and then the
// world-readable mirror at /var/tmp/nidara. That is a privilege difference, not a
// preference, so it stays with the bundle and arrives here as a function.
//
// Everything else — the format strings, both timers, the classes, the column —
// was identical, and is now written once.

export interface RegionSettings {
    timeFormat: "24h" | "12h"
    showSeconds: boolean
    dateFormat: DateFormat
}

export interface ClockDeps {
    /** Read the user's region settings. Differs per bundle by PRIVILEGE — see above. */
    readRegion: () => RegionSettings
    /** The bundle's locale-change subscription, where it HAS one (greeter only). */
    onLocaleChange?: (fn: () => void) => void
}

export function NidaraClock(deps: ClockDeps): Gtk.Widget {
    // Read once, as both copies did: these two surfaces are built, shown and
    // dismissed, and a settings change during a login is not a case that exists.
    const region = deps.readRegion()
    const timeFmt = region.timeFormat === "12h"
        ? (region.showSeconds ? "%I:%M:%S %p" : "%I:%M %p")
        : (region.showSeconds ? "%H:%M:%S" : "%H:%M")

    const formatTime = () => GLib.DateTime.new_now_local().format(timeFmt) ?? ""
    const formatDate = () => formatDatePart(region.dateFormat, GLib.DateTime.new_now_local())

    const dateLabel = new Gtk.Label({
        label: formatDate(),
        css_classes: ["greeter-date"],
        halign: Gtk.Align.CENTER,
        xalign: 0.5,
    })

    const timeLabel = new Gtk.Label({
        label: formatTime(),
        css_classes: ["greeter-clock"],
        halign: Gtk.Align.CENTER,
        xalign: 0.5,
    })

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        timeLabel.label = formatTime()
        return GLib.SOURCE_CONTINUE
    })

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
        dateLabel.label = formatDate()
        return GLib.SOURCE_CONTINUE
    })

    // The greeter's language dropdown changes the process locale live (setLocale →
    // applyProcessLocale) — repaint the date now, not on the next minute tick. The
    // lockscreen has no picker, so it passes nothing and this never exists.
    deps.onLocaleChange?.(() => { dateLabel.label = formatDate() })

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        // The hero block arrives WITH the card rather than being there before it —
        // both screens are one composition, and animating the card over a clock
        // that was already sitting there read as one element on a static backdrop.
        // Same class pair and same transition as `.greeter-card`; the numbers
        // differ because this block is `valign: START` and the card is CENTER, so
        // centring gives the card half its margin back and this gets all of it.
        css_classes: ["greeter-hero"],
    })
    box.append(dateLabel)
    box.append(timeLabel)

    // Same entrance as the card, same duration and curve, each on its own `map` —
    // which is what keeps them in step without either knowing about the other. 21
    // and not 40: this block is `valign: START`, so it keeps all of its margin as
    // travel (and it is ADDITIVE with the `margin_top = 72` its host sets).
    playEntrance(box, { rise: 21 })
    return box
}
