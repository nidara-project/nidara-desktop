// Day/month names + date order for the greeter clock, from the system regional
// format via GLib (%a/%A/%b/%B resolve through LC_TIME). Duplicated from
// ui/shell/core/i18n/dateNames.ts (separate ags bundle) — pure logic, no locale data.

import GLib from "gi://GLib"

export type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

// Probe the locale's numeric date (2 Jan) once: it reveals both the order (day-first
// locales render "02/01/…", month-first "01/02/…") and the separator ("/", ".", "-"…).
const _PROBE = GLib.DateTime.new_local(2000, 1, 2, 0, 0, 0).format("%x") ?? "01/02/2000"
const DAY_FIRST = /^0?2\b/.test(_PROBE)
const SEP = _PROBE.match(/\D/)?.[0] ?? "/"

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
        case "numeric":    return DAY_FIRST ? `${two(d)}${SEP}${two(m)}${SEP}${y}` : `${two(m)}${SEP}${two(d)}${SEP}${y}`
        case "iso":        return `${y}-${two(m)}-${two(d)}`
        default:           return DAY_FIRST ? `${wa}, ${d} ${mb}` : `${wa}, ${mb} ${d}`
    }
}
