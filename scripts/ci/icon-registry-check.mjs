#!/usr/bin/env node
/*
 * icon-registry-check — every interface icon Nidara asks for can be drawn.
 *
 *   node scripts/ci/icon-registry-check.mjs [--theme <built theme dir>]
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `core/Icons.ts` lists the icon names the shell, the greeter, the lock screen
 * and the installer ask for. Since 2026-09-17 every one of them is an `nd-` name
 * of the Nidara icon spec (#587), defined in `ui/shell/assets/icons/SPEC.md`. A
 * name is looked for in the user's interface icon theme — only one that declares
 * the spec — first, and in `ui/shell/assets/…/<name>-symbolic.svg` second, so the
 * shipped drawing is the end of the chain and the chain must never end in a gap.
 *
 * It breaks silently. A missing icon file is not a compile error and not a
 * runtime error either: GTK hands back `image-missing` (or, for a `Gio.FileIcon`
 * to a path that is not there, nothing at all) and the surface draws a hole where
 * a glyph should be. Nobody finds out until they look at the pixel.
 *
 * So this checks, mechanically:
 *
 *   1. every listed name has its drawing, under `<name>-symbolic.svg`. The suffix
 *      is load-bearing, not a convention: GTK gates recolouring on the FILENAME,
 *      so a drawing that loses it renders black with no error anywhere;
 *   2. no drawing is orphaned — a file no name points at is either dead weight or
 *      a name somebody forgot to list;
 *   3. the spec and the code say the same thing: every name is `nd-`, SPEC.md's
 *      table holds exactly the names in ICON_NAMES, and the spec version is the
 *      same in SPEC.md, `ICON_SPEC_VERSION` and the theme generator. The spec is
 *      what theme authors build against — a name the shell asks for that the spec
 *      does not list is an icon no theme will ever draw.
 *
 * With `--theme <dir>` it also checks a BUILT theme — the one
 * `scripts/icons/build-icon-theme.py` produces. That theme is Nidara's own, so it
 * must declare the spec version in its `index.theme` (or Settings would not list
 * it) and every name must resolve in it, in BOTH size directories. The second
 * half matters on its own: the icon study's first alias pass wrote the standard
 * names only into `scalable/`, and at 16px GTK then silently drew the thin one.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const REGISTRY = "ui/shell/core/Icons.ts"
const ASSETS = "ui/shell/assets/icons/hicolor/scalable/actions"

let failed = false
const log = s => console.log(s)
const pass = s => log(`  ✓ ${s}`)
const error = s => { failed = true; log(`  ✗ ${s}`) }

// ── 1. Read the list ─────────────────────────────────────────────────────────
// Anchored to the declaration's shape so a reformat fails loudly rather than
// quietly matching nothing.
const src = readFileSync(REGISTRY, "utf8")
const block = src.match(/export const ICON_NAMES = \[([\s\S]*?)\n\] as const/)
if (!block) {
    log(`icon-registry-check: could not find ICON_NAMES in ${REGISTRY}`)
    process.exit(1)
}
const names = [...block[1].matchAll(/^\s*"([^"]+)",/gm)].map(m => m[1])
if (names.length === 0) {
    log(`icon-registry-check: ICON_NAMES in ${REGISTRY} parsed as empty`)
    process.exit(1)
}
log(`${REGISTRY}: ${names.length} icon names`)

// ── 2. Every name has its drawing ────────────────────────────────────────────
log("\nEvery name has its shipped drawing:")
for (const name of names) {
    if (existsSync(join(ASSETS, `${name}-symbolic.svg`))) pass(`${name}-symbolic.svg`)
    else error(`"${name}" has no ${name}-symbolic.svg in ${ASSETS}: the end of the chain is missing, so this icon draws nothing when the interface theme has no icon for it either.`)
}

// ── 3. No orphaned drawing ───────────────────────────────────────────────────
log("\nEvery shipped drawing is a name somebody asks for:")
const used = new Set(names.map(n => `${n}-symbolic`))
const files = readdirSync(ASSETS).filter(f => f.endsWith(".svg")).map(f => f.slice(0, -4))
for (const file of files) {
    if (used.has(file)) continue
    error(`${file}.svg is in ${ASSETS} but no name points at it — dead weight, a name missing from ICON_NAMES, or a drawing that lost its -symbolic suffix.`)
}
if (files.every(f => used.has(f))) pass(`${files.length} files, all asked for`)

// ── 4. The spec and the code agree ───────────────────────────────────────────
const SPEC = "ui/shell/assets/icons/SPEC.md"
const GENERATOR = "scripts/icons/build-icon-theme.py"
log("\nThe spec lists exactly the names the code asks for:")
for (const name of names) {
    if (!name.startsWith("nd-")) error(`"${name}" is not an nd- name. Interface icons use Nidara's icon spec only; freedesktop names belong to APP icons.`)
}
const specSrc = readFileSync(SPEC, "utf8")
const specNames = [...specSrc.matchAll(/^\| `(nd-[^`]+)` \|/gm)].map(m => m[1])
if (specNames.length === 0) error(`${SPEC}: no names parsed from its table — reformatted?`)
const inSpec = new Set(specNames), inCode = new Set(names)
for (const n of names) if (!inSpec.has(n)) error(`"${n}" is in ICON_NAMES but not in ${SPEC}: no theme author will know to draw it.`)
for (const n of specNames) if (!inCode.has(n)) error(`"${n}" is in ${SPEC} but not in ICON_NAMES: the spec promises a name the shell never asks for.`)
const dupes = specNames.filter((n, i) => specNames.indexOf(n) !== i)
for (const n of dupes) error(`"${n}" is listed twice in ${SPEC}.`)
if (names.every(n => inSpec.has(n)) && specNames.every(n => inCode.has(n)) && dupes.length === 0) pass(`${specNames.length} names, same set in both`)

const versions = {
    [SPEC]: specSrc.match(/^\*\*Version (\d+)\.\*\*/m)?.[1],
    [REGISTRY]: src.match(/export const ICON_SPEC_VERSION = (\d+)/)?.[1],
    [GENERATOR]: readFileSync(GENERATOR, "utf8").match(/^NIDARA_ICON_SPEC = (\d+)/m)?.[1],
}
const specVersion = versions[REGISTRY]
for (const [file, v] of Object.entries(versions)) {
    if (!v) error(`${file}: spec version not found — reformatted?`)
    else if (v !== specVersion) error(`${file} says spec version ${v}, ${REGISTRY} says ${specVersion}.`)
}
if (Object.values(versions).every(v => v && v === specVersion)) pass(`spec version ${specVersion} everywhere`)

