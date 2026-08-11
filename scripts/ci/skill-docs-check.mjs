#!/usr/bin/env node
/*
 * skill-docs-check — the in-repo skill must not say the same thing twice.
 *
 *   node scripts/ci/skill-docs-check.mjs
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `design-system.md` spent weeks with **1157 duplicated lines** in it: a whole
 * half of the file, from "## Cairo vs CSS" to the end, present twice. Nobody saw
 * it, because nobody reads a 3500-line reference top to bottom — it is read by
 * search, and a search hit looks the same whichever copy it lands in.
 *
 * That is not a tidiness problem. Edits landed in DIFFERENT COPIES: the login
 * card's entrance rewrite went into the first one, the crisp-text work into the
 * second. So the file simultaneously held the current explanation and a stale one
 * that contradicted it — and an agent reading the stale copy would have been told
 * that a CSS transition drives the entrance (it does not, it snaps on a
 * session-lock surface) and that rounding the font size makes text crisp (it does
 * not, the metric hint does). A reference that disagrees with itself is worse
 * than a short one.
 *
 * The check is deliberately dumb: a repeated heading is the cheapest reliable
 * signature of a duplicated section, it costs nothing to run, and the fix when it
 * fires is always the same — one of the two is stale, find out which.
 *
 * ⚠️ A repeated heading is not always a duplicated section (two pages could
 * legitimately both want "### Gotchas"). If that day comes, make the heading say
 * which thing it is about — that is better writing anyway, and it keeps this
 * check able to see the real failure.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = ".claude/skills"

/** Every markdown file under the skills tree. */
function markdownFiles(dir) {
    const out = []
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry)
        if (statSync(p).isDirectory()) out.push(...markdownFiles(p))
        else if (entry.endsWith(".md")) out.push(p)
    }
    return out
}

let failed = false

for (const file of markdownFiles(ROOT).sort()) {
    const seen = new Map()
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // Fenced code can contain #-comments; headings we care about are ## and deeper.
        if (!/^#{2,6} \S/.test(line)) return
        const key = line.trim()
        if (!seen.has(key)) seen.set(key, [])
        seen.get(key).push(i + 1)
    })

    const dupes = [...seen].filter(([, lines]) => lines.length > 1)
    if (dupes.length === 0) continue

    failed = true
    console.error(`\n${file}`)
    for (const [heading, lines] of dupes)
        console.error(`  lines ${lines.join(", ")} — ${heading}`)
}

if (failed) {
    console.error(
        "\nA heading appears more than once. Almost always this means a section was " +
        "duplicated rather than moved, and the two copies have since drifted.\n" +
        "Find out which one is current, delete the other, and rescue anything that " +
        "only ever existed in the stale one.",
    )
    process.exit(1)
}

console.log("skill-docs-check: no repeated headings.")
