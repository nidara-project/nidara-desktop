#!/usr/bin/env node
/*
 * i18n-check — the translation debt must be VISIBLE, and it must not grow in silence.
 *
 * Two releases shipped with the same hole and nobody saw it. v0.6.0 and v0.7.0 both
 * went out with 82 keys missing from ten of the twelve locales — 56 of them the whole
 * Assistant/AI surface — so a German, Japanese or Russian user opened Settings → AI and
 * read English. That is the documented workflow (en + es by hand, the rest bulk-translated
 * at publication), and it is fine as a policy. What was NOT fine is that the number moved
 * from 82 to 84 between two releases and no artifact anywhere recorded that it had.
 *
 * There are two ways a locale rots, and they are not equally visible:
 *
 *   MISSING — the key is absent, `t()` falls back to English. Ugly, honest, obvious.
 *   STALE   — the key is present, so it LOOKS translated, but the English it was
 *             translated from has changed since. It renders a confident sentence that
 *             is no longer what the product does. On 2026-08-16 the English for
 *             `settings.region.locale.lang.desc` became "System-wide, not just your
 *             account…" while German still said "Erfordert einen Sitzungsneustart"
 *             ("requires a session restart") — the account-vs-system distinction, the
 *             entire point of the new copy, silently absent in ten languages.
 *
 * Nothing could detect STALE, because nothing recorded which English a translation was
 * made from. That is what `translation-state.json` is: a ledger, machine-managed, holding
 * (a) a hash of every English string as of the last reconciliation and (b) per locale, the
 * keys that are untranslated and the keys that went stale. It is committed, and CI checks
 * it is FRESH — the same shape as the widget-registry gate.
 *
 * Why freshness rather than a red build on missing keys: the workflow deliberately defers
 * the other ten locales to a bulk pass, so failing CI on every new English string would
 * fight the process instead of serving it. Making the ledger fresh means a PR that adds an
 * untranslated string carries `"untranslated": [… +1]` in its own diff. The debt cannot
 * move without a human seeing the line move. And when the wave finally happens, the ledger
 * IS the to-do list: no re-reading 698 strings to find out what rotted.
 *
 *   node scripts/ci/i18n-check.mjs                  # human report
 *   node scripts/ci/i18n-check.mjs --check          # CI: exit 1 if stale or broken
 *   node scripts/ci/i18n-check.mjs --sync           # after adding/changing English strings
 *   node scripts/ci/i18n-check.mjs --translated de,fr   # after actually translating those
 *
 * `--sync` is bookkeeping and is safe to run at any time: it never claims a translation is
 * current. When an English string changes it marks that key STALE in every locale holding
 * it. Only `--translated <locale>` says "I translated this locale against today's English",
 * and only it clears that locale's stale list. Keep the two apart — a `--sync` that stamped
 * fresh hashes would launder exactly the defect this file exists to catch.
 *
 * ⚠️ For the same reason, do NOT "start clean" by deleting translation-state.json and
 * re-syncing: with no previous basis to compare against, every existing translation is
 * declared current and all outstanding drift disappears silently. The ledger was seeded
 * (2026-08-17) by walking each locale's own git history to find the English in effect the
 * last time each key's translated value changed — which is how the two stale region strings
 * were found. If it ever has to be rebuilt, rebuild it that way, not from today's English.
 *
 * Hard failures (never ratcheted, because these must always be zero):
 *   · a catalog that does not parse, or yields absurdly few keys (a vacuous pass)
 *   · a duplicate key inside one catalog (the second silently wins at runtime)
 *   · an orphan key — present in a locale, gone from en.ts — i.e. dead weight
 *   · a key in en.ts missing from es.ts (those two are hand-synced per the workflow)
 *   · the greeter/lockscreen mini-catalogs missing a language or a key (they are
 *     duplicated per bundle by hand, so parity there is guarded, not assumed)
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, readdirSync } from "node:fs"

const LOCALE_DIR = "ui/shell/core/i18n/locales"
const STATE_PATH = "ui/shell/core/i18n/translation-state.json"
const MINI_CATALOGS = [
    "ui/greeter/lib/i18n.ts",
    "ui/lockscreen/lib/i18n.ts",
    "ui/installer/lib/i18n.ts",
]
const SOURCE = "en"
/* es is hand-maintained alongside en on every new key; the rest are bulk passes. */
const HAND_SYNCED = "es"
/* A catalog below this is a parse that silently ate the file, not a small language. */
const MIN_KEYS = 50

const hash = text => createHash("sha1").update(text).digest("hex").slice(0, 8)
const fatal = []

