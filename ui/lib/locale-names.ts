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
// ⚠️ NO NAME HERE COMES FROM A HAND-WRITTEN TABLE, on purpose. ICU ships in GJS,
// so every name below is derived. A table of country names in twelve languages is
// a table that goes stale in twelve languages. (The one table in the file is
// `FUSED`, nine letters of the Latin alphabet — a fact about writing, not a list
// of names, and it cannot go stale in any language.)

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
 * ⚠️ Letters whose diacritic is FUSED into the glyph, which is why NFD cannot take
 * it off: there is no combining mark to remove. Everything else — á à â ä ã å ç é
 * ï ñ ö ő ř ş ü ž — decomposes, so it needs no entry here.
 *
 * Measured over the country names of the twelve languages the installer speaks
 * (2026-09-03): after NFD the only Latin letters left standing are `æ` and `ø`
 * ("Isole Fær Øer" in Italian) and `ł` ("Bułgaria", "Białoruś" in Polish). The
 * rest of the map is the same class of letter in the same alphabets — a Danish or
 * an Icelandic name would need them and they cost nothing.
 */
const FUSED: Record<string, string> = {
    æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ß: "ss", ı: "i",
}

/**
 * A string reduced to what somebody actually TYPES: lowercase, no accents.
 *
 * "espana" has to find España, because typing without accents is what people do —
 * on a keyboard they have not chosen yet, in an installer where picking the
 * country is how the right keyboard gets set. The same folding has to run on both
 * sides of the comparison, so the query and the haystack meet in one alphabet.
 *
 * NFD splits a letter into its base plus a combining mark and the mark is dropped;
 * `FUSED` covers the letters that carry no separable mark. Nothing outside Latin
 * is touched — Greek, Cyrillic, Han and kana come through unchanged, which is
 * right: there is no unaccented way to type them.
 */
export function searchFold(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[æœøłđðþßı]/g, ch => FUSED[ch])
}

/**
 * The strings a search box should match a country against: the reader's name,
 * the English one, and the code. Folded for search, deduplicated.
 *
 * Matching only what is DISPLAYED is the bug this exists to prevent — a Spanish
 * list that shows "España" and matches "Spain" is as broken as the English list
 * that showed "Spain" and could not be found by typing "España".
 */
export function countryHaystack(code: string, display: string, fallback: string): string[] {
    const out = new Set<string>()
    out.add(searchFold(countryName(code, display, fallback)))
    out.add(searchFold(fallback))
    out.add(searchFold(code))
    return [...out]
}

/**
 * The rows of a "pick your language" list, named the way such a list has to name
 * them: the endonym of the LANGUAGE, with an initial capital, and the territory
 * only where two rows would otherwise read the same.
 *
 * Three decisions live here, and the first is the one that matters:
 *
 * ⚠️ **A language is not a locale, and this list is asked BEFORE the country.**
 * `Intl.DisplayNames` defaults to its "dialect" naming, which gave "American
 * English", "español de España" and "português europeu" — three shapes among
 * twelve rows — and every shape named a TERRITORY that the next page is still
 * free to change: pick "español (España)" and then Argentina, and the locale
 * written is `es_AR`. So the label says the language and nothing else, and the
 * territory appears only for the pair that genuinely needs it, Portuguese.
 * Which pair that is comes from the list itself, not from a table: two tags
 * whose bare names collide both get their region back.
 *
 * ⚠️ **The initial is capitalised, against the orthography of half of them.**
 * "español" and "français" are lowercase in running text and CLDR returns them
 * that way; in a list of names they are entries in an index, and every other
 * chooser the user has met — GNOME's, ours in the greeter — capitalises them.
 * The two surfaces of one product disagreeing about it is worse than either
 * choice.
 *
 * ⚠️ The result is positional: `labels[i]` names `tags[i]`. Sorting is the
 * caller's, because the collation to sort in is the READER's, and only the
 * caller knows which language the screen currently speaks.
 */
export function languageMenuLabels(tags: string[]): string[] {
    const subtag = (tag: string) => tag.split(/[-_]/)[0]
    const bare = tags.map(tag => {
        const name = languageName(subtag(tag))
        return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1)
    })
    const seen = new Map<string, number>()
    for (const name of bare) seen.set(name, (seen.get(name) ?? 0) + 1)

    return tags.map((tag, i) => {
        if ((seen.get(bare[i]) ?? 0) < 2) return bare[i]
        const region = tag.split(/[-_]/)[1]
        if (!region) return bare[i]
        return `${bare[i]} (${countryName(region, tag, region)})`
    })
}

/**
 * The strings a search box should match a language against: its endonym, its
 * name in the reader's language, its English name, and the tag.
 *
 * The twin of {@link countryHaystack}, and it exists for the same reason. The
 * rows say "Deutsch" because everybody has to find their own language whatever
 * the screen currently speaks — but somebody reading a Spanish installer looking
 * for German types "aleman", and somebody who has always installed things in
 * English types "german". A list that answers neither is a list that can only be
 * used by scrolling.
 */
export function languageHaystack(tag: string, display: string): string[] {
    const subtag = tag.split(/[-_]/)[0]
    const out = new Set<string>()
    out.add(searchFold(languageName(subtag)))
    out.add(searchFold(languageName(tag)))
    for (const inLocale of [display, "en"]) {
        try {
            const name = new Intl.DisplayNames([inLocale], { type: "language" }).of(subtag)
            if (name) out.add(searchFold(name))
        } catch {}
    }
    out.add(searchFold(tag))
    out.add(searchFold(subtag))
    return [...out]
}
