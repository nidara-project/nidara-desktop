#!/usr/bin/env node
/*
 * same-app-check — verifies consistency of sameApp() and nameTokens() across
 * all standalone /bin helper scripts and the shell's app-search module.
 *
 *   node scripts/ci/same-app-check.mjs
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `bin/nidara-{a11y,act,click,type}` each carry a standalone copy of `sameApp`
 * and `nameTokens`, and `ui/shell/core/app-search.ts` implements the TypeScript
 * counterpart. The four helpers are copied directly to /usr/bin by install.sh
 * and cannot share a module import without inventing a dedicated resolver.
 *
 * The risk is DRIFT: if one helper changes its matching rules and the others do
 * not, perception and action will disagree on what an app is called (e.g. an
 * agent finding an app with nidara-a11y but failing to click it with nidara-click).
 *
 * This test extracts the live implementations from all four files, asserts that
 * their tokenizing and matching logic agree, and runs a battery of name pairs
 * against each copy.
 */

import { readFileSync } from "node:fs"
import vm from "node:vm"

const BIN_FILES = [
    "bin/nidara-a11y",
    "bin/nidara-act",
    "bin/nidara-click",
    "bin/nidara-type",
]

const APP_SEARCH_FILE = "ui/shell/core/app-search.ts"

function extractSameApp(filePath) {
    const src = readFileSync(filePath, "utf8")
    const noiseStart = src.indexOf('const NAME_NOISE = new Set(["org", "com", "io", "net", "app", "desktop"])')
    if (noiseStart === -1) {
        throw new Error(`Could not find NAME_NOISE declaration in ${filePath}`)
    }

    const sameAppStart = src.indexOf("function sameApp(a, b)", noiseStart)
    if (sameAppStart === -1) {
        throw new Error(`Could not find sameApp function in ${filePath}`)
    }

    // Find the end of function sameApp
    const endMatch = src.indexOf("return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))\n}", sameAppStart)
    if (endMatch === -1) {
        throw new Error(`Could not find end of sameApp in ${filePath}`)
    }
    const endIdx = endMatch + "return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))\n}".length

    const fullBlock = src.slice(noiseStart, endIdx)
    const execCode = `
        ${fullBlock};
        ({ nameTokens, sameApp })
    `
    const context = vm.createContext({})
    const exported = vm.runInContext(execCode, context)

    return {
        file: filePath,
        nameTokens: exported.nameTokens,
        sameApp: exported.sameApp,
        rawBlock: fullBlock.replace(/\s+/g, " ").trim(),
    }
}

function extractAppSearchModule() {
    const src = readFileSync(APP_SEARCH_FILE, "utf8")
    const noiseStart = src.indexOf('const NAME_NOISE = new Set(["org", "com", "io", "net", "app", "desktop"])')
    if (noiseStart === -1) {
        throw new Error(`Could not find NAME_NOISE declaration in ${APP_SEARCH_FILE}`)
    }
    const endMatch = src.indexOf("return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))\n}", noiseStart)
    if (endMatch === -1) {
        throw new Error(`Could not find end of sameApp in ${APP_SEARCH_FILE}`)
    }
    const endIdx = endMatch + "return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x))\n}".length

    const block = src.slice(noiseStart, endIdx)
    const jsBlock = block
        .replace(/export\s+/g, "")
        .replace(/\(s:\s*string\):\s*string\[\]/g, "(s)")
        .replace(/\(a:\s*string,\s*b:\s*string\):\s*boolean/g, "(a, b)")
        .replace(/:\s*string/g, "")

    const execCode = `
        ${jsBlock};
        ({ nameTokens, sameApp })
    `
    const context = vm.createContext({})
    const exported = vm.runInContext(execCode, context)
    return {
        file: APP_SEARCH_FILE,
        nameTokens: exported.nameTokens,
        sameApp: exported.sameApp,
        rawBlock: jsBlock.replace(/\s+/g, " ").trim(),
    }
}

