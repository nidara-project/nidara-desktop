#!/usr/bin/env node
/**
 * cairo-dispose-check.mjs — every Cairo context the UI draws with is released when the
 * drawing is done (#100).
 *
 * A GJS `cairo.Context` lives until its JS wrapper is garbage-collected, and the JS
 * collector does not feel native memory. A draw function that runs every frame (the dock's
 * magnification) therefore piles dead contexts — and the icon surfaces they reference — into
 * the native heap: 140 → 874 MB in three 30-second passes over the dock, measured live on
 * 2026-09-15. Nothing about it is a compile error or a visible glitch.
 *
 * Two rules, over ui/ (every bundle):
 *   1. `set_draw_func(` takes `cairoDraw(…)` from ui/lib/nidara-kit/platform/cairo-draw.ts, which disposes the
 *      context in a `finally`.
 *   2. A function that calls `snapshot.append_cairo(` also calls `.$dispose()` — a
 *      snapshot-appended context has no wrapper to go through, so the call is checked
 *      textually within the enclosing function body.
 *
 * Usage: node scripts/ci/cairo-dispose-check.mjs
 */
import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const UI = join(ROOT, "ui")

function* walk(dir) {
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "@girs") continue
        const full = join(dir, e)
        if (statSync(full).isDirectory()) yield* walk(full)
        else if (/\.(ts|tsx)$/.test(e)) yield full
    }
}

const errors = []
let drawFuncs = 0, appends = 0
for (const file of walk(UI)) {
    const src = readFileSync(file, "utf8")
    const rel = relative(ROOT, file)
    const lines = src.split("\n")
    lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        if (/set_draw_func\(/.test(line)) {
            drawFuncs++
            if (!/set_draw_func\(\s*cairoDraw\(/.test(line))
                errors.push(`${rel}:${i + 1}  set_draw_func without cairoDraw(…)\n      ↳ wrap the callback: set_draw_func(cairoDraw((area, cr, w, h) => { … })) — ui/lib/nidara-kit/platform/cairo-draw.ts`)
        }
        if (/\.append_cairo\(/.test(line)) {
            appends++
            // The rest of the enclosing block: scan forward until braces opened before this
            // line close. Cheap and sufficient for how these methods are written.
            let depth = 0, found = false
            for (let j = i; j < lines.length; j++) {
                for (const ch of lines[j]) { if (ch === "{") depth++; else if (ch === "}") depth-- }
                if (j > i && /\.\$dispose\(\)/.test(lines[j])) { found = true; break }
                if (depth < 0) break
            }
            if (!found)
                errors.push(`${rel}:${i + 1}  append_cairo without a later .$dispose() in the same block\n      ↳ call cr.$dispose() once the drawing is done — ui/lib/nidara-kit/platform/cairo-draw.ts explains why`)
        }
    })
}

if (errors.length) {
    console.error(`cairo-dispose-check: ${errors.length} problem(s)\n`)
    for (const e of errors) console.error(`  ${e}\n`)
    process.exit(1)
}
console.log(`cairo-dispose-check: ok — ${drawFuncs} draw functions through cairoDraw, ${appends} append_cairo disposed (#100)`)
