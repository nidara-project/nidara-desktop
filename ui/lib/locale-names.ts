// How Nidara NAMES a place, a language, a keyboard and a timezone.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Three surfaces were answering the same question three ways, and each answer
// was locally reasonable:
//
//   greeter (LocaleBar.ts)   12 endonyms by hand; keyboards as CODES — US, ES, LATAM
//   Settings (region.ts)     `localectl list-locales` raw — es_ES.UTF-8
//   installer                328 endonyms via ICU; keyboards as xkb's ENGLISH text
//
// The installer's region page is what made it visible: it showed "Spanish" to
// somebody using the installer in Spanish, and its country list could not find
// "España" because tzdata's iso3166.tab is English-only. Both are naming bugs,
// not list bugs, and a fourth private answer would have been the wrong fix.
//
// So the vocabulary lives here, next to the kit, and the surfaces read it. This
// file decides HOW a thing is named; it never decides WHICH things exist — that
// is each surface's own data (see ui/installer/lib/region.ts for the four system
// tables the installer enumerates).
//
// ⚠️ NOTHING HERE IS A HAND-WRITTEN TABLE, on purpose. ICU ships in GJS, so every
// name below is derived. A table of country names in twelve languages is a table
// that goes stale in twelve languages.

/**
 * A country in the reader's language — "España" in a Spanish UI, "Spain" in an
 * English one.
 *
 * `display` is the UI locale to name it IN, and it has to be passed rather than
 * read from the environment: the installer changes its own language at runtime
 * without touching LANG, so a function that consulted the process locale would
 * keep saying "Spain" after the user switched to Spanish.
 *
 * Falls back to `fallback` (tzdata's English name) for a code ICU does not know,
 * and never to the bare code — "AQ" is not a name.
 */
export function countryName(code: string, display: string, fallback: string): string {
    try {
        const name = new Intl.DisplayNames([display], { type: "region" }).of(code.toUpperCase())
        if (name && name !== code.toUpperCase()) return name
    } catch {}
    return fallback
}

/**
 * A language in ITS OWN language — "español de España", "português (Brasil)",
 * "日本語 (日本)".
 *
 * Deliberately an endonym and NOT translated into the current UI, which is the
 * rule the greeter already states in `LocaleBar.ts`: everyone must be able to
 * find their own language regardless of what the screen currently speaks. A
 * Greek speaker looking at an English installer needs to see "Ελληνικά".
 *
 * Takes a locale (`es_ES.UTF-8`) or a BCP-47 tag (`es-ES`); both reach the same
 * place. Returns the input unchanged when ICU has no name for it — `hrx_BR`
 * (Hunsrik) is real and unnamed, and showing the code is honest where inventing
 * a name is not.
 */
export function languageName(localeOrTag: string): string {
    const tag = localeOrTag.split(".")[0].replace(/_/g, "-")
    try {
        const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag)
        if (name && name !== tag) return name
    } catch {}
    return localeOrTag
}

/**
 * A keyboard layout, named by the language it serves — "español de España",
 * "español latinoamericano", "British English".
 *
 * `langs` are the BCP-47 tags systemd's kbd-model-map lists for the layout; the
 * first is the one it is named after. `fallback` is xkb's own description, used
 * for the layouts kbd-model-map leaves without a tag.
 *
 * ⚠️ It would be tempting to translate xkb's description instead, and it very
 * nearly works: `GLib.dgettext("xkeyboard-config", "Spanish")` really does return
 * "Español", because xkeyboard-config ships the catalogue. **Measured 2026-09-03:
 * gettext caches the catalogue at first use and ignores a later change to
 * LANGUAGE**, so a process that starts in en_US — which is every process on the
 * live medium, since the ISO generates no other locale — would keep answering in
 * English however the UI language changed. The endonym needs no catalogue, no
 * process locale and no cache, and it is the rule the greeter already follows.
 */
export function keyboardName(langs: string[], fallback: string): string {
    for (const tag of langs) {
        const name = languageName(tag)
        if (name !== tag) return name
    }
    return fallback
}

/**
 * A timezone, exactly as tzdata spells it: `Europe/Madrid`.
 *
 * This function exists to hold a DECISION rather than a transformation. The
 * installer used to render "Madrid — Europe", which reads oddly and, worse, is a
 * fourth format in a desktop that already had one: Settings lists what
 * `timedatectl list-timezones` prints, unchanged. An IANA name is an identifier
 * people recognise and can be searched for; splitting it invents a convention
 * that only one screen speaks.
 *
 * ⚠️ There is no ICU display type for timezones — `Intl.DisplayNames` has no
 * "timeZone" — and `Intl.DateTimeFormat`'s `timeZoneName` gives the OFFSET's name
 * ("hora de verano de Europa central"), not the place. So this is not a
 * translation we are declining to do; there is nothing to translate.
 */
export function timezoneName(tz: string): string {
    return tz
}

/**
 * The strings a search box should match a country against: the reader's name,
 * the English one, and the code. Lowercased, deduplicated.
 *
 * Matching only what is DISPLAYED is the bug this exists to prevent — a Spanish
 * list that shows "España" and matches "Spain" is as broken as the English list
 * that showed "Spain" and could not be found by typing "España".
 */
export function countryHaystack(code: string, display: string, fallback: string): string[] {
    const out = new Set<string>()
    out.add(countryName(code, display, fallback).toLowerCase())
    out.add(fallback.toLowerCase())
    out.add(code.toLowerCase())
    return [...out]
}
