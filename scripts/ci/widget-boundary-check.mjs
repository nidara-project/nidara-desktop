#!/usr/bin/env node
/**
 * widget-boundary-check.mjs — the zero-layout contract, enforced.
 *
 * Two rules, both of which were comments until 2026-09-01, and both of which fail in
 * a way nothing else catches.
 *
 * 1. A WIDGET IMPORTS NOTHING FROM `surfaces/`.
 *    A widget declares what it is and what it does, not where it is drawn. The bar
 *    and the Control Centre both host the same `AtomicWidget`, so a widget reaching
 *    into either one makes that host the owner of a vocabulary they share. It is not
 *    a compile error and it never will be — there were 28 such imports on the morning
 *    of 2026-09-01 and every one of them type-checked. The vocabulary lives in
 *    `common/widget-kit/`; if the word you need is not there, add it there.
 *
 * 2. `common/widget-kit/` STAYS A LEAF.
 *    No module in it may import from `surfaces/` or `widgets/`. Importing
 *    `CCLayoutManager` from the kit closes the cycle
 *      CCLayoutManager → widgets/index → a widget → widget-kit → CCLayoutManager
 *    and CRASHES THE SHELL AT BOOT (`CC_DEFAULT_ORDER` undefined while
 *    CCLayoutManager's singleton evaluates mid-cycle). `tsc` does not see module
 *    cycles; only a real boot does, which is a long way from the edit that caused it.
 *
 * Usage:  node scripts/ci/widget-boundary-check.mjs
 * CI: runs in the "Widget registry freshness" job, beside the codegen it guards.
 */

import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const SHELL = join(ROOT, "..", "ui", "shell")

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) yield* walk(full)
        else if (/\.(ts|tsx)$/.test(entry)) yield full
    }
}

// Every import specifier in a file, from `import … from "x"`, `export … from "x"`
// and `import("x")`. Deliberately textual: a widget that reaches for a surface does
// it in the import block, and a parser here would be a dependency for one regex.
function importsOf(src) {
    const out = []
    const re = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g
    let m
    while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? m[3])
    return out
}

const RULES = [
    {
        dir: join(SHELL, "widgets"),
        forbidden: [/(^|\/)surfaces\//],
        why: "a widget declares what it IS, not where it is drawn",
        fix: "move the word you need into ui/shell/common/widget-kit/ and import it from there",
    },
    {
        dir: join(SHELL, "common", "widget-kit"),
        forbidden: [/(^|\/)surfaces\//, /(^|\/)widgets\//],
        why: "common/widget-kit/ must stay a LEAF — this import closes a boot-crashing module cycle",
        fix: "keep the kit dependent on gi://, ui/lib/ and core/ only; the host passes what a widget may know (see ContentBudget)",
    },
]

const errors = []
for (const { dir, forbidden, why, fix } of RULES) {
    for (const file of walk(dir)) {
        const rel = relative(join(ROOT, ".."), file)
        for (const spec of importsOf(readFileSync(file, "utf8"))) {
            if (forbidden.some(re => re.test(spec))) {
                errors.push(`${rel}\n      imports "${spec}"\n      ↳ ${why}\n      ↳ fix: ${fix}`)
            }
        }
    }
}

if (errors.length > 0) {
    console.error("widget-boundary-check: the widget boundary is BROKEN\n")
    for (const e of errors) console.error("  ✗ " + e + "\n")
    console.error(`${errors.length} forbidden import${errors.length === 1 ? "" : "s"}. See .claude/skills/nidara/references/writing-a-widget.md`)
    process.exit(1)
}

console.log("widget-boundary-check: widgets/ imports no surface, and the kit is a leaf.")
