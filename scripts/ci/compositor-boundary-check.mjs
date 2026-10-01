#!/usr/bin/env node
/**
 * compositor-boundary-check.mjs — the shell talks to ONE compositor interface (#682).
 *
 * Nidara runs on Hyprland and on Hyalo, the compositor of our own (#680), and the shell
 * reaches either through `core/CompositorState.ts`. A surface that imports HyprlandState
 * or calls `hyprctl` works on one session and does nothing — or fails in a log nobody
 * reads — on the other, and tsc cannot tell: both compile.
 *
 * Outside the compositor modules (COMPOSITOR below), a file under ui/shell or ui/lib may
 * not:
 *   - import a backend or its IPC (HyprlandState, HyaloState, hypr-ipc, hyalo-ipc) or the
 *     Lua generator (hyprland-lua);
 *   - call `hyprlandOnly()` — the door to what only Hyprland has (its options, Lua);
 *   - spawn `hyprctl` (a "hyprctl" string literal in code).
 *
 * Files that still do are listed in `compositor-boundary-allowlist.txt`, and the list may
 * only SHRINK: a violation in an unlisted file fails, and so does a listed file that no
 * longer violates (delete its line). #682 empties it.
 *
 * Usage:  node scripts/ci/compositor-boundary-check.mjs [--print]
 *   --print  every violation, file by file.
 */

import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative, resolve } from "path"

const ROOT = resolve(new URL("../..", import.meta.url).pathname)
const SCAN = ["ui/shell", "ui/lib"]
const COMPOSITOR = new Set([
    "ui/shell/core/CompositorState.ts",
    "ui/shell/core/compositor-types.ts",
    "ui/shell/core/HyprlandState.ts",
    "ui/shell/core/HyaloState.ts",
    "ui/shell/core/hypr-ipc.ts",
    "ui/shell/core/hyalo-ipc.ts",
    "ui/shell/core/hyprland-lua.ts",
    // The monitors facade: Hyalo's outputs say more than the neutral monitor shape.
    "ui/shell/core/Displays.ts",
])
const BACKENDS = /from\s+"[^"]*\/(HyprlandState|HyaloState|hypr-ipc|hyalo-ipc|hyprland-lua)"/g

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "@girs" || name === "build") continue
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p)
    }
    return out
}

/** The source with comments blanked out, so a comment that mentions hyprctl is no use. */
function code(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, pre) => pre + " ".repeat(m.length - pre.length))
}

function violations(file, text) {
    const found = []
    const c = code(text)
    for (const m of c.matchAll(BACKENDS)) found.push(`imports ${m[1]}`)
    if (/\bhyprlandOnly\s*\(/.test(c)) found.push("calls hyprlandOnly()")
    if (/["'`]hyprctl["'`\s]/.test(c)) found.push("spawns hyprctl")
    return found
}

const listPath = join(ROOT, "scripts/ci/compositor-boundary-allowlist.txt")
const listed = new Set(
    readFileSync(listPath, "utf8").split("\n").map(l => l.replace(/#.*/, "").trim()).filter(Boolean),
)
const print = process.argv.includes("--print")

const offenders = new Map()
for (const base of SCAN) {
    for (const abs of walk(join(ROOT, base), [])) {
        const rel = relative(ROOT, abs)
        if (COMPOSITOR.has(rel)) continue
        const v = violations(rel, readFileSync(abs, "utf8"))
        if (v.length) offenders.set(rel, v)
    }
}

let failed = false
for (const [file, v] of [...offenders].sort()) {
    if (print) console.log(`${listed.has(file) ? "listed " : "NEW    "} ${file}: ${[...new Set(v)].join(", ")}`)
    if (!listed.has(file)) {
        console.error(`✗ ${file} reaches past the compositor interface (${[...new Set(v)].join(", ")}).`)
        console.error("  Ask core/CompositorState.ts instead; if the interface lacks it, add it to both backends.")
        failed = true
    }
}
for (const file of [...listed].sort()) {
    if (!offenders.has(file)) {
        console.error(`✗ ${file} is listed in compositor-boundary-allowlist.txt but no longer reaches past the interface — delete its line.`)
        failed = true
    }
}
if (failed) process.exit(1)
console.log(`compositor-boundary-check: ok — ${offenders.size} file(s) still Hyprland-only, all listed (#682)`)
