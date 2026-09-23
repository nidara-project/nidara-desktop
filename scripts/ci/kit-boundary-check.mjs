#!/usr/bin/env node
/**
 * kit-boundary-check.mjs — `nidara-kit` imports nothing from outside itself.
 *
 * WHY THIS EXISTS (2026-09-23, tech-debt #108). The kit is becoming a package
 * installed once on the system and loaded by every Nidara application, in this repo
 * or not (the owner chose "platform library" over "build-time dependency"). An app
 * published as its own project will have `nidara-kit` and nothing else of this
 * tree — so a kit module that reaches into `ui/shell/`, `ui/greeter/` or a sibling
 * file of `ui/lib/` works in every bundle here, type-checks, and breaks the first
 * app outside. Nothing else would notice: the four bundles in this repo can always
 * resolve the path.
 *
 * The rule: every module under `ui/lib/nidara-kit/` (TypeScript AND the SCSS in
 * `styles/`) may import
 *   - another module under `ui/lib/nidara-kit/`,
 *   - a GObject-introspection namespace (`gi://…`),
 *   - one of GJS's own built-in modules (`system`, `console`, `gettext`, `cairo`),
 *   - a Sass built-in (`sass:…`).
 * Anything else is a dependency the package does not carry.
 *
 * And every file carries `SPDX-License-Identifier: LGPL-3.0-or-later` on its first
 * line. The kit is LGPL and the repo around it GPL (owner's decision, 2026-09-23),
 * so a file without the line reads as GPL to anyone who finds it alone — and a file
 * MOVED in from the rest of the repo changes licence, which is a decision for its
 * copyright holders, not a side effect of `git mv`.
 *
 * Usage:  node scripts/ci/kit-boundary-check.mjs [kit-dir]
 * CI: the "Widget registry freshness" job, beside the widget boundary, with a
 * control that plants a forbidden import and requires this check to fail.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs"
import { join, dirname, resolve, relative, sep } from "path"

const REPO = resolve(new URL("../..", import.meta.url).pathname)
const KIT = resolve(process.argv[2] ?? join(REPO, "ui/lib/nidara-kit"))
const GJS_BUILTINS = new Set(["system", "console", "gettext", "cairo"])

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) yield* walk(full)
        else if (/\.(ts|tsx|scss)$/.test(entry)) yield full
    }
}

// Deliberately textual, like widget-boundary-check: imports live in the import block.
function importsOf(src, scss) {
    const re = scss
        ? /@(?:use|forward|import)\s+["']([^"']+)["']/g
        : /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g
    const out = []
    let m
    while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? m[3])
    return out
}

const inside = p => p === KIT || p.startsWith(KIT + sep)

const SPDX = "SPDX-License-Identifier: LGPL-3.0-or-later"
const errors = []
let count = 0
for (const file of walk(KIT)) {
    const scss = file.endsWith(".scss")
    if (!readFileSync(file, "utf8").split("\n", 1)[0].includes(SPDX))
        errors.push(`${relative(REPO, file)}: first line is not \`// ${SPDX}\` — the kit is LGPL, the repo around it GPL`)
    // Strip comments first: the kit's headers quote import lines as examples.
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
    for (const spec of importsOf(src, scss)) {
        count++
        if (spec.startsWith("gi://") || spec.startsWith("sass:") || GJS_BUILTINS.has(spec)) continue
        if (!spec.startsWith(".")) {
            errors.push(`${relative(REPO, file)}: imports "${spec}" — a package the kit does not carry`)
            continue
        }
        const target = resolve(dirname(file), spec)
        if (!inside(target)) {
            errors.push(`${relative(REPO, file)}: imports "${spec}" → ${relative(REPO, target)}, outside the kit`)
        } else if (!scss && ![target, target + ".ts", target + ".tsx", join(target, "index.ts")].some(existsSync)) {
            errors.push(`${relative(REPO, file)}: imports "${spec}", which does not exist`)
        }
    }
}

if (count === 0) {
    console.error(`kit-boundary-check: read no imports under ${relative(REPO, KIT)} — the walk is broken`)
    process.exit(1)
}
if (errors.length) {
    console.error("kit-boundary-check: nidara-kit reaches outside itself, or a file lost its licence line\n")
    for (const e of errors) console.error("  " + e)
    console.error("\n  ↳ the kit is a package (tech-debt #108): what it needs moves INTO ui/lib/nidara-kit/,")
    console.error("    or the caller passes it in. An app outside this repo has the kit and nothing else.")
    process.exit(1)
}
console.log(`kit-boundary-check: ok — ${count} imports, all inside nidara-kit or the runtime; every file LGPL-headed`)
