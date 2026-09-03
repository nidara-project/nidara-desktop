#!/usr/bin/env node
/*
 * row-height-check — `ROW_HEIGHT` in ui/lib/tokens.ts must equal what
 * `.nidara-row--single` / `--double` are painted at in ui/lib/styles/_components.scss.
 *
 * Two copies of one number, in two languages, neither of which can read the other: the
 * rows get their height from CSS, and the code that has to reason about them — a list
 * asking for six WHOLE rows, a window whose natural height follows from that — cannot
 * ask CSS anything. Same shape as `blur-threshold-check`, same reason it exists: the
 * drift is silent. A row that grew to 76px would leave the installer's list showing
 * 5.7 rows and nothing would say so.
 *
 *   node scripts/ci/row-height-check.mjs      # exit 1 on a mismatch
 */
import { readFileSync } from "node:fs"

const SHEET = "ui/lib/styles/_components.scss"
const TOKENS = "ui/lib/tokens.ts"

const sheet = readFileSync(SHEET, "utf8")
const tokens = readFileSync(TOKENS, "utf8")

const fromSheet = name => {
    const m = new RegExp(`\\.nidara-row--${name}\\s*\\{[^}]*min-height:\\s*(\\d+)px`).exec(sheet)
    return m ? Number(m[1]) : null
}

const block = /export const ROW_HEIGHT = \{([\s\S]*?)\} as const/.exec(tokens)
const fromTokens = name => {
    if (!block) return null
    const m = new RegExp(`\\b${name}:\\s*(\\d+)`).exec(block[1])
    return m ? Number(m[1]) : null
}

const problems = []
if (!block) problems.push(`${TOKENS}: no ROW_HEIGHT block — the mirror is gone, not just stale`)

for (const name of ["single", "double"]) {
    const css = fromSheet(name)
    const ts = fromTokens(name)
    if (css === null) problems.push(`${SHEET}: no min-height for .nidara-row--${name}`)
    else if (ts === null) problems.push(`${TOKENS}: ROW_HEIGHT has no \`${name}\``)
    else if (css !== ts) problems.push(`.nidara-row--${name}: ${SHEET} says ${css}px, ${TOKENS} says ${ts}`)
}

if (problems.length) {
    console.error("Row heights have drifted between the stylesheet and the tokens.\n")
    for (const p of problems) console.error(`  ${p}`)
    console.error("\nChange both, or neither.")
    process.exit(1)
}
console.log("row-height-check: tokens and stylesheet agree.")
