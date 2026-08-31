// settings-config-contract — every declarative setting row in Settings pages
// must be backed by a registered ConfigEntry via settingRow(), or explicitly
// listed in scripts/ci/settings-rows-allowlist.txt with a justification.
//
// WHY THIS EXISTS (2026-08-31, #332):
// Every setting used to be described twice: once in config-entries.ts for the
// agent, and once by hand in Settings pages. The two lists diverged silently.
// This CI check ensures that settingRow() is used for all settings rows,
// that every settingRow() references a valid, registered config key, and
// that all declared i18n keys exist in en.ts.

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const EN_LOCALE_PATH = "ui/shell/core/i18n/locales/en.ts"
const CONFIG_ENTRIES_PATH = "ui/shell/config-entries.ts"
const PAGES_DIR = "ui/shell/surfaces/settings/pages"
const ALLOWLIST_PATH = "scripts/ci/settings-rows-allowlist.txt"

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "")

// 1. Collect all translation keys from en.ts
const enContent = read(EN_LOCALE_PATH)
if (!enContent) {
    console.error(`settings-config-contract: cannot read ${EN_LOCALE_PATH}`)
    process.exit(1)
}

const enKeys = new Set(
    [...enContent.matchAll(/["']([a-zA-Z0-9_.-]+)["']\s*:/g)].map((m) => m[1])
)

// 2. Collect all registered config entries and check their ui/i18n declarations
const configContent = read(CONFIG_ENTRIES_PATH)
if (!configContent) {
    console.error(`settings-config-contract: cannot read ${CONFIG_ENTRIES_PATH}`)
    process.exit(1)
}

let errors = []

// Parse registered config keys
const registeredKeys = new Set(
    [...configContent.matchAll(/registerConfig\(\s*["']([^"']+)["']/g)].map((m) => m[1])
)

// Check ui declarations in config-entries.ts:
// Match blocks: registerConfig("key", { ... })
const entryRegex = /registerConfig\(\s*["']([^"']+)["']\s*,\s*({[\s\S]*?\n\s{4}\})\)/g
let entryMatch
while ((entryMatch = entryRegex.exec(configContent)) !== null) {
    const key = entryMatch[1]
    const block = entryMatch[2]

    const i18nMatch = block.match(/i18n\s*:\s*["']([^"']+)["']/)
    if (i18nMatch) {
        const i18nKey = i18nMatch[1]
        if (!enKeys.has(i18nKey)) {
            errors.push(`  FAIL  config-entries.ts: key "${key}" declares ui.i18n "${i18nKey}" which does not exist in en.ts.`)
        }
        const descKey = `${i18nKey}.desc`
        if (!enKeys.has(descKey)) {
            errors.push(`  FAIL  config-entries.ts: key "${key}" subtitle "${descKey}" does not exist in en.ts.`)
        }

        // If enum without optI18n, check derived option keys
        const hasOptI18n = /optI18n\s*:/.test(block)
        const typeIsEnum = /type\s*:\s*["']enum["']/.test(block)
        if (typeIsEnum && !hasOptI18n) {
            const enumListMatch = block.match(/enum\s*:\s*\[([\s\S]*?)\]/)
            if (enumListMatch) {
                const options = [...enumListMatch[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1])
                for (const opt of options) {
                    const derivedOptKey = `${i18nKey}.opt.${opt}`
                    if (!enKeys.has(derivedOptKey)) {
                        errors.push(`  FAIL  config-entries.ts: key "${key}" enum option "${opt}" derived key "${derivedOptKey}" does not exist in en.ts (provide optI18n or add key to en.ts).`)
                    }
                }
            }
        }
    }
}

// 3. Parse allowlist
const allowlistContent = read(ALLOWLIST_PATH)
const allowlist = new Map() // "file:keyOrLine" -> { comment, used: false }
const gtkSwitchAllowlist = new Map() // file -> { expectedCount: number, actualCount: 0, comment, entry }

if (allowlistContent) {
    for (const rawLine of allowlistContent.split("\n")) {
        const line = rawLine.trim()
        if (!line || line.startsWith("#")) continue
        const [entryPart, ...commentParts] = line.split("#")
        const entry = entryPart.trim()
        const comment = commentParts.join("#").trim()
        if (entry) {
            const switchMatch = entry.match(/^([^:]+\.tsx):gtk-switch:(\d+)$/)
            if (switchMatch) {
                const [, file, countStr] = switchMatch
                gtkSwitchAllowlist.set(file, { expectedCount: parseInt(countStr, 10), actualCount: 0, comment, entry })
            } else {
                allowlist.set(entry, { comment, used: false })
            }
        }
    }
}

// 4. Scan pages in ui/shell/surfaces/settings/pages
if (!existsSync(PAGES_DIR)) {
    console.error(`settings-config-contract: pages directory not found: ${PAGES_DIR}`)
    process.exit(1)
}

const pageFiles = readdirSync(PAGES_DIR).filter((f) => f.endsWith(".tsx")).sort()

let settingRowCount = 0
let allowlistedRowCount = 0

for (const file of pageFiles) {
    const filePath = join(PAGES_DIR, file)
    const content = read(filePath)
    const lines = content.split("\n")
    let fileSwitchCount = 0

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

        // Count manual Gtk.Switch constructions in settings pages
        if (line.includes("new Gtk.Switch")) {
            fileSwitchCount++
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

    // Verify manual switch counts against allowlist
    if (fileSwitchCount > 0) {
        const declared = gtkSwitchAllowlist.get(file)
        if (!declared) {
            errors.push(
                `  FAIL  ${file}: contains ${fileSwitchCount} manual 'new Gtk.Switch()' call(s) not permitted in Settings pages. Use settingRow() or declare '${file}:gtk-switch:${fileSwitchCount}' in ${ALLOWLIST_PATH} (see #341).`
            )
        } else {
            declared.actualCount = fileSwitchCount
            if (declared.actualCount !== declared.expectedCount) {
                errors.push(
                    `  FAIL  ${file}: contains ${declared.actualCount} manual 'new Gtk.Switch()' call(s), but ${ALLOWLIST_PATH} declared ${declared.expectedCount}. Update ${ALLOWLIST_PATH}.`
                )
            }
        }
    } else if (gtkSwitchAllowlist.has(file)) {
        const declared = gtkSwitchAllowlist.get(file)
        errors.push(
            `  FAIL  ${ALLOWLIST_PATH}: entry "${declared.entry}" is obsolete (${file} contains 0 manual switches). Please remove it from the allowlist.`
        )
    }
}

// 5. Check for unused allowlist entries
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

const totalAllowlisted = allowlistedRowCount + gtkSwitchAllowlist.size
console.log(
    `settings-config-contract: all settings rows conform to config contract (${settingRowCount} settingRow, ${totalAllowlisted} allowlisted exceptions, all i18n keys verified).`
)
