#!/usr/bin/env node
/*
 * settings-geometry — check that the Settings window obeys its geometry law.
 *
 *   (in a running Nidara session)
 *   node scripts/dev/settings-geometry.mjs
 *   node scripts/dev/settings-geometry.mjs --widths 1400,1100,1050,900,802
 *
 * ── What law ─────────────────────────────────────────────────────────────────
 *
 * `WINDOW_LAYOUT` in `ui/lib/tokens.ts` — read from that file at run time, so this
 * script cannot drift from the law it checks. Three invariants:
 *
 *   1. At any window width, all pages render the pane at the SAME width.
 *   2. That width is EXACTLY what the law predicts: `content` in any window with
 *      room for it, the window's own width once it is smaller (the distress
 *      yield), never wider than the window (which would mean a clip).
 *   3. The window cannot be resized below `contentFloor`.
 *
 * ── Why a script and not an eyeball ──────────────────────────────────────────
 *
 * Because the failure is invisible one page at a time. Before the law existed the
 * breakpoint was derived from the active page's natural width, so the sidebar
 * docked on 16 pages and floated on 2 at the same window size — nobody finds that
 * by opening Settings and looking at it, but a sweep prints it in one line. The
 * same sweep is how the numbers in `WINDOW_LAYOUT` were measured (2026-08-11).
 *
 * It drives the real session over IPC (`ags request queryUI` / `settingsPage`) and
 * resizes through Hyprland, so it needs a graphical Nidara session — it is a dev
 * instrument, not a CI gate. ⚠️ `hyprctl dispatch` under this repo's LUA config
 * only accepts Lua expressions (`hl.dsp.*`); the classic string form is a syntax
 * error that reports "ok". See references/architecture.md.
 *
 * Exit code 1 on any violation, so it can gate a hand-run check.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// ── The law, read from its single source ─────────────────────────────────────
// Parsed rather than duplicated: a checker carrying its own copy of the numbers
// passes happily after someone changes them.
const TOKENS = join(dirname(fileURLToPath(import.meta.url)), "../../ui/lib/tokens.ts")
const tokensSrc = readFileSync(TOKENS, "utf8")
const token = (name) => {
    const m = tokensSrc.match(new RegExp(`\\n\\s*${name}:\\s*(\\d+)`))
    if (!m) { console.error(`could not read WINDOW_LAYOUT.${name} from ${TOKENS}`); process.exit(2) }
    return Number(m[1])
}
const SIDEBAR = token("sidebar")
const CONTENT = token("content")
const FLOOR = token("contentFloor")
const RIM = token("glassRim")

// `.settings-page` padding: `$space-8 $space-10 $space-10` → 40px each side. The
// pane a page reports through queryUI is the padded box, so the clamp's width is
// this much wider.
const PAGE_PAD = 80

/** The pane width the law predicts for a window `winW` px wide. */
const expectedPane = (winW) => {
    const avail = winW - RIM * 2
    return Math.min(CONTENT, Math.max(FLOOR, avail)) - PAGE_PAD
}

const PAGES = [
    "network", "bluetooth", "appearance", "display", "audio", "bar", "dock",
    "widgets", "gaming", "notifications", "accessibility", "apps", "input",
    "power", "region", "users", "ai", "about",
]

const argWidths = process.argv.indexOf("--widths")
const WIDTHS = argWidths > -1
    ? process.argv[argWidths + 1].split(",").map(Number)
    : [1400, 1100, 1050, 900, 802, 600]

const sh = (cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: "utf8" }) } catch { return "" }
}
const ags = (...args) => sh("ags", ["request", ...args])
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const settingsWindow = () => {
    const wins = JSON.parse(ags("listWindows") || "[]")
    return wins.find(w => w.class === "io.Astal.ags" && w.title === "Nidara Settings")
}

const nodes = () =>
    (JSON.parse(ags("queryUI") || '{"nodes":[]}').nodes || [])
        .filter(n => n.window === "nidara-settings-window")