// ── 5. A built theme covers every standard name, in both sizes ───────────────
const themeFlag = process.argv.indexOf("--theme")
if (themeFlag !== -1) {
    const theme = process.argv[themeFlag + 1]
    if (!theme) {
        log("icon-registry-check: --theme needs a directory")
        process.exit(1)
    }
    const SIZES = ["scalable/actions", "16x16/actions"]
    const declared = readFileSync(join(theme, "index.theme"), "utf8").match(/^X-Nidara-Icon-Spec=(\d+)$/m)?.[1]
    log(`\n${theme}: declares the spec, so Settings lists it:`)
    if (declared === specVersion) pass(`X-Nidara-Icon-Spec=${declared}`)
    else error(`index.theme declares X-Nidara-Icon-Spec=${declared ?? "(nothing)"}, expected ${specVersion}.`)
    log(`\n${theme}: every name resolves, in both size directories:`)
    for (const name of names) {
        // existsSync follows symlinks, which is what we want: the standard names
        // ARE symlinks, and a broken one is exactly the failure being hunted.
        const missing = SIZES.filter(s => !existsSync(join(theme, s, `${name}-symbolic.svg`)))
        if (missing.length === 0) pass(`${name}`)
        else error(`"${name}" is not in the theme's ${missing.join(" or ")}. Nidara's own theme is the end of the chain — a gap here is a glyph nobody can supply.`)
    }
}

if (failed) {
    log("\nicon-registry-check: FAILED")
    process.exit(1)
} else {
    log("\nicon-registry-check: ALL CHECKS PASSED")
}
