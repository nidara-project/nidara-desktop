#!/usr/bin/env node
/**
 * apply-i18n.mjs
 * Reads the reviewed i18n-extracted.json and:
 *   1. Patches each source TSX file replacing hardcoded strings with t("key")
 *   2. Adds import { t } from "../../../core/i18n" where missing
 *   3. Writes/updates en.ts and es.ts locale files
 *
 * Usage: node scripts/apply-i18n.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

const DRY = process.argv.includes("--dry-run")
const ROOT = new URL("..", import.meta.url).pathname

const EXTRACTED  = join(ROOT, "scripts/i18n-extracted.json")
const PAGES_DIR  = join(ROOT, "ui/shell/surfaces/settings/pages")
const DOCK_DIR   = join(ROOT, "ui/shell/surfaces/dock")
const I18N_DIR   = join(ROOT, "ui/shell/core/i18n/locales")
const EN_FILE    = join(I18N_DIR, "en.ts")
const ES_FILE    = join(I18N_DIR, "es.ts")

const extracted = JSON.parse(readFileSync(EXTRACTED, "utf8"))

// ── File path resolver ────────────────────────────────────────────────────────
const fileFor = (fileKey) => {
  if (fileKey.startsWith("dock.")) {
    const name = fileKey.split(".")[1]
    const map = { dockitem: "DockItem.tsx", dock: "Dock.tsx" }
    return join(DOCK_DIR, map[name] || `${name}.tsx`)
  }
  // Handle multi-word filenames (e.g. controlcenter → ControlCenter)
  const camelMap = { controlcenter: "ControlCenter" }
  const name = camelMap[fileKey] ?? (fileKey.charAt(0).toUpperCase() + fileKey.slice(1))
  return join(PAGES_DIR, `${name}.tsx`)
}

// Import path from settings pages → i18n
const importPathFor = (fileKey) =>
  fileKey.startsWith("dock.")
    ? `"../../core/i18n"`
    : `"../../../core/i18n"`

// ── Group entries by source file ──────────────────────────────────────────────
const byFile = {}
for (const [key, meta] of Object.entries(extracted)) {
  const f = meta.file
  if (!byFile[f]) byFile[f] = []
  byFile[f].push({ key, value: meta.value })
}

// ── Patch source files ────────────────────────────────────────────────────────
let totalReplaced = 0
const patchLog = []

for (const [fileKey, entries] of Object.entries(byFile)) {
  const path = fileFor(fileKey)
  let src
  try { src = readFileSync(path, "utf8") } catch { console.warn(`  SKIP (not found): ${path}`); continue }

  let patched = src
  let replacedInFile = 0

  // Sort longest value first to avoid partial replacements
  entries.sort((a, b) => b.value.length - a.value.length)

  for (const { key, value } of entries) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

    // Match the exact string in common translatable positions:
    // "Value"  →  t("key")
    // Replace only when the string appears as a double-quoted argument,
    // not inside css_classes, icon_name, name, id, exec, className, etc.
    const patterns = [
      // JSX string attribute values: label="Value"  or  title="Value"
      new RegExp(`(?<=(label|title|subtitle|tooltip_text|placeholder_text|placeholder):\\s*)"${escaped}"`, "g"),
      // First/second positional string arg in helper calls
      new RegExp(`(?<=(pageHeader|listGroup|createRow|toggleRow|dropdownRow|sliderRow|pageBox|makeSection|sectionTitle)\\(\\s*)"${escaped}"`, "g"),
      new RegExp(`(?<=(pageHeader|createRow|toggleRow|dropdownRow|sliderRow)\\([^,]{0,120},\\s*)"${escaped}"`, "g"),
      // Gtk.Label({ label: "Value" })
      new RegExp(`(?<=label:\\s*)"${escaped}"`, "g"),
    ]

    let found = false
    for (const re of patterns) {
      const next = patched.replace(re, `t("${key}")`)
      if (next !== patched) { patched = next; found = true; break }
    }
    if (found) replacedInFile++
  }

  // Add import if t() is now used and not yet imported
  if (replacedInFile > 0 && !patched.includes("from") && patched.includes("t(\"")) {
    console.warn(`  WARN: t() used but no import found in ${fileKey} — add manually`)
  }
  if (replacedInFile > 0 && !patched.includes(`from ${importPathFor(fileKey)}`) && patched.includes("t(\"")) {
    // Insert import after the last existing import line
    patched = patched.replace(
      /(import[^\n]+\n)(?!import)/,
      `$1import { t } from ${importPathFor(fileKey)}\n`
    )
  }

  totalReplaced += replacedInFile
  patchLog.push({ file: fileKey, path, replaced: replacedInFile })

  if (!DRY) writeFileSync(path, patched)
}

// ── Build locale entries ───────────────────────────────────────────────────────
// Read existing en.ts to avoid duplicating already-present keys
const existingEn = readFileSync(EN_FILE, "utf8")
const existingKeys = new Set([...existingEn.matchAll(/"(settings\.[^"]+)":/g)].map(m => m[1]))

const newEnEntries = []
const newEsEntries = []

for (const [key, meta] of Object.entries(extracted)) {
  if (existingKeys.has(key)) continue
  // en: use value as-is if it looks English, else mark for translation
  const isSpanish = /[áéíóúñüÁÉÍÓÚÑÜ¿¡]/.test(meta.value)
  const enVal = isSpanish ? `TODO: ${meta.value}` : meta.value
  newEnEntries.push(`    "${key}": "${enVal.replace(/"/g, '\\"')}"`)
  newEsEntries.push(`    "${key}": "${meta.value.replace(/"/g, '\\"')}"`)
}

// Append to locale files
if (newEnEntries.length > 0) {
  const appendEn = `\n    // --- extracted by extract-i18n.mjs ---\n${newEnEntries.join(",\n")},\n`
  const appendEs = `\n    // --- extracted by extract-i18n.mjs ---\n${newEsEntries.join(",\n")},\n`

  if (!DRY) {
    writeFileSync(EN_FILE, existingEn.replace(/}\s*$/, appendEn + "}"))
    const existingEs = readFileSync(ES_FILE, "utf8")
    writeFileSync(ES_FILE, existingEs.replace(/}\s*$/, appendEs + "}"))
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n${DRY ? "[DRY RUN] " : ""}i18n apply complete`)
console.log(`  Source replacements: ${totalReplaced} / ${Object.keys(extracted).length}`)
console.log(`  New locale entries:  ${newEnEntries.length}`)
console.log(`  en.ts entries marked TODO (need English translation): ${newEnEntries.filter(l => l.includes("TODO:")).length}`)
console.log("")
for (const { file, replaced } of patchLog) {
  console.log(`  ${file.padEnd(30)} ${replaced} replacements`)
}
if (DRY) console.log("\n  Run without --dry-run to apply changes.")
