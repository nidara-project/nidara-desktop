// settings-config-contract — every declarative setting row in Settings pages
// must be backed by a registered ConfigEntry via settingRow(), or explicitly
// listed in scripts/ci/settings-rows-allowlist.txt with a justification.
//
// WHY THIS EXISTS (2026-08-31, #332):
// Every setting used to be described twice: once in config-entries.ts for the
// agent, and once by hand in Settings pages. The two lists diverged silently.
// This CI check ensures that settingRow() is used for all settings rows and
// that every settingRow() references a valid, registered config key.

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, basename } from "node:path"

const CONFIG_ENTRIES_PATH = "ui/shell/config-entries.ts"
const PAGES_DIR = "ui/shell/surfaces/settings/pages"
const ALLOWLIST_PATH = "scripts/ci/settings-rows-allowlist.txt"

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "")

// 1. Collect all registered config keys from config-entries.ts
const configContent = read(CONFIG_ENTRIES_PATH)
if (!configContent) {
    console.error(`settings-config-contract: cannot read ${CONFIG_ENTRIES_PATH}`)
    process.exit(1)
}

const registeredKeys = new Set(
    [...configContent.matchAll(/registerConfig\(\s*["']([^"']+)["']/g)].map((m) => m[1])
)

// 2. Parse allowlist
const allowlistContent = read(ALLOWLIST_PATH)
const allowlist = new Map() // "file:keyOrLine" -> comment

if (allowlistContent) {
    for (const rawLine of allowlistContent.split("\n")) {
        const line = rawLine.trim()
        if (!line || line.startsWith("#")) continue
        const [entryPart, ...commentParts] = line.split("#")
        const entry = entryPart.trim()
        const comment = commentParts.join("#").trim()
        if (entry) {
            allowlist.set(entry, { comment, used: false })
        }
    }
}

// 3. Scan pages in ui/shell/surfaces/settings/pages
if (!existsSync(PAGES_DIR)) {
    console.error(`settings-config-contract: pages directory not found: ${PAGES_DIR}`)
    process.exit(1)
}

const pageFiles = readdirSync(PAGES_DIR).filter((f) => f.endsWith(".tsx")).sort()

let errors = []
let settingRowCount = 0
let allowlistedRowCount = 0

for (const file of pageFiles) {
    const filePath = join(PAGES_DIR, file)
    const content = read(filePath)
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1
        const line = lines[i]

        // Check settingRow("key") calls
        const settingMatches = [...line.matchAll(/settingRow\(\s*["']([^"']+)["']/g)]
        for (const match of settingMatches) {
            const key = match[1]
            settingRowCount++
            if (!registeredKeys.has(key)) {
                errors.push(
                    `  FAIL  ${file}:${lineNum}: settingRow("${key}") references an unregistered config key.`
                )
            }
        }

        // Check unmigrated toggleRow, dropdownRow, sliderRow calls
        const rowMatch = line.match(/\b(toggleRow|dropdownRow|sliderRow)\s*\(/)
        if (rowMatch) {
            const funcName = rowMatch[1]

            // Look for i18n key on this line or upcoming lines within the call
            let combined = line
            for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
                if (combined.includes(";")) break
                combined += " " + lines[j]
            }

            const i18nMatch = combined.match(/t\(\s*["']([^"']+)["']\)/)
            const i18nKey = i18nMatch ? i18nMatch[1] : ""

            const candidateKeys = [
                `${file}:${i18nKey}`,
                `${file}:${lineNum}`,
            ]

            let matchedEntry = null
            for (const ck of candidateKeys) {
                if (allowlist.has(ck)) {
                    matchedEntry = ck
                    break
                }
            }

            if (matchedEntry) {
                allowlist.get(matchedEntry).used = true
                allowlistedRowCount++
            } else {
                errors.push(
                    `  FAIL  ${file}:${lineNum}: unmigrated ${funcName}() with key "${i18nKey || "unknown"}" is not permitted. Migrate to settingRow() or add to ${ALLOWLIST_PATH}.`
                )
            }
        }
    }
}

// 4. Check for unused allowlist entries
for (const [entry, meta] of allowlist.entries()) {
    if (!meta.used) {
        errors.push(
            `  FAIL  ${ALLOWLIST_PATH}: entry "${entry}" is no longer needed (row was migrated or removed). Please remove it from the allowlist.`
        )
    }
}

if (errors.length > 0) {
    console.error("settings-config-contract failed:")
    for (const err of errors) {
        console.error(err)
    }
    process.exit(1)
}

console.log(
    `settings-config-contract: all settings rows conform to config contract (${settingRowCount} settingRow, ${allowlistedRowCount} allowlisted).`
)
