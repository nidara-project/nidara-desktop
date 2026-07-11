// Day/month names + date order for the clock, from the system regional format.
//
// We format via GLib's %a/%A/%b/%B, which resolve names through LC_TIME — so every
// installed locale is localized for free, with NO per-language tables to maintain.
// Order (day-first vs month-first) is derived once from the locale's own numeric
// format (%x): does it place the day before the month? This tracks the "Regional
// Format" setting (Settings → Language & Region), like Gtk.Calendar and macOS/GNOME.
//
// The same helper is duplicated in ui/greeter/lib/dateNames.ts and
// ui/lockscreen/lib/dateNames.ts (separate ags bundles) — but it's pure logic now,
// no locale data, so adding a language needs zero changes here.

import GLib from "gi://GLib"

export type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

// Probe the locale's numeric date order with a day≠month date (2 Jan): day-first
// locales render "02/01/…", month-first ones "01/02/…".
const DAY_FIRST = /^0?2\b/.test(GLib.DateTime.new_local(2000, 1, 2, 0, 0, 0).format("%x") ?? "")

const two = (n: number) => String(n).padStart(2, "0")

/** Format the DATE portion (no time) for the given format, localized via LC_TIME. */
export function formatDatePart(fmt: DateFormat, dt: GLib.DateTime): string {
    const d = dt.get_day_of_month()
    const m = dt.get_month()
    const y = dt.get_year()
    const wa = dt.format("%a") ?? "", wA = dt.format("%A") ?? ""
    const mb = dt.format("%b") ?? "", mB = dt.format("%B") ?? ""
    switch (fmt) {
        case "none":       return ""
        case "short":      return DAY_FIRST ? `${wa}, ${d} ${mb}` : `${wa}, ${mb} ${d}`
        case "short-year": return DAY_FIRST ? `${wa}, ${d} ${mb} ${y}` : `${wa}, ${mb} ${d} ${y}`
        case "long":       return DAY_FIRST ? `${wA}, ${d} ${mB}` : `${wA}, ${mB} ${d}`
        case "numeric":    return DAY_FIRST ? `${two(d)}/${two(m)}/${y}` : `${two(m)}/${two(d)}/${y}`
        case "iso":        return `${y}-${two(m)}-${two(d)}`
        default:           return DAY_FIRST ? `${wa}, ${d} ${mb}` : `${wa}, ${mb} ${d}`
    }
}
