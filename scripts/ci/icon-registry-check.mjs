#!/usr/bin/env node
/*
 * icon-registry-check — every interface icon Nidara asks for can be drawn.
 *
 *   node scripts/ci/icon-registry-check.mjs [--theme <built theme dir>]
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `core/Icons.ts` lists the icon names the shell, the greeter, the lock screen
 * and the installer ask for. There is only ONE name per icon (#587): a
 * freedesktop standard name when the concept has one, an `nd-` name of ours when
 * it does not. That same name is looked for in the user's interface icon theme
 * first and in `ui/shell/assets/…/<name>-symbolic.svg` second, so the shipped
 * drawing is the end of the chain and the chain must never end in a gap.
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
 *   3. an `nd-` name is one no icon theme defines. If a standard name exists for
 *      the concept, use it; `nd-` is for what the Naming Spec has no word for.
 *
 * With `--theme <dir>` it also checks a BUILT theme — the one
 * `scripts/icons/build-icon-theme.py` produces. That theme is Nidara's own, so
 * every non-`nd-` name must resolve in it, in BOTH size directories. The second
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
const own = names.filter(n => n.startsWith("nd-"))
log(`${REGISTRY}: ${names.length} icon names (${own.length} of them ours: ${own.join(", ")})`)

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

// ── 4. `nd-` is for what has no standard name ────────────────────────────────
// Not a coverage test — plenty of standard names are missing from plenty of
// themes, and the shipped drawing is what that is for. This is about intent: a
// name we invented must not be one the desktop already has a word for.
log("\nOur own names are not shadowing standard ones:")
const THEMES = ["/usr/share/icons/Adwaita", "/usr/share/icons/hicolor"]
for (const name of own) {
    const bare = name.slice(3)
    const clash = THEMES.some(root => {
        try {
            return readdirSync(root, { recursive: true })
                .some(f => typeof f === "string" && (f.endsWith(`/${bare}-symbolic.svg`) || f.endsWith(`/${bare}.svg`)))
        } catch { return false }
    })
    if (clash) error(`"${name}" invents a name for "${bare}", which an installed theme already defines — drop the nd- prefix and let themes supply it.`)
    else pass(`${name}`)
}

// ── 5. A built theme covers every standard name, in both sizes ───────────────
const themeFlag = process.argv.indexOf("--theme")
if (themeFlag !== -1) {
    const theme = process.argv[themeFlag + 1]
    if (!theme) {
        log("icon-registry-check: --theme needs a directory")
        process.exit(1)
    }
    const SIZES = ["scalable/actions", "16x16/actions"]
    log(`\n${theme}: every standard name resolves, in both size directories:`)
    for (const name of names) {
        // An `nd-` name is ours by definition; no theme is asked for it.
        if (name.startsWith("nd-")) continue
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
