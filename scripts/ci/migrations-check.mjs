#!/usr/bin/env node
// Migrations mutate a user's config, once, on a machine nobody can inspect
// afterwards. There is no undo and no second chance, so the properties that
// make one safe are worth asserting rather than remembering:
//
//   1. every unit is valid bash (a syntax error stops the CHAIN, not just itself);
//   2. the runner is a NO-OP on a fresh install — a machine with no config to
//      migrate must come out with the same empty state it went in with;
//   3. every unit is IDEMPOTENT — running it twice must equal running it once,
//      because a marker that fails to be written is a retry, not a corruption;
//   4. the marker actually stops the second run.
//
// ⚠️ Property 3 is checked by DELETING the marker between runs, not by trusting
// it. The marker is what makes a migration run once in production; the unit
// being idempotent underneath is what makes a lost marker survivable, and only
// one of those two is a property of the code.
//
// This carries its own positive control at the end: a deliberately non-idempotent
// unit must be caught, or the checks above prove nothing.

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("../..", import.meta.url).pathname
const UNITS_DIR = join(ROOT, "migrations")
const RUNNER = join(ROOT, "bin", "nidara-migrate")

let failures = 0
const ok = (n) => console.log(`  ok    ${n}`)
const fail = (n, d) => { failures++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ""}`) }

if (!existsSync(UNITS_DIR)) { console.log("migrations-check: no migrations/ directory — nothing to check."); process.exit(0) }
for (const bin of ["jq", "bash"]) {
    if (spawnSync("sh", ["-c", `command -v ${bin}`]).status !== 0) {
        console.error(`migrations-check: ${bin} is missing`); process.exit(1)
    }
}

const units = readdirSync(UNITS_DIR).filter(f => f.endsWith(".sh")).sort()
console.log(`migrations-check: ${units.length} unit(s)`)

// ── 1. syntax ────────────────────────────────────────────────────────────────
for (const u of units) {
    const r = spawnSync("bash", ["-n", join(UNITS_DIR, u)], { encoding: "utf8" })
    if (r.status !== 0) fail(`${u} is valid bash`, r.stderr.trim())
}
if (failures === 0) ok("every unit is valid bash")

// ── the harness ──────────────────────────────────────────────────────────────
/** Run the runner against a scratch HOME seeded with `files`, `times` times,
 *  clearing the marker between runs when `clearMarkers`. Returns the config dir
 *  contents afterwards. */
function run(files, { times = 1, clearMarkers = false, unitsDir = UNITS_DIR } = {}) {
    const home = mkdtempSync(join(tmpdir(), "nidara-mig-"))
    const cfg = join(home, ".config", "nidara")
    const state = join(home, ".local", "state", "nidara", "migrations")
    mkdirSync(cfg, { recursive: true })
    for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(cfg, name), typeof body === "string" ? body : JSON.stringify(body, null, 2))
    }
    for (let i = 0; i < times; i++) {
        if (clearMarkers && i > 0) rmSync(state, { recursive: true, force: true })
        const r = spawnSync("bash", [RUNNER], {
            encoding: "utf8",
            env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
                   XDG_STATE_HOME: join(home, ".local", "state"), NIDARA_MIGRATIONS_DIR: unitsDir },
        })
        if (r.status !== 0) throw new Error(`runner exited ${r.status}: ${r.stderr}`)
    }
    const out = {}
    for (const f of readdirSync(cfg)) out[f] = readFileSync(join(cfg, f), "utf8")
    const markers = existsSync(state) ? readdirSync(state).sort() : []
    rmSync(home, { recursive: true, force: true })
    return { out, markers }
}

// ── 2. a fresh install comes out untouched ───────────────────────────────────
try {
    const { out, markers } = run({})
    if (Object.keys(out).length !== 0) fail("a fresh install is left alone", JSON.stringify(out))
    else if (markers.length !== units.length) fail("a fresh install still marks every unit as taken", JSON.stringify(markers))
    else ok("a fresh install is left alone, and every unit is marked")
} catch (e) { fail("a fresh install is left alone", e.message) }

// ── 3. idempotence, with the marker DELETED between runs ─────────────────────
// The fixture carries every legacy key any unit knows about, so each one has
// something to bite on. Add to it when you add a migration.
const LEGACY_FIXTURE = {
    "appearance.json": { transparency: 0.15, accent: "blue", iconTheme: "Papirus" },
}
try {
    const once = run(LEGACY_FIXTURE, { times: 1 })
    const twice = run(LEGACY_FIXTURE, { times: 2, clearMarkers: true })
    if (JSON.stringify(once.out) !== JSON.stringify(twice.out)) {
        fail("running twice equals running once (marker cleared between)",
             `1×: ${JSON.stringify(once.out)}\n        2×: ${JSON.stringify(twice.out)}`)
    } else ok("running twice equals running once, even with the marker cleared")
} catch (e) { fail("idempotence", e.message) }

// ── 4. the marker stops the second run ───────────────────────────────────────
try {
    const kept = run(LEGACY_FIXTURE, { times: 2, clearMarkers: false })
    const single = run(LEGACY_FIXTURE, { times: 1 })
    if (JSON.stringify(kept.out) !== JSON.stringify(single.out)) fail("the marker stops the second run", JSON.stringify(kept.out))
    else ok("the marker stops the second run")
} catch (e) { fail("the marker stops the second run", e.message) }

// ── 5. POSITIVE CONTROL ──────────────────────────────────────────────────────
// A unit that appends on every run. Check 3 MUST catch it; if it does not, the
// three greens above mean nothing.
const controlDir = mkdtempSync(join(tmpdir(), "nidara-mig-ctl-"))
writeFileSync(join(controlDir, "9999-01-01-not-idempotent.sh"),
    `json_edit "$CONFIG_DIR/appearance.json" '.accent = (.accent + "!")'\n`)
try {
    const a = run(LEGACY_FIXTURE, { times: 1, unitsDir: controlDir })
    const b = run(LEGACY_FIXTURE, { times: 2, clearMarkers: true, unitsDir: controlDir })
    if (JSON.stringify(a.out) === JSON.stringify(b.out)) {
        fail("[control] a non-idempotent unit is caught",
             "the harness could not tell one run from two — checks 3 and 4 above prove nothing")
    } else ok("[control] a non-idempotent unit IS caught")
} catch (e) { fail("[control] a non-idempotent unit is caught", e.message) }
rmSync(controlDir, { recursive: true, force: true })

if (failures > 0) { console.error(`\nmigrations-check: ${failures} failure(s)`); process.exit(1) }
console.log("migrations-check: every unit is valid, no-ops on a fresh install, and idempotent.")
