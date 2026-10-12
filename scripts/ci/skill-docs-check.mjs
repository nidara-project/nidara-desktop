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
 * ── And one copy of the skill ───────────────────────────────────────────────
 *
 * The same failure one level up. Agents other than Claude Code look for skills in
 * `.agents/skills/`, and until 2026-10-12 that directory held a hand-made copy for
 * one of them — weeks behind, with no Hyalo reference at all, and an AGENTS.md
 * pointing at a directory that did not exist. That agent was working from a skill
 * that described another desktop. So `.agents/skills/nidara` is a SYMLINK to
 * `.claude/skills/nidara`, and this fails if it is anything else; AGENTS.md is
 * the one entry text, and CLAUDE.md must import it rather than say anything itself.
 *
 * ⚠️ A repeated heading is not always a duplicated section (two pages could
 * legitimately both want "### Gotchas"). If that day comes, make the heading say
 * which thing it is about — that is better writing anyway, and it keeps this
 * check able to see the real failure.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
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

// One copy of the skill, one entry text.
const LINK = ".agents/skills/nidara"
const skillProblems = []
if (!existsSync(LINK) || !lstatSync(LINK).isSymbolicLink())
    skillProblems.push(`${LINK} must be a symlink to ${ROOT}/nidara, not a directory of its own (a copy drifts)`)
else if (realpathSync(LINK) !== realpathSync(join(ROOT, "nidara")))
    skillProblems.push(`${LINK} points at ${realpathSync(LINK)}, not at ${ROOT}/nidara`)
if (!existsSync("AGENTS.md")) skillProblems.push("AGENTS.md is missing: it is what every agent reads first")
if (!/^@AGENTS\.md\s*$/m.test(readFileSync("CLAUDE.md", "utf8")))
    skillProblems.push("CLAUDE.md must import AGENTS.md (`@AGENTS.md` on a line of its own), so Claude Code reads the same text")
if (skillProblems.length) {
    for (const p of skillProblems) console.error(`\n${p}`)
    process.exit(1)
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

console.log("skill-docs-check: no repeated headings; one copy of the skill, and AGENTS.md is every agent's entry.")
