#!/usr/bin/env node
/*
 * hook-events-check — the user-hook event table is the only list, and it is complete.
 *
 *   node scripts/ci/hook-events-check.mjs
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `~/.config/nidara/hooks/<event>.d/` is a promise to people outside this repo:
 * name an event, drop in a script, and the desktop runs it. The promise has two
 * ways to break, and neither is a compile error:
 *
 *   - the shell fires an event that `bin/nidara-hook` does not declare. The
 *     runner rejects the name, so the event silently never happens — and the
 *     `.d` directory for it is never even created, so there is nothing for the
 *     user to notice missing.
 *   - the runner declares an event nothing fires. The user gets a directory,
 *     documentation and an empty promise: their script is correct and will
 *     never run.
 *
 * So: the event table in `bin/nidara-hook` and the set of call sites must be the
 * same set, in both directions. The table is also the ONLY list — `nidara-setup`
 * asks the runner for it, and the skill points at `nidara-hook --list` rather
 * than restating it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const RUNNER = "bin/nidara-hook"

let failed = false
const log = (m) => console.log(m)
const pass = (m) => console.log(`  ✓ ${m}`)
const error = (m) => { console.error(`  ✗ ${m}`); failed = true }

// ── 1. The declared table ────────────────────────────────────────────────────
const runner = readFileSync(RUNNER, "utf8")
const tableMatch = runner.match(/EVENTS=\$\(cat <<'TABLE'\n([\s\S]*?)\nTABLE\n\)/)
if (!tableMatch) {
    console.error(`hook-events-check: could not find the EVENTS table in ${RUNNER}.`)
    process.exit(1)
}

const declared = new Map()
for (const line of tableMatch[1].split("\n")) {
    if (!line.trim()) continue
    const fields = line.split(" :: ")
    if (fields.length !== 3) {
        error(`${RUNNER}: malformed table row (want "name :: args :: description"): ${line}`)
        continue
    }
    const [name, args, desc] = fields
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        error(`${RUNNER}: "${name}" is not a usable event name — it becomes a directory name.`)
        continue
    }
    if (!args.trim() || !desc.trim()) error(`${RUNNER}: "${name}" declares an empty arguments or description field.`)
    if (declared.has(name)) error(`${RUNNER}: "${name}" is declared twice.`)
    declared.set(name, { args, desc })
}
log(`Declared events (${declared.size}): ${[...declared.keys()].join(", ")}`)

// ── 2. The call sites ────────────────────────────────────────────────────────
// Two shapes, because two languages fire events: `fireHook("x", …)` from the
// shell, and `nidara-hook x …` from the bash helpers.
function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "build" || entry.startsWith(".")) continue
        const path = join(dir, entry)
        const st = statSync(path)
        if (st.isDirectory()) walk(path, out)
        else if (st.isFile()) out.push(path)
    }
    return out
}

const sources = [
    ...walk("ui/shell").filter(f => f.endsWith(".ts") || f.endsWith(".tsx")),
    ...walk("bin").filter(f => !f.endsWith(".c")),
]

const fired = new Map() // event -> [files]
const record = (event, file) => {
    if (!fired.has(event)) fired.set(event, [])
    if (!fired.get(event).includes(file)) fired.get(event).push(file)
}

for (const file of sources) {
    const src = readFileSync(file, "utf8")
    for (const m of src.matchAll(/fireHook\(\s*"([^"]+)"/g)) record(m[1], file)
    // The runner itself only ever talks about events in prose.
    if (file === RUNNER || !file.startsWith("bin/")) continue
    // Anchored to a command position: unanchored, the word "nidara-hook" inside a
    // comment made the next English word look like an event ("nidara-hook simply
    // is not there yet" → the event `simply`).
    for (const m of src.matchAll(/^[ \t]*nidara-hook\s+([a-z][a-z0-9-]*)/gm)) record(m[1], file)
}

// ── 3. The two directions ────────────────────────────────────────────────────
log("\nEvery fired event is declared:")
for (const [event, files] of fired) {
    if (declared.has(event)) pass(`${event} — fired from ${files.join(", ")}`)
    else error(`"${event}" is fired from ${files.join(", ")} but ${RUNNER} does not declare it: the runner will refuse the name and the event will silently never reach anyone's hooks.`)
}

log("\nEvery declared event is fired:")
for (const event of declared.keys()) {
    if (fired.has(event)) pass(`${event}`)
    else error(`"${event}" is declared in ${RUNNER} but nothing fires it — users would get a documented directory that can never run.`)
}

if (failed) {
    log("\nhook-events-check: FAILED")
    process.exit(1)
} else {
    log("\nhook-events-check: ALL CHECKS PASSED")
}