/* ── parsing ──────────────────────────────────────────────────────────────────
 * The catalogs are flat `Record<string, string>` literals with quoted keys and no
 * escapes, so they are parsed line by line rather than imported (this is Node; they
 * are TypeScript importing gi:// modules). Anything inside the literal that is not a
 * blank line, a comment or a `"key": "value"` pair is a hard error rather than a
 * skipped line — a parser that shrugs at what it does not understand is how a gate
 * passes vacuously.
 */
function parseCatalog(path) {
    const src = readFileSync(path, "utf8")
    const entries = new Map()
    const dupes = []
    for (const [i, raw] of src.split("\n").entries()) {
        const line = raw.trim()
        if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue
        if (line === "export default {" || line === "}" || line === "};") continue
        const m = /^"([^"]+)":\s*"(.*)",?$/.exec(line)
        if (!m) {
            fatal.push(`${path}:${i + 1}: not a "key": "value" pair — ${line.slice(0, 60)}`)
            continue
        }
        if (entries.has(m[1])) dupes.push(m[1])
        entries.set(m[1], m[2])
    }
    for (const key of dupes) fatal.push(`${path}: duplicate key "${key}" — the later one wins at runtime`)
    if (entries.size < MIN_KEYS) fatal.push(`${path}: parsed only ${entries.size} keys (< ${MIN_KEYS}) — the parse ate the file`)
    return entries
}

const locales = {}
for (const file of readdirSync(LOCALE_DIR).filter(f => f.endsWith(".ts")).sort())
    locales[file.slice(0, -3)] = parseCatalog(`${LOCALE_DIR}/${file}`)

if (!locales[SOURCE]) {
    console.error(`No ${SOURCE}.ts in ${LOCALE_DIR} — nothing to compare against.`)
    process.exit(1)
}
const en = locales[SOURCE]
const others = Object.keys(locales).filter(l => l !== SOURCE)

/* ── the mini-catalogs (greeter + lockscreen) ─────────────────────────────────
 * A different shape: one nested object per language. They are duplicated between the
 * two bundles by hand, which is the whole reason parity is checked instead of trusted.
 */
function checkMiniCatalog(path) {
    const src = readFileSync(path, "utf8")
    const langs = new Map()
    for (const m of src.matchAll(/^ {2}"?([A-Za-z-]+)"?:\s*\{([\s\S]*?)^ {2}\},/gm))
        langs.set(m[1], new Set([...m[2].matchAll(/^\s+([A-Za-z0-9_]+):/gm)].map(k => k[1])))

    const ref = langs.get(SOURCE)
    if (!ref || ref.size === 0) {
        fatal.push(`${path}: could not read the "${SOURCE}" block — the catalog shape changed`)
        return
    }
    for (const lang of Object.keys(locales)) {
        const keys = langs.get(lang)
        if (!keys) { fatal.push(`${path}: no "${lang}" block, but the shell ships ${lang}`); continue }
        const missing = [...ref].filter(k => !keys.has(k))
        const extra = [...keys].filter(k => !ref.has(k))
        if (missing.length) fatal.push(`${path}: "${lang}" is missing ${missing.join(", ")}`)
        if (extra.length) fatal.push(`${path}: "${lang}" has keys "${SOURCE}" does not: ${extra.join(", ")}`)
    }
}
MINI_CATALOGS.forEach(checkMiniCatalog)

/* ── hard parity rules ────────────────────────────────────────────────────── */
for (const loc of others) {
    const orphans = [...locales[loc].keys()].filter(k => !en.has(k))
    if (orphans.length)
        fatal.push(`${LOCALE_DIR}/${loc}.ts: ${orphans.length} key(s) no longer in ${SOURCE}.ts: ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? " …" : ""}`)
}
const esMissing = [...en.keys()].filter(k => !locales[HAND_SYNCED]?.has(k))
if (esMissing.length)
    fatal.push(`${LOCALE_DIR}/${HAND_SYNCED}.ts is missing ${esMissing.length} key(s) — ${HAND_SYNCED} is hand-synced with ${SOURCE} on every new key: ${esMissing.slice(0, 5).join(", ")}${esMissing.length > 5 ? " …" : ""}`)

/* ── the ledger ───────────────────────────────────────────────────────────────
 * `englishBasis` is the English each locale's bookkeeping was last reconciled against.
 * A key whose current hash differs from the basis has been rewritten since, so every
 * locale still holding the old translation is now STALE — that is the whole detection,
 * and it is why the basis may only advance through `--sync`, never as a side effect.
 */
const EMPTY = { englishBasis: {}, locales: {} }
let committed
try { committed = JSON.parse(readFileSync(STATE_PATH, "utf8")) } catch { committed = null }
const prev = committed ?? EMPTY

