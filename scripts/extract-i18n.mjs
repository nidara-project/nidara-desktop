#!/usr/bin/env node
/**
 * extract-i18n.mjs
 * Scans settings pages and dock for hardcoded translatable strings,
 * generates suggested i18n keys and outputs a ready-to-review en.ts patch.
 *
 * Usage: node scripts/extract-i18n.mjs
 * Output: scripts/i18n-extracted.json  (review & rename keys before applying)
 */

import { readFileSync, writeFileSync, readdirSync } from "fs"
import { join, basename } from "path"

const ROOT = new URL("..", import.meta.url).pathname
const PAGES_DIR = join(ROOT, "ui/shell/surfaces/settings/pages")
const DOCK_DIR  = join(ROOT, "ui/shell/surfaces/dock")
const OUT_FILE  = join(ROOT, "scripts/i18n-extracted.json")

// ── Patterns that identify translatable string arguments ──────────────────────
// Each rule: { pattern: RegExp with 1 capture group, context: string }
const RULES = [
  // pageHeader("Title", "Subtitle")
  { re: /pageHeader\(\s*"([^"]+)"/g,          ctx: "page.title" },
  { re: /pageHeader\([^,]+,\s*"([^"]+)"/g,    ctx: "page.subtitle" },

  // listGroup("Group label")
  { re: /listGroup\(\s*"([^"]+)"/g,           ctx: "group" },

  // createRow("Label", "Description", ...)
  // toggleRow("Label", "Description", ...)
  // dropdownRow("Label", "Description", ...)
  // sliderRow("Label", "Description", ...)
  { re: /(?:createRow|toggleRow|dropdownRow|sliderRow)\(\s*"([^"]+)"/g,       ctx: "row.label" },
  { re: /(?:createRow|toggleRow|dropdownRow|sliderRow)\([^,]+,\s*"([^"]+)"/g, ctx: "row.desc" },

  // new Gtk.Label({ label: "..." })
  { re: /label:\s*"([^"]+)"/g,               ctx: "label" },

  // tooltip_text: "..."
  { re: /tooltip_text:\s*"([^"]+)"/g,        ctx: "tooltip" },

  // button labels: { label: "Apply" } via createRow etc already caught,
  // but also standalone button children
  { re: /new Gtk\.Button\({[^}]*label:\s*"([^"]+)"/g, ctx: "button" },
]

// ── Strings to skip (non-translatable) ───────────────────────────────────────
const SKIP = [
  /^[a-z0-9_\-:./ ]+$/,           // all-lowercase identifiers, paths, codes
  /-symbolic$/,                     // icon names
  /^#[0-9a-fA-F]/,                 // hex colors
  /^[0-9\s%+\-*/.,:]+$/,           // numbers / math / punctuation only
  /^Ex:/,                           // placeholder examples (already in en.ts)
  /^\s*$/,
]

const shouldSkip = (s) => SKIP.some(r => r.test(s.trim()))

// ── Key generator ─────────────────────────────────────────────────────────────
const toKey = (file, ctx, str) => {
  const slug = str
    .toLowerCase()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i").replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u").replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return `settings.${file}.${ctx}.${slug}`
}

// ── Main extraction ───────────────────────────────────────────────────────────
const results = {}   // key → { value, file, ctx }
const seen   = new Set()

const scanFile = (path, fileKey) => {
  const src = readFileSync(path, "utf8")
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, "g")
    let m
    while ((m = re.exec(src)) !== null) {
      const str = m[1].trim()
      if (shouldSkip(str)) continue
      if (seen.has(str)) continue   // deduplicate by value
      seen.add(str)
      const key = toKey(fileKey, rule.ctx, str)
      results[key] = { value: str, file: fileKey, ctx: rule.ctx }
    }
  }
}

// Scan settings pages (skip Input and Region — already done)
for (const f of readdirSync(PAGES_DIR).filter(f => f.endsWith(".tsx"))) {
  const base = basename(f, ".tsx").toLowerCase()
  if (base === "input" || base === "region") continue
  scanFile(join(PAGES_DIR, f), `${base}`)
}

// Scan dock
for (const f of ["DockItem.tsx", "Dock.tsx"]) {
  try { scanFile(join(DOCK_DIR, f), `dock.${basename(f, ".tsx").toLowerCase()}`) }
  catch { /* file may not exist */ }
}

// ── Output ────────────────────────────────────────────────────────────────────
const sorted = Object.fromEntries(Object.entries(results).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(OUT_FILE, JSON.stringify(sorted, null, 2))

// ── Summary ───────────────────────────────────────────────────────────────────
const byFile = {}
for (const { file } of Object.values(sorted)) {
  byFile[file] = (byFile[file] || 0) + 1
}
console.log(`\n✓ Extracted ${Object.keys(sorted).length} translatable strings\n`)
console.log("By file:")
for (const [f, n] of Object.entries(byFile).sort()) {
  console.log(`  ${f.padEnd(30)} ${n}`)
}
console.log(`\nOutput: ${OUT_FILE}`)
console.log("\nNext steps:")
console.log("  1. Review i18n-extracted.json — rename keys if needed")
console.log("  2. Run apply-i18n.mjs to patch the source files and en.ts / es.ts")
