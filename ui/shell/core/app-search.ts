/**
 * How Nidara ranks apps against what someone typed.
 *
 * Pure functions, no GObject, no state — `core/AppService` owns the catalogue and
 * calls in here; `scripts/dev/apps-probe.ts` exercises this file directly.
 *
 * ## Why this exists instead of AstalApps' fuzzy_query
 *
 * AstalApps scored every app with a recursive subsequence matcher over six fields
 * and summed them with multipliers (name ×2, executable ×0.5, keywords ×0.5, and
 * entry/description/categories ×0 — computed and thrown away). Two things it did
 * were measurably wrong, on this machine, 2026-08-17:
 *
 *  - `executable` was the **whole `Exec=` line**, arguments included. Every Chrome
 *    web app runs `…/google-chrome --profile-directory=Default --app-id=…`, whose
 *    letters spell f‑i‑r‑e (pro**f**ile‑d**i**recto**r**y=D**e**fault). Typing
 *    "fire" in the launcher returned exactly five results — Reddit, YouTube,
 *    NotebookLM, Google Gemini, Play Xbox — each scoring −10 on its name and +77
 *    on its command line. We match the executable **basename** and nothing else.
 *  - A one-character query kept the entire catalogue, because the single-char
 *    branch dropped an app only when its score was **exactly 0** and a total miss
 *    scores −30. "f" and "z" both returned 56 of 56 apps.
 *
 * ## The ranking
 *
 * A query is compared against four fields — name, desktop id, executable basename
 * and keywords — and an app's score is the **best** field, not the sum, so an app
 * cannot win on three weak matches over one strong one. Each field lands in one of
 * five tiers, and the tiers never overlap: a substring match can never outrank a
 * prefix match, whatever the lengths. Ties break on the shorter field first (the
 * `-len` nudge is <1 point, so it stays inside its tier) and then alphabetically,
 * which is what makes the order stable enough to key a GTK sort function on.
 *
 * The loosest tier is deliberately NOT "the letters appear in order somewhere" —
 * that is the rule that let "fire" match "Reddit". It is the acronym rule: every
 * character has to land on a word start or immediately after the previous one, so
 * "gwf" finds GTK Widget Factory and "fire" finds nothing it shouldn't.
 *
 * Matching is accent-folded, so "configuracion" finds "Configuración".
 */

/** Tier floors. A whole tier apart so the sub-point length nudge can never cross one. */
const EXACT = 1000
const PREFIX = 900
const WORD_PREFIX = 800
const SUBSTRING = 600
const ACRONYM = 400
/**
 * The rescue tier: the query is the app's name plus words it doesn't have
 * ("GTK Widget Factory" for a .desktop called "Widget Factory"). Scored below
 * everything else because it fires when the query is *wrong*, just recoverably so.
 */
const COVERED = 100

const MARKS = /\p{M}/gu
const ALNUM = /[\p{L}\p{N}]/u
const LOWER_OR_DIGIT = /[\p{Ll}\p{N}]/u
const UPPER = /\p{Lu}/u

/**
 * Lowercase and strip diacritics, one output character per input character.
 *
 * The 1:1 mapping is the point: `wordStarts` indexes into the result and has to
 * agree with the original string, so `"Configuración".normalize("NFD")` (which is
 * one character LONGER) can't be used directly. NFD per character, marks dropped,
 * leaves exactly one base character for every precomposed letter.
 */
export const fold = (s: string): string[] =>
    Array.from(s || "").map(ch => {
        const base = ch.normalize("NFD").replace(MARKS, "")
        return (base || ch).toLowerCase()
    })

/**
 * Which positions begin a word: index 0, any letter/digit after a separator, and
 * camelCase seams. Computed on the ORIGINAL string — the case is the signal, and
 * folding has already thrown it away.
 */
const wordStarts = (raw: string): boolean[] => {
    const chars = Array.from(raw || "")
    return chars.map((ch, i) => {
        if (!ALNUM.test(ch)) return false
        if (i === 0) return true
        const prev = chars[i - 1]
        if (!ALNUM.test(prev)) return true
        return LOWER_OR_DIGIT.test(prev) && UPPER.test(ch)
    })
}

