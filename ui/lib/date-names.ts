// Day/month names + date order for every clock in the DE, from the system
// regional format.
//
// We format via GLib's %a/%A/%b/%B, which resolve names through LC_TIME — so every
// installed locale is localized for free, with NO per-language tables to maintain.
// Order (day-first vs month-first) is derived once from the locale's own numeric
// format (%x): does it place the day before the month? This tracks the "Regional
// Format" setting (Settings → Language & Region), like Gtk.Calendar and macOS/GNOME.
//
// ── ONE FILE, THREE BUNDLES (since 2026-08-10) ──────────────────────────────
// This lived three times — `ui/shell/core/i18n/`, `ui/greeter/lib/`,
// `ui/lockscreen/lib/` — because they are separate `ags bundle` invocations, and
// each copy said so in its own header. `formatDatePart` was byte-identical in all
// three; what differed was only HOW the probe ran, and the greeter's version was a
// strict superset (below). So this is the greeter's, with the shell's fuller
// explanation kept, and the two subsets deleted.
//
// The reason it matters that they agree is not tidiness: the greeter, the
// lockscreen and the shell's clock are three surfaces a user sees within seconds
// of each other, and a divergence here would show up as the same day rendered
// differently on the login screen and on the desktop. They did agree — checked
// before merging, not assumed — and this is what keeps it that way.

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
 *
 * Runs once at module init, which is all the shell and the lockscreen ever need:
 * their process locale is fixed for their whole lifetime, and they used to hold
 * these as `const`s computed at import.
 *
 * The GREETER is the one that has to re-run it: its language dropdown calls
 * `setlocale()` live (`applyProcessLocale`), and `%x` reads the PROCESS locale, so
 * without a re-probe the previous language's order and separators would stick to a
 * date now written in month names from another language. That is why the shared
 * version is `let` + a function rather than the shell's `const`s — the mutable form
 * is a strict superset, and collapsing to it costs the other two bundles nothing.
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
