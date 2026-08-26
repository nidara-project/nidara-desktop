// token-contract-check — every `--nidara-*` a bundle PAINTS WITH must be defined
// somewhere that bundle actually compiles or loads.
//
// WHY THIS EXISTS (2026-08-26). `ui/lib/nidara-kit/` has been importable from any
// bundle for a long time and its stylesheet (`ui/lib/styles/_components.scss`) has
// shipped with it since 2026-08-10 — so borrowing a kit widget is one import and
// looks free. It is not free: the widget's rules reference `--nidara-*` tokens, and
// a token is only a token in a process where something DEFINED it.
//
// The installer borrowed `NidaraCircleButton` and its sheet never defined
// `--nidara-surface-strong`, which is the button's hover fill. GTK4 does not warn
// about an undefined custom property — the declaration simply does not apply — so
// the control shipped with a hover that did nothing, and the only way anyone found
// out was a screenshot.
//
// Two ways a bundle can satisfy the contract, and this check accepts either:
//   1. the token is declared in its own SCSS (or in a mixin it @includes), or
//   2. the bundle calls `installAppearance()` (ui/lib/appearance-css.ts), which
//      loads the token ENGINE's output at runtime — the whole colour ramp, from
//      the user's real accent and opacity.
//
// A bundle that does neither is not "missing a nice-to-have": it is painting with
// a value that does not exist.
import { readFileSync, existsSync } from "node:fs"

const KIT_SHEET = "ui/lib/styles/_components.scss"
const MIXINS = "ui/lib/styles/_tokens.scss"
const ENGINE = "ui/lib/theme-tokens.ts"

/** The bundles that compile a sheet of their own. The shell is deliberately absent:
 *  it OWNS the engine and its `styles/_base.scss` is where the static half lives. */
const BUNDLES = [
    { name: "installer", sheet: "ui/installer/style.scss", code: "ui/installer" },
    // The greeter's sheet is compiled by the lockscreen too — one file, two bundles.
    { name: "greeter+lock", sheet: "ui/greeter/style.scss", code: "ui/greeter" },
]

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "")

/** `var(--nidara-x)` → the set of names referenced. */
const referenced = (css) =>
    new Set([...css.matchAll(/var\((--nidara-[a-z0-9-]+)/g)].map((m) => m[1]))

/** `--nidara-x: …` → the set of names DEFINED (in SCSS or in the engine's template). */
const defined = (src) =>
    new Set([...src.matchAll(/(--nidara-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

const kitSheet = read(KIT_SHEET)
const engineTokens = defined(read(ENGINE))
const mixinTokens = defined(read(MIXINS))

if (engineTokens.size === 0) {
    console.error(`token-contract-check: no tokens found in ${ENGINE} — did the engine move again?`)
    process.exit(1)
}

let failed = false

for (const b of BUNDLES) {
    const sheet = read(b.sheet)
    if (!sheet) {
        console.error(`token-contract-check: ${b.sheet} not found`)
        failed = true
        continue
    }

    // What this bundle paints with: its own rules, plus the kit's if it compiles them.
    const usesKit = /@use\s+['"][^'"]*styles\/components['"]/.test(sheet)
    const used = referenced(sheet + (usesKit ? kitSheet : ""))

    // What it can satisfy them with.
    const own = defined(sheet)
    const runtime = new RegExp("installAppearance\\s*\\(").test(
        // one grep over the bundle's entry point is enough: it is called once, in app.ts
        read(`${b.code}/app.ts`),
    )
    const available = new Set([
        ...own,
        ...mixinTokens,          // `@include radius-vars` and friends
        ...(runtime ? engineTokens : []),
    ])

    const missing = [...used].filter((t) => !available.has(t)).sort()
    const via = runtime ? "runtime engine + own sheet" : "own sheet only"
    if (missing.length === 0) {
        console.log(`  ok    ${b.name.padEnd(12)} ${used.size} tokens, all defined (${via})`)
    } else {
        failed = true
        console.error(`  FAIL  ${b.name.padEnd(12)} paints with tokens nothing defines (${via}):`)
        for (const t of missing) console.error(`          ${t}`)
    }
}

if (failed) {
    console.error("")
    console.error("A `--nidara-*` with no definition is not an error in GTK4: the declaration")
    console.error("using it is silently dropped, so the control renders with no hover, no edge,")
    console.error("or no background and nothing is logged. Either declare the token in the")
    console.error("bundle's own sheet, or call installAppearance() from its app.ts to load the")
    console.error("engine's full ramp (ui/lib/appearance-css.ts).")
    process.exit(1)
}

console.log("token-contract-check: every bundle defines what it paints with.")
