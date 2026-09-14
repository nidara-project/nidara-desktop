#!/usr/bin/env node
/**
 * settings-closure-check.mjs — what building the Settings window drags in, ratcheted.
 *
 * Settings is becoming its own application (#571). A second process that imports a
 * module also RUNS that module's top level, and on 2026-09-14 importing
 * `surfaces/settings/Settings.tsx` alone reached 192 of the shell's 216 modules: the
 * bar, the Control Centre, the island, Prism, the notification server, the tray
 * watcher, the Assistant's daemon client. One import did most of that —
 * `custom/bar.ts` took a constant from `Bar.tsx` — and nothing said so, because an
 * import graph type-checks whatever it contains.
 *
 * The rule: walking every import transitively from Settings.tsx must reach NONE of
 * the modules below. A module that still does is listed in
 * `settings-closure-allowlist.txt`, one per line, and that file may only SHRINK:
 *   - a forbidden module reached and not listed → fail (a new leak);
 *   - a listed module no longer reached       → fail (delete the line — the ratchet
 *     only holds if the list is exactly today's debt).
 *
 * FORBIDDEN, and why each group is:
 *   - `surfaces/` outside `settings/` — another surface's windows and widgets. The
 *     two plain settings stores that happen to live beside their surface are exempt
 *     (`bar/barState.ts`, `dock/state.ts`): a store over GSettings is exactly what a
 *     Settings process is supposed to share.
 *   - `widgets/` — a widget's module is its live implementation, services included.
 *   - the modules that make a process THE shell: they claim a D-Bus name, export an
 *     agent, or hold the shell's own state (see SHELL_ONLY).
 *
 * Deliberately textual, like widget-boundary-check.mjs: relative specifiers are
 * resolved by hand (`.ts`, `.tsx`, `/index.ts`); `gi://` and bare names are leaves.
 *
 * Usage:  node scripts/ci/settings-closure-check.mjs [--print]
 *   --print  list what is reached today, with the import chain to each (for editing
 *            the allowlist by hand after a module stops leaking).
 */

import { existsSync, readFileSync } from "fs"
import { dirname, join, relative, resolve } from "path"

const ROOT = resolve(new URL("../..", import.meta.url).pathname)
const SHELL = join(ROOT, "ui", "shell")
const ENTRY = join(SHELL, "surfaces", "settings", "Settings.tsx")
const ALLOWLIST = join(ROOT, "scripts", "ci", "settings-closure-allowlist.txt")

// Modules whose presence makes a process the shell, whatever else it is.
const SHELL_ONLY = new Set([
    "core/Status.ts",          // the shell's overlay state machine
    "core/ShellActions.ts",    // the shell's IPC handler table
    "core/notifd.ts",          // owns org.freedesktop.Notifications
    "core/NotifService.ts",    //   …its facade
    "core/tray.ts",            // owns org.kde.StatusNotifierWatcher
    "core/NetworkAgent.ts",    // NetworkManager's secret agent
    "core/AgentService.ts",    // spawns and talks to the Assistant daemon
    // The side-effect halves split out of stores so they run ONCE, in the shell.
    // Importing one from Settings re-creates the double application they exist to stop.
    "core/GamingSync.ts",          // writes nidara-gaming.lua, pushes it to Hyprland
    "core/NightLightSync.ts",      // owns hyprsunset and the schedule timer
    "core/AppearanceHooks.ts",     // fires the appearance user hooks
    "core/WidgetCatalogSource.ts", // the registry + CC grid behind the catalogue seam
    "common/WifiSecretsAgent.ts",  // NetworkManager's secret prompts
])

const STORE_EXEMPT = new Set(["surfaces/bar/barState.ts", "surfaces/dock/state.ts"])

function forbidden(rel) {
    if (SHELL_ONLY.has(rel)) return true
    if (STORE_EXEMPT.has(rel)) return false
    if (rel.startsWith("surfaces/") && !rel.startsWith("surfaces/settings/")) return true
    return rel.startsWith("widgets/")
}

function importsOf(src) {
    const out = []
    const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g
    let m
    while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? m[3])
    return out
}

function resolveSpec(fromFile, spec) {
    if (!spec.startsWith(".")) return null
    const base = resolve(dirname(fromFile), spec)
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
        if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return c
    }
    return null
}

// BFS so the chain printed for each module is a SHORTEST one — the edge to cut.
const parent = new Map([[ENTRY, null]])
const queue = [ENTRY]
while (queue.length > 0) {
    const file = queue.shift()
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
        const dep = resolveSpec(file, spec)
        if (dep && !parent.has(dep)) { parent.set(dep, file); queue.push(dep) }
    }
}

const shellRel = f => relative(SHELL, f)
const chainTo = f => {
    const chain = []
    for (let c = f; c; c = parent.get(c)) chain.unshift(shellRel(c))
    return chain.join("\n        → ")
}

const reached = new Map()
for (const f of parent.keys()) {
    const rel = shellRel(f)
    if (!rel.startsWith("..") && forbidden(rel)) reached.set(rel, f)
}

if (process.argv.includes("--print")) {
    console.log(`${parent.size} modules reached from ${shellRel(ENTRY)}; ${reached.size} forbidden:\n`)
    for (const [rel, f] of [...reached].sort()) console.log(`  ${rel}\n        ${chainTo(f)}\n`)
    process.exit(0)
}

const listed = new Set(
    readFileSync(ALLOWLIST, "utf8").split("\n").map(l => l.replace(/#.*/, "").trim()).filter(Boolean),
)

const errors = []
for (const [rel, f] of [...reached].sort()) {
    if (!listed.has(rel)) {
        errors.push(`NEW LEAK  ${rel}\n    reached through:\n        ${chainTo(f)}\n    ↳ a Settings process would run this module's top level — cut the edge, or move the value it needs somewhere that is not a surface`)
    }
}
for (const rel of [...listed].sort()) {
    if (!reached.has(rel)) {
        errors.push(`STALE     ${rel}\n    ↳ no longer reached from Settings — delete its line from scripts/ci/settings-closure-allowlist.txt (the list may only shrink)`)
    }
}

if (errors.length > 0) {
    console.error(`settings-closure-check: ${errors.length} problem(s)\n`)
    for (const e of errors) console.error(`  ${e}\n`)
    process.exit(1)
}
console.log(`settings-closure-check: ok — ${parent.size} modules reached, ${reached.size} forbidden and all listed (#571)`)
