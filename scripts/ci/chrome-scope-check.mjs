#!/usr/bin/env node
// chrome-scope-check — every shell-skin surface must be inside the appearance pin,
// and nothing notices when one is not.
//
// Settings → Appearance lets a user pin the shell skin to Dark or Light independently
// of the system mode. That pin is one scoped CSS block, built from
// `CHROME_SCOPE_WINDOWS` in `ui/shell/core/NidaraTheme.ts`, selecting each surface by
// its GTK window name. A surface missing from that list keeps the SYSTEM mode while
// its siblings obey — wrong tokens (text, borders, glass) and uninverted `.nd-icon`s.
//
// 🔑 THIS HAS ALREADY HAPPENED TWICE, and both times for the same reason: a surface
// MOVED OUT of the bar's window and silently left behind everything that was scoped to
// the bar's window. The Activity Island moved on 2026-07-26 and the app grid on
// 2026-08-09; neither was added to the pin, and the bug shipped until 2026-08-24. The
// same move also cost the island its `blur_popups` flag (see config/hypr/hyprland.lua),
// which is the same failure in a different file.
//
// It fails silently in the worst way: only a user who has ACTUALLY pinned the shell
// against their system mode ever sees it, so the default configuration — and every
// screenshot, and the headless smoke — looks perfect.
//
// Two couplings are checked, because the second is the one a reader assumes:
//   1. every layer-shell surface of the shell is in the list, or explicitly exempt;
//   2. each such window's GTK `name:` EQUALS its Wayland namespace — the CSS selector
//      is `window#<name>`, and the namespace is what everything else identifies a
//      surface by. They are equal today by convention, not by construction, so a
//      surface renamed on one side only would be in the list and still miss the pin.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// Surfaces that legitimately need no CSS pin, each with the reason it does not.
const EXEMPT = new Map([
    ["nidara-agent-pointer",
     "paints in Cairo from Theme.chromeIsDark directly and carries no CSS tokens or .nd-icon"],
])

const theme = readFileSync("ui/shell/core/NidaraTheme.ts", "utf8")
const listM = theme.match(/CHROME_SCOPE_WINDOWS\s*=\s*\[([\s\S]*?)\]/)
if (!listM) {
    console.error("chrome-scope-check: could not find CHROME_SCOPE_WINDOWS in ui/shell/core/NidaraTheme.ts")
    process.exit(1)
}
// ⚠️ Strip line comments FIRST. Without this a commented-out `// "nidara-island",`
// still reads as a member and the check passes on precisely the edit it exists to
// catch — which is how its own positive control failed the first time it was run.
const listBody = listM[1].replace(/\/\/[^\n]*/g, "")
const scoped = new Set([...listBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]))

// Walk the shell for layer-shell surfaces. A namespace reaches set_namespace either as
// a literal or through a local `const NAMESPACE = "…"`, so resolve both per file.
const files = []
;(function walk(dir) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { if (e !== "@girs" && e !== "node_modules" && e !== "build") walk(p) }
        else if (/\.tsx?$/.test(p)) files.push(p)
    }
})("ui/shell")

const found = []   // { ns, file, name }
for (const f of files) {
    const src = readFileSync(f, "utf8")
    if (!/set_namespace\s*\(/.test(src)) continue
    const nsConst = src.match(/const\s+NAMESPACE\s*=\s*"([^"]+)"/)?.[1] ?? null
    for (const m of src.matchAll(/set_namespace\s*\(\s*\w+\s*,\s*(?:"([^"]+)"|NAMESPACE)\s*\)/g)) {
        const ns = m[1] ?? nsConst
        if (!ns) continue                    // computed namespace (ManagedWindow): nothing to assert
        // The GTK window names this file sets, for coupling 2. ⚠️ Collect them ALL and
        // ask whether the namespace is among them, rather than taking the first one:
        // "the first `name:` in the file" is only the window's by luck, and an
        // unrelated widget declared earlier would turn this into a false verdict in
        // whichever direction its value happened to point.
        const names = [...src.matchAll(/\bname:\s*"([^"]+)"/g)].map((m) => m[1])
        if (/\bname:\s*NAMESPACE\b/.test(src) && nsConst) names.push(nsConst)
        found.push({ ns, file: f, names })
    }
}

if (!found.length) {
    console.error("chrome-scope-check: found no layer-shell surfaces at all — the scan is broken, not the code.")
    process.exit(1)
}

console.log("chrome-scope-check — shell-skin surfaces vs the appearance pin\n")
console.log(`  CHROME_SCOPE_WINDOWS = ${[...scoped].join(", ")}\n`)

let bad = 0
for (const { ns, file, names } of found.sort((a, b) => a.ns.localeCompare(b.ns))) {
    if (EXEMPT.has(ns)) {
        console.log(`  skip  ${ns.padEnd(22)} — ${EXEMPT.get(ns)}`)
        continue
    }
    if (!scoped.has(ns)) {
        bad++
        console.log(`  FAIL  ${ns.padEnd(22)} NOT in CHROME_SCOPE_WINDOWS   (${file})`)
        continue
    }
    if (!names.includes(ns)) {
        bad++
        console.log(`  FAIL  ${ns.padEnd(22)} no window in this file is named "${ns}" `
                    + `(found: ${names.length ? names.map((n) => `"${n}"`).join(", ") : "none"}), `
                    + `but the CSS selector is window#${ns}   (${file})`)
        continue
    }
    console.log(`  ok    ${ns.padEnd(22)} in the pin, and window#${ns} matches`)
}

// The reverse direction: a name in the list that no surface uses is dead selector
// weight and, worse, reads as coverage that is not there.
for (const w of scoped) {
    if (!found.some((f) => f.ns === w)) {
        bad++
        console.log(`  FAIL  ${w.padEnd(22)} is in CHROME_SCOPE_WINDOWS but no surface declares it`)
    }
}

if (bad) {
    console.error(`\nchrome-scope-check: ${bad} problem(s).`)
    console.error("A shell surface outside the pin keeps the SYSTEM mode while its siblings follow the")
    console.error("user's Appearance setting. Add it to CHROME_SCOPE_WINDOWS in ui/shell/core/NidaraTheme.ts,")
    console.error("or add it to EXEMPT here with the reason it needs no CSS tokens.")
    process.exit(1)
}
console.log("\nchrome-scope-check: every shell-skin surface is inside the appearance pin.")