const has = (n, cls) => (n.cssClasses || []).includes(cls)

// ── Drive the window ─────────────────────────────────────────────────────────
ags("openSettings")
sleep(1500)

let win = settingsWindow()
if (!win) {
    console.error("Settings window not found — is the shell running? (ags request openSettings)")
    process.exit(2)
}
const addr = win.address
const wasFloating = win.floating
const original = win.size

const dispatch = (expr) => sh("hyprctl", ["dispatch", expr])
const resize = (w, h) => dispatch(`hl.dsp.window.resize({ x = ${w}, y = ${h}, window = 'address:${addr}' })`)

dispatch(`hl.dsp.window.float({ action = 'set', window = 'address:${addr}' })`)
sleep(400)
dispatch(`hl.dsp.window.move({ x = 30, y = 60, window = 'address:${addr}' })`)
sleep(300)

const findings = []
const paneWidths = new Set()

for (const W of WIDTHS) {
    resize(W, 900)
    sleep(800)
    const realW = settingsWindow()?.size?.[0] ?? -1

    const perPage = new Map()
    let dockedStates = new Set()
    let tallRows = []

    for (const page of PAGES) {
        ags("settingsPage", page)
        sleep(400)
        const ns = nodes()
        const pane = ns.find(n => has(n, "settings-page"))
        if (!pane) continue
        perPage.set(page, pane.bounds.w)
        paneWidths.add(pane.bounds.w)
        dockedStates.add(pane.bounds.x > 200)

        for (const r of ns.filter(n => has(n, "nidara-row"))) {
            const declared = has(r, "nidara-row--double") ? 72 : has(r, "nidara-row--single") ? 48 : 0
            // +2 for the row's own 1px margins. Anything beyond that is text that
            // took more lines than the row shape declares — legitimate for a long
            // subtitle, which is why this reports rather than fails.
            if (declared && r.bounds.h > declared + 2) tallRows.push(`${page}:${r.bounds.h}`)
        }
    }

    const widths = [...new Set(perPage.values())]
    if (widths.length !== 1) {
        const byWidth = {}
        for (const [p, w] of perPage) (byWidth[w] ||= []).push(p)
        findings.push(`window ${realW}: pane width differs per page — ${JSON.stringify(byWidth)}`)
    }
    const want = expectedPane(realW)
    if (widths.length === 1 && widths[0] !== want)
        findings.push(`window ${realW}: pane is ${widths[0]}, the law says ${want}`)
    // A pane wider than the window it sits in is the clip that started all this.
    if (widths.some(w => w + PAGE_PAD > realW))
        findings.push(`window ${realW}: pane ${widths} + padding exceeds the window — content is being CUT`)
    // A window meaningfully WIDER than asked means the compositor was refused: the
    // floor doing its job, not a failure. Report it so a sweep below the floor reads
    // correctly. The slack is because Hyprland's resize dispatcher lands ±1px.
    if (realW > W + 4) console.log(`  (floor held: asked ${W}, window stayed ${realW})`)
    console.log(
        `window ${String(realW).padStart(5)}  pane ${widths.join("/")}  ` +
        `sidebar ${[...dockedStates].map(d => d ? "docked" : "floating").join("+")}  ` +
        `rows over declared height: ${tallRows.length}`,
    )
}

// ── Restore ──────────────────────────────────────────────────────────────────
resize(original[0], original[1])
sleep(300)
if (!wasFloating) dispatch(`hl.dsp.window.float({ action = 'unset', window = 'address:${addr}' })`)

console.log()
if (findings.length === 0) {
    console.log(
        `PASS — every one of the ${PAGES.length} pages rendered the pane at exactly the width the law ` +
        `predicts (${CONTENT}px content, ${FLOOR}px floor), and nothing was cut.`,
    )
    process.exit(0)
}
for (const f of findings) console.error(`FAIL — ${f}`)
process.exit(1)