function reconcile(previous, retranslated = new Set()) {
    const basis = { ...(previous.englishBasis ?? {}) }
    const next = { englishBasis: {}, locales: {} }

    const changedEnglish = new Set()
    for (const [key, value] of en) {
        const now = hash(value)
        if (basis[key] && basis[key] !== now) changedEnglish.add(key)
        next.englishBasis[key] = now
    }

    for (const loc of others) {
        const before = previous.locales?.[loc] ?? {}
        const has = locales[loc]
        const untranslated = [...en.keys()].filter(k => !has.has(k))

        let stale
        if (retranslated.has(loc)) {
            /* The locale was just translated against today's English: nothing it holds
             * can be stale, by definition. This is the only way the list gets cleared. */
            stale = []
        } else {
            stale = new Set((before.stale ?? []).filter(k => en.has(k) && has.has(k)))
            /* An English string that moved makes every locale still holding the old
             * wording stale — including one that lists the key as untranslated no more. */
            for (const key of changedEnglish) if (has.has(key)) stale.add(key)
            stale = [...stale]
        }

        next.locales[loc] = {
            translated: has.size,
            of: en.size,
            untranslated: untranslated.sort(),
            stale: stale.sort()
        }
    }
    return next
}

const args = process.argv.slice(2)
const translatedArg = args.find(a => a === "--translated" || a.startsWith("--translated="))
const retranslated = new Set(
    (translatedArg === undefined
        ? ""
        : translatedArg.includes("=")
            ? translatedArg.slice("--translated=".length)
            : args[args.indexOf(translatedArg) + 1] ?? "")
        .split(",").map(s => s.trim()).filter(Boolean)
)
if (translatedArg !== undefined && retranslated.size === 0)
    fatal.push("--translated needs a locale (e.g. --translated de,fr)")
for (const loc of retranslated)
    if (!others.includes(loc)) fatal.push(`--translated ${loc}: no such locale (have: ${others.join(", ")})`)

const fresh = reconcile(prev, retranslated)
const serialized = JSON.stringify(
    {
        "//": "Machine-managed by scripts/ci/i18n-check.mjs — do not hand-edit. Run --sync after changing English strings, --translated <locale> after translating one.",
        ...fresh
    },
    null, 2
) + "\n"

/* ── output ───────────────────────────────────────────────────────────────── */
if (fatal.length) {
    console.error("i18n parity is broken:\n")
    for (const f of fatal) console.error(`  ${f}`)
    console.error("")
    process.exit(1)
}

const write = args.includes("--sync") || retranslated.size > 0
if (write) {
    writeFileSync(STATE_PATH, serialized)
    console.log(`Wrote ${STATE_PATH}${retranslated.size ? ` (cleared stale for: ${[...retranslated].join(", ")})` : ""}.`)
}

if (args.includes("--check")) {
    const current = committed === null ? "" : readFileSync(STATE_PATH, "utf8")
    if (current !== serialized) {
        console.error(
            `${STATE_PATH} is out of date.\n\n` +
            "English strings were added or rewritten without reconciling the translation\n" +
            "ledger, so the debt in the other locales moved with nothing recording it —\n" +
            "which is how 82 missing keys became 84 across two releases unnoticed.\n\n" +
            "  node scripts/ci/i18n-check.mjs --sync\n\n" +
            "then commit the result. The diff is the point: it shows what each locale now\n" +
            "owes. If you actually translated a locale, use --translated <locale> instead.\n"
        )
        process.exit(1)
    }
}

const pad = s => String(s).padStart(4)
console.log(`\n  ${SOURCE}.ts: ${en.size} keys\n`)
console.log("  locale   translated   untranslated   stale")
for (const loc of others) {
    const s = fresh.locales[loc]
    const flag = s.stale.length ? "  ⚠" : ""
    console.log(`  ${loc.padEnd(8)} ${pad(s.translated)}/${s.of}    ${pad(s.untranslated.length)}       ${pad(s.stale.length)}${flag}`)
}

const anyStale = others.filter(l => fresh.locales[l].stale.length)
if (anyStale.length) {
    const keys = [...new Set(anyStale.flatMap(l => fresh.locales[l].stale))].sort()
    console.log(`\n  Stale — translated from English that has since been rewritten:\n`)
    for (const k of keys) {
        const who = anyStale.filter(l => fresh.locales[l].stale.includes(k))
        console.log(`    ${k}\n      now: "${en.get(k)}"\n      in:  ${who.join(", ")}`)
    }
}
console.log("")
