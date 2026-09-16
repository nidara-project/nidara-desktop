#!/usr/bin/env node
/*
 * icon-registry-check — every interface-icon concept can still be drawn.
 *
 *   node scripts/ci/icon-registry-check.mjs
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `core/Icons.ts` maps a concept to two things: the STANDARD name it asks the
 * user's interface icon theme for, and the drawing shipped with the shell that
 * is the last link of the chain (#587). The chain's whole promise is that it
 * never ends in `image-missing` — a user can pick any theme, however partial,
 * and Nidara's own surfaces still draw.
 *
 * That promise breaks silently. A missing icon file is not a compile error and
 * not a runtime error either: GTK hands back `image-missing` (or, for a
 * `Gio.FileIcon` to a path that is not there, nothing at all) and the surface
 * draws a gap where a glyph should be. Nobody finds out until they look at the
 * pixel — and the icon study on #587 found four concepts already carried with no
 * live caller, so "somebody would have noticed" is not true here.
 *
 * So this checks, mechanically:
 *
 *   1. every concept's shipped drawing exists on disk;
 *   2. every concept names a standard icon, and no two concepts claim the same
 *      one — two concepts under one name is a theme that cannot tell them apart;
 *   3. no shipped drawing is orphaned: a file in the asset directory that no
 *      concept points at is either dead weight or a concept somebody forgot to
 *      register.
 *
 * It deliberately does NOT check the standard names against Adwaita. Seven of
 * them are not in Adwaita at all (see the registry's comment), and that is fine:
 * that is what the shipped drawing is for. What must hold is (1).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const REGISTRY = "ui/shell/core/Icons.ts"
const ASSETS = "ui/shell/assets/icons/hicolor/scalable/actions"

let failed = false
const log = s => console.log(s)
const pass = s => log(`  ✓ ${s}`)
const error = s => { failed = true; log(`  ✗ ${s}`) }

// ── 1. Read the registry ─────────────────────────────────────────────────────
// The table is `concept: ["standard-name", "asset-name"],` — one line each, and
// the parse is anchored to that shape so a reformat fails loudly rather than
// quietly matching nothing.
const src = readFileSync(REGISTRY, "utf8")
const table = src.match(/const CONCEPTS = \{([\s\S]*?)\n\} as const/)
if (!table) {
    log(`icon-registry-check: could not find the CONCEPTS table in ${REGISTRY}`)
    process.exit(1)
}

const concepts = []
for (const m of table[1].matchAll(/^\s*(\w+):\s*\["([^"]+)",\s*"([^"]+)"\],/gm)) {
    concepts.push({ concept: m[1], standard: m[2], asset: m[3] })
}
if (concepts.length === 0) {
    log(`icon-registry-check: the CONCEPTS table in ${REGISTRY} parsed as empty`)
    process.exit(1)
}
log(`${REGISTRY}: ${concepts.length} concepts`)

// ── 2. Every concept's shipped drawing exists ────────────────────────────────
log("\nEvery concept has its shipped drawing:")
for (const { concept, asset } of concepts) {
    if (existsSync(join(ASSETS, `${asset}.svg`))) pass(`${concept} → ${asset}.svg`)
    else error(`${concept} points at ${asset}.svg, which is not in ${ASSETS}: the last link of the chain is missing, so this concept draws nothing when the interface theme has no icon for it.`)
}

// ── 3. No two concepts share a standard name ─────────────────────────────────
log("\nNo two concepts claim the same standard name:")
const byStandard = new Map()
for (const { concept, standard } of concepts) {
    if (!byStandard.has(standard)) byStandard.set(standard, [])
    byStandard.get(standard).push(concept)
}
for (const [standard, owners] of byStandard) {
    if (owners.length === 1) pass(`${standard} — ${owners[0]}`)
    else error(`${owners.join(", ")} all ask for "${standard}": an interface theme has one drawing for that name, so these concepts become indistinguishable the moment a theme is chosen.`)
}

// ── 4. No orphaned drawing ───────────────────────────────────────────────────
log("\nEvery shipped drawing belongs to a concept:")
const used = new Set(concepts.map(c => c.asset))
const files = readdirSync(ASSETS).filter(f => f.endsWith(".svg")).map(f => f.slice(0, -4))
for (const file of files) {
    if (used.has(file)) continue
    error(`${file}.svg is in ${ASSETS} but no concept points at it — either dead weight to delete, or a concept missing from the registry.`)
}
if (files.every(f => used.has(f))) pass(`${files.length} files, all registered`)

if (failed) {
    log("\nicon-registry-check: FAILED")
    process.exit(1)
} else {
    log("\nicon-registry-check: ALL CHECKS PASSED")
}