/** Every character of `q` on a word start or adjacent to the previous match. */
const acronymMatch = (q: string[], f: string[], starts: boolean[]): boolean => {
    let at = -1
    for (const needle of q) {
        let found = -1
        for (let i = at + 1; i < f.length; i++) {
            if (f[i] !== needle) continue
            if (i === at + 1 || starts[i]) { found = i; break }
        }
        if (found < 0) return false
        at = found
    }
    return true
}

/**
 * A query this short is only allowed the anchored tiers. One character is a
 * substring of nearly everything — on this machine "a" matched 46 of 56 apps
 * through the middle of a word, which is a filter that doesn't filter.
 */
const LOOSE_TIER_MIN_CHARS = 2

/**
 * Score one field against one query, considering only `tiers`. 0 = no match.
 * `query` must already be folded; the field is folded here because callers hold
 * the display strings.
 */
export const scoreField = (query: string[], field: string, tiers: Set<number>): number => {
    if (!field || !query.length) return 0
    const f = fold(field)
    if (f.length < query.length) return 0

    // <1 point, so it orders WITHIN a tier and never leaves it. Capped so a
    // pathologically long field still can't fall through to the tier below.
    const nudge = Math.min(f.length - query.length, 99) / 100
    const loose = query.length >= LOOSE_TIER_MIN_CHARS

    const fs = f.join("")
    const qs = query.join("")

    if (tiers.has(EXACT) && fs === qs) return EXACT
    if (tiers.has(PREFIX) && fs.startsWith(qs)) return PREFIX - nudge

    const starts = wordStarts(field)
    if (tiers.has(WORD_PREFIX)) {
        for (let i = 1; i < f.length; i++) {
            if (starts[i] && fs.startsWith(qs, i)) return WORD_PREFIX - nudge
        }
    }

    if (loose && tiers.has(SUBSTRING) && fs.includes(qs)) return SUBSTRING - nudge
    if (loose && tiers.has(ACRONYM) && acronymMatch(query, f, starts)) return ACRONYM - nudge
    return 0
}

/** The fields of an app that a query is allowed to match, best-first. */
export interface Searchable {
    name: string
    /** Desktop id without `.desktop` — "org.gnome.Nautilus" finds Files. */
    id: string
    /** Executable BASENAME. Never the `Exec=` line: that is the Chrome-PWA trap. */
    exec: string
    keywords: string[]
}

/**
 * Split a name or id into comparable word tokens: separators, camelCase and
 * letter/digit seams all count as breaks, and the reverse-DNS prefix is dropped.
 * "org.gtk.WidgetFactory4" and "gtk4-widget-factory" both become
 * [gtk, widget, factory, 4], which substring matching can never reconcile.
 *
 * Deliberately the same rule as `sameApp` in bin/nidara-{a11y,act,click,type} —
 * the whole point is that every surface an agent touches agrees on what an app is
 * called. Keep them in step: ASCII-only on purpose, unlike `fold` above, because
 * the shell script half of that agreement cannot do Unicode normalization.
 */
const NAME_NOISE = new Set(["org", "com", "io", "net", "app", "desktop"])
export const nameTokens = (s: string): string[] => (s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t && !NAME_NOISE.has(t))

/**
 * What each field is worth and which tiers it may use.
 *
 * The weights order the FIELDS the way the tiers order the shapes: an app named
 * exactly what you typed must beat an app that merely runs a binary by that name.
 * That is not hypothetical — every Steam library shortcut on this machine has
 * `Exec=steam`, so typing "Steam" tied the real Steam with ~20 games on an exact
 * executable match and the alphabet handed the launcher to Metro 2033 Redux.
 *
 * The tier sets are where a field says what it is:
 *  - `id` refuses SUBSTRING. A desktop id is a token path ("org.gnome.Nautilus")
 *    or a Chrome web app's 32-character random hash — a loose substring of the
 *    latter is pure noise, while its words are still worth matching.
 *  - `exec` and keywords refuse ACRONYM: they are single words already, so the
 *    acronym rule would only manufacture matches.
 */
