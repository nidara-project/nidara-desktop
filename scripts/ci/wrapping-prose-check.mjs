#!/usr/bin/env node
/*
 * wrapping-prose-check — a wrapping GtkLabel must FILL its column.
 *
 * The rule is in design-system.md ("Wrapping prose FILLS its column — never
 * `halign: START`"), and it is not a style preference: a `halign: START` label is
 * allocated its NATURAL width, and a wrapping GtkLabel's natural width is Pango's
 * line-balancing heuristic. So the prose breaks at a column of its own choosing
 * instead of at the card's edge, and sits visibly narrower than everything above it.
 *
 * It was documented and then violated six times anyway (2026-08-16: four hand-rolled
 * footnotes in Settings plus two form status labels), because nothing was checking
 * and the failure is invisible until a string happens to be long enough to wrap —
 * which depends on the locale and the text-size setting, i.e. on someone else's
 * machine. That is exactly the shape of bug a grep can hold down and eyes cannot.
 *
 *   node scripts/ci/wrapping-prose-check.mjs      # exit 1 on a violation
 *
 * Escape hatch: put `// wrapping-prose-ok:` plus the reason on the label's `wrap:`
 * line. There is no such case yet; if you add the first, say why there.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOTS = ["ui/shell", "ui/lib", "ui/greeter", "ui/lockscreen"]
const SKIP = new Set(["node_modules", "@girs", "build", "dist"])

function* sources(dir) {
    for (const name of readdirSync(dir)) {
        if (SKIP.has(name)) continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) yield* sources(path)
        else if (/\.tsx?$/.test(name)) yield path
    }
}

const violations = []

for (const file of ROOTS.flatMap(root => [...sources(root)])) {
    const src = readFileSync(file, "utf8")
    // Each `new Gtk.Label({ … })` literal. Non-greedy to the first `})`, which is
    // enough because these property bags do not nest.
    for (const m of src.matchAll(/new Gtk\.Label\(\{(.*?)\}\)/gs)) {
        const body = m[1]
        if (!/\bwrap:\s*true/.test(body)) continue
        if (!/Gtk\.Align\.START/.test(body)) continue
        if (/xalign/.test(body)) continue            // already fills and left-aligns
        if (/wrapping-prose-ok:/.test(body)) continue
        const line = src.slice(0, m.index).split("\n").length
        violations.push(`${file}:${line}`)
    }
}

if (violations.length) {
    console.error("A wrapping Gtk.Label must FILL its column, not halign: START.\n")
    for (const v of violations) console.error(`  ${v}`)
    console.error(
        "\nBuild it `halign: Gtk.Align.FILL, hexpand: true, xalign: 0, wrap: true`.\n" +
        "If the label is a note UNDER a settings card, do not build it at all — pass the\n" +
        "text as NidaraList's `footer` (listGroup(title, footer)), which already has this\n" +
        "shape and the right class. See design-system.md.")
    process.exit(1)
}

console.log("wrapping-prose-check: every wrapping label fills its column.")