const TEST_PAIRS = [
    // Identical and case-insensitive
    { a: "nautilus", b: "nautilus", expected: true },
    { a: "Firefox", b: "firefox", expected: true },
    { a: "google-chrome", b: "Google Chrome", expected: true },
    { a: "code", b: "Code", expected: true },
    { a: "micro", b: "Micro", expected: true },
    { a: "xterm", b: "XTerm", expected: true },

    // Reverse-DNS and packaging prefixes
    { a: "org.gnome.Nautilus", b: "nautilus", expected: true },
    { a: "org.gnome.Calculator", b: "calculator", expected: true },
    { a: "io.missioncenter.MissionCenter", b: "missioncenter", expected: true },
    { a: "org.telegram.desktop", b: "TelegramDesktop", expected: true },
    { a: "org.telegram.desktop", b: "telegram", expected: true },

    // CamelCase and digit seams (Widget Factory test case)
    { a: "org.gtk.WidgetFactory4", b: "gtk4-widget-factory", expected: true },
    { a: "Widget Factory", b: "gtk4-widget-factory", expected: true },
    { a: "WidgetFactory", b: "Widget Factory", expected: true },
    { a: "gtk4-widget-factory", b: "WidgetFactory4", expected: true },
    { a: "Gtk4WidgetFactory", b: "gtk4-widget-factory", expected: true },

    // Negative non-matching cases
    { a: "nautilus", b: "calculator", expected: false },
    { a: "firefox", b: "chrome", expected: false },
    { a: "xterm", b: "terminal", expected: false },
    { a: "kitty", b: "alacritty", expected: false },
    { a: "", b: "nautilus", expected: false },
    { a: "nautilus", b: "", expected: false },
]

const TOKEN_TEST_STRINGS = [
    "org.gtk.WidgetFactory4",
    "gtk4-widget-factory",
    "io.missioncenter.MissionCenter",
    "google-chrome",
    "org.gnome.Calculator",
    "TelegramDesktop",
    "com.visualstudio.code",
]

let failed = false
const log = (msg) => console.log(msg)
const error = (msg) => { console.error(`  FAIL  ${msg}`); failed = true }
const pass = (msg) => console.log(`  PASS  ${msg}`)

log("same-app-check — validating consistency across helper scripts and shell")

// 1. Extract from all bin files and app-search
const extracted = []
for (const file of BIN_FILES) {
    try {
        extracted.push(extractSameApp(file))
        pass(`Extracted sameApp & nameTokens from ${file}`)
    } catch (e) {
        error(`Could not parse ${file}: ${e.message}`)
    }
}

try {
    const appSearch = extractAppSearchModule()
    extracted.push(appSearch)
    pass(`Extracted sameApp & nameTokens from ${APP_SEARCH_FILE}`)
} catch (e) {
    error(`Could not parse ${APP_SEARCH_FILE}: ${e.message}`)
}

// 2. Assert that bin/ implementations match each other in logic & structure
if (extracted.length > 1) {
    // Normalize comments and whitespace for code comparison
    const norm = s => s.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim()
    const base = extracted[0]
    const baseNorm = norm(base.rawBlock)
    for (let i = 1; i < extracted.length - 1; i++) {
        const other = extracted[i]
        const otherNorm = norm(other.rawBlock)
        if (otherNorm !== baseNorm) {
            error(`sameApp block in ${other.file} differs from ${base.file}`)
        } else {
            pass(`sameApp block in ${other.file} matches ${base.file}`)
        }
    }
}

// 3. Test app-search.ts nameTokens against bin/ nameTokens
try {
    const appSearch = extracted.find(e => e.file === APP_SEARCH_FILE)
    const binTokens = extracted[0]?.nameTokens
    if (binTokens && appSearch?.nameTokens) {
        let tokenMismatch = false
        for (const str of TOKEN_TEST_STRINGS) {
            const tBin = binTokens(str)
            const tSearch = appSearch.nameTokens(str)
            if (JSON.stringify(tBin) !== JSON.stringify(tSearch)) {
                error(`Token mismatch for "${str}": bin=${JSON.stringify(tBin)} vs app-search=${JSON.stringify(tSearch)}`)
                tokenMismatch = true
            }
        }
        if (!tokenMismatch) {
            pass(`app-search.ts nameTokens produces identical tokens across all test fixtures`)
        }
    }
} catch (e) {
    error(`Failed to verify app-search.ts nameTokens: ${e.message}`)
}

// 4. Test all name pairs across each extracted implementation
log("\nEvaluating name matching test suite across all implementations:")
for (const impl of extracted) {
    let implFailed = false
    for (const { a, b, expected } of TEST_PAIRS) {
        const result = impl.sameApp(a, b)
        if (result !== expected) {
            error(`${impl.file}: sameApp("${a}", "${b}") = ${result} (expected ${expected})`)
            implFailed = true
        }
    }
    if (!implFailed) {
        pass(`${impl.file}: passed all ${TEST_PAIRS.length} pair assertions`)
    }
}

if (failed) {
    log("\nsame-app-check: FAILED")
    process.exit(1)
} else {
    log("\nsame-app-check: ALL CHECKS PASSED")
}