const NAME_TIERS = new Set([EXACT, PREFIX, WORD_PREFIX, SUBSTRING, ACRONYM])
const ID_TIERS = new Set([EXACT, PREFIX, WORD_PREFIX, ACRONYM])
const EXEC_TIERS = new Set([EXACT, PREFIX, WORD_PREFIX, SUBSTRING])
const KEYWORD_TIERS = new Set([EXACT, PREFIX, WORD_PREFIX, SUBSTRING])

/**
 * The weights are not vibes — they are chosen so that the whole 4×5 table of
 * (field × tier) lands in a defensible order, with no two cells colliding:
 *
 *              EXACT  PREFIX  WORD_PREFIX  SUBSTRING  ACRONYM
 *   name  1.00   1000     900          800        600      400
 *   id    0.85    850     765          680          —      340
 *   exec  0.78    780     702          624        468        —
 *   kw    0.65    650     585          520        390        —
 *
 * Two rows of that table were put there by a live run, not by taste:
 *
 *  - `id` sits below 800/0.9 so an id PREFIX (765) cannot beat a name WORD_PREFIX
 *    (800). Every Chrome web app's desktop id literally begins "chrome-", so at
 *    0.9 the query "chrom" ranked Google Gemini, NotebookLM, Play Xbox, Reddit
 *    and YouTube ABOVE Google Chrome. An id that matches EXACTLY (850) still
 *    outranks a partial name, which is the case that makes ids worth searching.
 *  - `kw` sits so an EXACT keyword outranks a match buried inside a name
 *    (650 > 600) while a PARTIAL one does not (585 < 600). A keyword is a hint
 *    the packager wrote, not what the app is called; at 0.75 the query "term"
 *    put Micro (keyword "terminal") ahead of XTerm.
 */
const NAME_WEIGHT = 1
const ID_WEIGHT = 0.85
const EXEC_WEIGHT = 0.78
const KEYWORD_WEIGHT = 0.65

/** Score an app against a query. 0 = not a match; callers drop those. */
export const scoreApp = (query: string[], app: Searchable): number => {
    if (!query.length) return 0

    let best = scoreField(query, app.name, NAME_TIERS) * NAME_WEIGHT
    best = Math.max(best, scoreField(query, app.id, ID_TIERS) * ID_WEIGHT)
    best = Math.max(best, scoreField(query, app.exec, EXEC_TIERS) * EXEC_WEIGHT)
    for (const kw of app.keywords) {
        best = Math.max(best, scoreField(query, kw, KEYWORD_TIERS) * KEYWORD_WEIGHT)
    }
    if (best > 0) return best

    // Rescue: a query with a word too many. Substring matching only survives a
    // query that is a PIECE of the name; the names people and window titles
    // actually use are the other way round — "GTK Widget Factory" for a .desktop
    // called "Widget Factory", "Firefox browser", "GIMP image editor". On
    // 2026-08-01 that cost a live agent run two steps and a 7 KB dump of all 80
    // apps, because launch_app answers a miss with the whole catalogue.
    const wanted = new Set(nameTokens(query.join("")))
    if (!wanted.size) return 0
    const coveredBy = (s: string) => {
        const t = nameTokens(s)
        return t.length > 0 && t.every(tok => wanted.has(tok))
    }
    if (coveredBy(app.name) || (app.id && coveredBy(app.id))) return COVERED
    return 0
}

/**
 * Rank `apps` against `query`, best first, dropping everything that doesn't match.
 * Equal scores fall back to the app name so the order is total — a GTK sort
 * function keyed on this must not shuffle between two identical queries.
 */
export const rankApps = <T extends Searchable>(query: string, apps: Iterable<T>): T[] => {
    const q = fold(query.trim())
    if (!q.length) return []

    const hits: { app: T, score: number }[] = []
    for (const app of apps) {
        const score = scoreApp(q, app)
        if (score > 0) hits.push({ app, score })
    }
    hits.sort((a, b) =>
        b.score - a.score || a.app.name.localeCompare(b.app.name))
    return hits.map(h => h.app)
}
