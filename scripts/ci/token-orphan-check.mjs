// token-orphan-check — the OTHER direction of the token contract: a `--nidara-*`
// that is defined, shipped and emitted, and that no rule ever reads.
//
// WHY THIS EXISTS (2026-09-20). `token-contract-check` catches "I paint with a token
// nothing defines". Nothing caught the mirror image, and it lived for months:
// `--nidara-edge`, the rim of light, was declared in `_base.scss`, redeclared twice
// in the greeter's two skins, computed per mode by the engine and emitted into every
// process's stylesheet — while its last reader had been deleted. The whole `material*`
// vocabulary went with it (tech-debt #106).
//
// An orphan is not cosmetic debt. It is a value that DRIFTS from the one on screen:
// somebody retunes it to fix something they can see, nothing changes, and the file now
// documents a decision that is not in force. That is exactly how #600 spent a commit
// turning the light rim to ink and changed no pixel.
//
// ⚠️ What this cannot see, and why the reader scan is wider than the SCSS:
//   - a token read from TypeScript (an inline CSS string, a provider built at runtime),
//   - a token read through the two-argument form `var(--x, fallback)`.
// The second one nearly cost `--nidara-popover-bg` and `--nidara-popover-border` during
// the #106 burial: they look like part of the same dead closure and are not — the kit
// reads them WITH a fallback, which a `var(--x)` grep does not see. Both forms are
// matched here, in `.scss`, `.ts` and `.tsx`.
//
// ⚠️ Comments are stripped before counting READS, deliberately. This repo names tokens
// in prose constantly (that is a feature), and a sentence like "`border: var(--nidara-edge)`"
// inside a comment would have kept the very token this check was written for alive.
// Definitions are NOT stripped the same way — a commented-out declaration is not a
// definition either, so it drops out on its own.
import { readFileSync, readdirSync, statSync } from "node:fs"

const ROOTS = ["ui"]
const SKIP_DIRS = new Set(["node_modules", "build", "@girs", ".git"])
const SRC = /\.(scss|ts|tsx)$/

/** A token may be defined with no reader ON PURPOSE. Each entry needs a reason —
 *  "it might be useful later" is not one, that is what git history is for. */
const ALLOWED = new Map([
    // (empty — add here only with a written reason)
])

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue
        const p = `${dir}/${name}`
        if (statSync(p).isDirectory()) walk(p, out)
        else if (SRC.test(name)) out.push(p)
    }
    return out
}

/** Strip comments so that a token NAMED in prose does not count as a reader.
 *  `//` is only honoured when it does not follow a `:` — that keeps `https://` and
 *  `gi://GLib` intact, which is the only shape in this repo where it matters. */
const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/([^:])\/\/[^\n]*/g, "$1")

/** `--nidara-x: …` → names DEFINED (SCSS declarations and the engine's template
 *  strings, which are declarations too — they are what lands in the stylesheet). */
const defined = (src) => [...src.matchAll(/(--nidara-[a-z0-9-]+)\s*:/g)].map((m) => m[1])

/** `var(--nidara-x)` or `var(--nidara-x, fallback)` → names READ. */
const referenced = (src) => [...src.matchAll(/var\(\s*(--nidara-[a-z0-9-]+)/g)].map((m) => m[1])

const files = ROOTS.flatMap((r) => walk(r))
if (files.length === 0) {
    console.error("token-orphan-check: no sources found — did the tree move?")
    process.exit(1)
}

/** token → the files that declare it (for the error message: an orphan usually has
 *  more than one home, and all of them have to go). */
const homes = new Map()
const readers = new Set()

for (const f of files) {
    const raw = readFileSync(f, "utf8")
    const code = stripComments(raw)
    for (const t of defined(code)) {
        if (!homes.has(t)) homes.set(t, new Set())
        homes.get(t).add(f)
    }
    for (const t of referenced(code)) readers.add(t)
}

if (homes.size === 0) {
    console.error("token-orphan-check: no `--nidara-*` definitions found — the regex or the tree moved")
    process.exit(1)
}

const orphans = [...homes.keys()].filter((t) => !readers.has(t) && !ALLOWED.has(t)).sort()

// A token in the allowlist that HAS grown a reader is not an error, but the entry is
// now a lie — say so, loudly enough to be deleted.
const stale = [...ALLOWED.keys()].filter((t) => readers.has(t) || !homes.has(t)).sort()

if (orphans.length === 0 && stale.length === 0) {
    console.log(
        `token-orphan-check: ${homes.size} tokens defined, every one of them read ` +
            `(${readers.size} distinct names read across ${files.length} files).`,
    )
    process.exit(0)
}

for (const t of orphans) {
    console.error(`  FAIL  ${t} is defined but nothing reads it`)
    for (const f of [...homes.get(t)].sort()) console.error(`          declared in ${f}`)
}
for (const t of stale) {
    console.error(`  FAIL  ${t} is in this check's allowlist and should not be:`)
    console.error(`          ${readers.has(t) ? "it has a reader now" : "it is not defined anywhere any more"}`)
}

console.error("")
console.error("A `--nidara-*` nothing reads still ships: it is computed by the engine, written")
console.error("into every process's stylesheet, and satisfied by token-contract-check. What it")
console.error("stops being is TRUE — the next person to retune it will change no pixel and")
console.error("believe they did. Delete it (and whatever stopped reading it), or, if it is")
console.error("deliberately public, add it to ALLOWED in this file WITH a reason.")
process.exit(1)
