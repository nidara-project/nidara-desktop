// Day/month names + date order for the greeter clock, from the system regional
// format via GLib (%a/%A/%b/%B resolve through LC_TIME). Duplicated from
// ui/shell/core/i18n/dateNames.ts (separate ags bundle) — pure logic, no locale data.

import GLib from "gi://GLib"

export type DateFormat = "none" | "short" | "short-year" | "long" | "numeric" | "iso"

// Probe the locale's numeric date (2 Jan 2000): it reveals the order (day-first
// locales render "02/01/…", month-first "01/02/…", year-first CJK locales render
// "2000年01月02日…") and the separator(s). Year-first is checked separately since CJK
// locales interleave a different literal between each field (年/月/日) rather than
// repeating one separator — captured here as three independent groups so any such
// locale (not just zh/ja) is handled without a per-language table.
let YEAR_FIRST = false
let ymdYearSep = "", ymdMonthSep = "", ymdDaySuffix = ""
let DAY_FIRST = false
let SEP = "/"

/**
 * (Re-)derive the date order/separators from the CURRENT process LC_TIME.
 * Runs once at module init; i18n's applyProcessLocale() re-runs it after a
 * live setlocale() (greeter language dropdown) — %x reads the process locale,
 * so without the re-probe the old order/separators would stick.
 * Greeter-only export: the shell/lockscreen copies keep a fixed process
 * locale for their whole lifetime.
 */
export function refreshDateFormat() {
    const probe = GLib.DateTime.new_local(2000, 1, 2, 0, 0, 0).format("%x") ?? "01/02/2000"
    const ymd = probe.match(/^2000(\D*)01(\D*)02(\D*)$/)
    YEAR_FIRST = !!ymd
    ymdYearSep = ymd?.[1] ?? ""
    ymdMonthSep = ymd?.[2] ?? ""
    ymdDaySuffix = ymd?.[3] ?? ""
    DAY_FIRST = !YEAR_FIRST && /^0?2\b/.test(probe)
    SEP = probe.match(/\D/)?.[0] ?? "/"
}
refreshDateFormat()

const two = (n: number) => String(n).padStart(2, "0")

/** Format the DATE portion (no time) for the given format, localized via LC_TIME. */
export function formatDatePart(fmt: DateFormat, dt: GLib.DateTime): string {
    const d = dt.get_day_of_month()
    const m = dt.get_month()
    const y = dt.get_year()
    // .trim() drops glibc's fixed-width padding on some abbreviated names (e.g.
    // ja_JP's abmon is space-padded to 2 digits: " 4月") — irrelevant outside
    // tabular date/time strings, harmless for every other locale (nothing to trim).
    const wa = (dt.format("%a") ?? "").trim(), wA = (dt.format("%A") ?? "").trim()
    const mb = (dt.format("%b") ?? "").trim(), mB = (dt.format("%B") ?? "").trim()
    switch (fmt) {
        case "none": return ""
        case "short":
            if (YEAR_FIRST) return `${mb}${d}${ymdDaySuffix} ${wa}`
            return DAY_FIRST ? `${wa}, ${d} ${mb}` : `${wa}, ${mb} ${d}`
        case "short-year":
            if (YEAR_FIRST) return `${y}${ymdYearSep}${mb}${d}${ymdDaySuffix} ${wa}`
            return DAY_FIRST ? `${wa}, ${d} ${mb} ${y}` : `${wa}, ${mb} ${d} ${y}`
        case "long":
            if (YEAR_FIRST) return `${mB}${d}${ymdDaySuffix} ${wA}`
            return DAY_FIRST ? `${wA}, ${d} ${mB}` : `${wA}, ${mB} ${d}`
        case "numeric":
            if (YEAR_FIRST) return `${y}${ymdYearSep}${two(m)}${ymdMonthSep}${two(d)}${ymdDaySuffix}`
            return DAY_FIRST ? `${two(d)}${SEP}${two(m)}${SEP}${y}` : `${two(m)}${SEP}${two(d)}${SEP}${y}`
        case "iso": return `${y}-${two(m)}-${two(d)}`
        default:
            if (YEAR_FIRST) return `${mb}${d}${ymdDaySuffix} ${wa}`
            return DAY_FIRST ? `${wa}, ${d} ${mb}` : `${wa}, ${mb} ${d}`
    }
}
