// settings-config-contract — every declarative setting row in Settings pages
// must be backed by a registered ConfigEntry via settingRow(), or declared in
// the manifest (ui/shell/surfaces/settings/manifest.ts), or explicitly listed
// in scripts/ci/settings-rows-allowlist.txt with a justification.
//
// WHY THIS EXISTS (2026-08-31 #332, 2026-09-01 #341):
// Settings used to be described twice: once in config-entries.ts for the agent,
// and once by hand in Settings pages. The two lists diverged silently.
//
// WHAT THIS COVERS:
// 1. manifest.ts is pure data (no gi:// imports) and importable via TypeScript strip-types;
// 2. all keys in manifest.ts are registered in config-entries.ts and declare ui:;
// 3. every registered key with ui: for a migrated page appears in manifest.ts exactly once;
// 4. all declared i18n keys exist in en.ts;
// 5. settingRow() in unmigrated pages references valid config keys;
// 6. unmigrated manual switches conform to allowlist.
//
// WHAT THIS DOES NOT COVER:
// The check's denominator is registered config keys. A row drawn from page-local
// state (e.g. `barSettings.launcherIcon` which is not a `registerConfig` key) is
// invisible to it in both directions — it cannot detect if such a row was added
// or removed. Until the { custom } vocabulary lands (P2), a page may only be
// migrated after auditing the component file end to end.

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { manifest } from "../../ui/shell/surfaces/settings/manifest.ts"

const EN_LOCALE_PATH = "ui/shell/core/i18n/locales/en.ts"
const CONFIG_ENTRIES_PATH = "ui/shell/config-entries.ts"
const MANIFEST_PATH = "ui/shell/surfaces/settings/manifest.ts"
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

// 2. Verify manifest.ts is pure data (no gi:// imports)
const manifestRaw = read(MANIFEST_PATH)
if (!manifestRaw) {
    console.error(`settings-config-contract: cannot read ${MANIFEST_PATH}`)
    process.exit(1)
}

let errors = []

if (/import\s+.*["']gi:\/\//.test(manifestRaw)) {
    errors.push(`  FAIL  ${MANIFEST_PATH}: contains "gi://" import. The manifest must be pure data.`)
}

// 3. Collect all registered config entries and check their ui/i18n declarations
const configContent = read(CONFIG_ENTRIES_PATH)
if (!configContent) {
    console.error(`settings-config-contract: cannot read ${CONFIG_ENTRIES_PATH}`)
    process.exit(1)
}

// Parse registered config keys
const registeredKeys = new Set(
    [...configContent.matchAll(/registerConfig\(\s*["']([^"']+)["']/g)].map((m) => m[1])
)

const keysWithUi = new Map()

// Match blocks: registerConfig("key", { ... })
const entryRegex = /registerConfig\(\s*["']([^"']+)["']\s*,\s*({[\s\S]*?\n\s{4}\})\)/g
let entryMatch
while ((entryMatch = entryRegex.exec(configContent)) !== null) {
    const key = entryMatch[1]
    const block = entryMatch[2]

    const i18nMatch = block.match(/i18n\s*:\s*["']([^"']+)["']/)
    if (i18nMatch) {
        const i18nKey = i18nMatch[1]
        keysWithUi.set(key, { i18nKey, block })

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

// 4. Validate Manifest against registered config entries (The Real Denominator #341)
const migratedPageIds = new Set(manifest.map(p => p.id))
const manifestItemCounts = new Map()
let totalManifestItems = 0

for (const page of manifest) {
    if (page.header) {
        if (!page.header.custom || typeof page.header.custom !== "string") {
            errors.push(`  FAIL  manifest.ts: page "${page.id}" header must declare a string custom identifier.`)
        }
    }
    for (const group of page.groups) {
        if (group.i18n && group.i18n !== "" && !enKeys.has(group.i18n)) {
            errors.push(`  FAIL  manifest.ts: page "${page.id}" group declares i18n "${group.i18n}" which does not exist in en.ts.`)
        }
        if (group.footer && !enKeys.has(group.footer)) {
            errors.push(`  FAIL  manifest.ts: page "${page.id}" group declares footer "${group.footer}" which does not exist in en.ts.`)
        }
        if (group.footerWhen) {
            if (!registeredKeys.has(group.footerWhen.key)) {
                errors.push(`  FAIL  manifest.ts: page "${page.id}" footerWhen references unregistered config key "${group.footerWhen.key}".`)
            }
            if (!Array.isArray(group.footerWhen.in) || group.footerWhen.in.length === 0) {
                errors.push(`  FAIL  manifest.ts: page "${page.id}" footerWhen.in must be a non-empty array.`)
            }
        }
        if (group.custom) {
            if (typeof group.custom !== "string") {
                errors.push(`  FAIL  manifest.ts: page "${page.id}" group custom must be a string.`)
            }
            if (group.items && group.items.length > 0) {
                errors.push(`  FAIL  manifest.ts: page "${page.id}" group declares both custom and items (they are mutually exclusive).`)
            }
        }
        if (group.items) {
            for (const item of group.items) {
                if (typeof item === "string") {
                    totalManifestItems++
                    if (!registeredKeys.has(item)) {
                        errors.push(`  FAIL  manifest.ts: page "${page.id}" references unregistered config key "${item}".`)
                    }
                    if (!keysWithUi.has(item)) {
                        errors.push(`  FAIL  manifest.ts: page "${page.id}" item "${item}" has no ui: declaration in config-entries.ts.`)
                    }
                    manifestItemCounts.set(item, (manifestItemCounts.get(item) || 0) + 1)
                } else if (typeof item === "object" && item !== null) {
                    if ("custom" in item) {
                        if (!item.custom || typeof item.custom !== "string") {
                            errors.push(`  FAIL  manifest.ts: page "${page.id}" custom item must declare a string custom identifier.`)
                        }
                        if (!item.i18n || !enKeys.has(item.i18n)) {
                            errors.push(`  FAIL  manifest.ts: page "${page.id}" custom item "${item.custom}" declares i18n "${item.i18n}" which does not exist in en.ts.`)
                        }
                        const descKey = `${item.i18n}.desc`
                        if (!enKeys.has(descKey)) {
                            errors.push(`  FAIL  manifest.ts: page "${page.id}" custom item "${item.custom}" requires description i18n "${descKey}" which does not exist in en.ts.`)
                        }
                        if (item.key) {
                            if (!registeredKeys.has(item.key)) {
                                errors.push(`  FAIL  manifest.ts: page "${page.id}" custom item "${item.custom}" references unregistered config key "${item.key}".`)
                            }
                        }
                        if (item.visibleWhen) {
                            if (!registeredKeys.has(item.visibleWhen.key)) {
                                errors.push(`  FAIL  manifest.ts: page "${page.id}" custom item "${item.custom}" visibleWhen references unregistered config key "${item.visibleWhen.key}".`)
                            }
                            if (!Array.isArray(item.visibleWhen.in) || item.visibleWhen.in.length === 0) {
                                errors.push(`  FAIL  manifest.ts: page "${page.id}" custom item "${item.custom}" visibleWhen.in must be a non-empty array.`)
                            }
                        }
                    } else if ("decoration" in item) {
                        if (!item.decoration || typeof item.decoration !== "string") {
                            errors.push(`  FAIL  manifest.ts: page "${page.id}" decoration item must declare a string decoration identifier.`)
                        }
                        if (item.visibleWhen) {
                            if (!registeredKeys.has(item.visibleWhen.key)) {
                                errors.push(`  FAIL  manifest.ts: page "${page.id}" decoration item "${item.decoration}" visibleWhen references unregistered config key "${item.visibleWhen.key}".`)
                            }
                            if (!Array.isArray(item.visibleWhen.in) || item.visibleWhen.in.length === 0) {
                                errors.push(`  FAIL  manifest.ts: page "${page.id}" decoration item "${item.decoration}" visibleWhen.in must be a non-empty array.`)
                            }
                        }
                    } else {
                        errors.push(`  FAIL  manifest.ts: page "${page.id}" contains invalid item: ${JSON.stringify(item)}.`)
                    }
                } else {
                    errors.push(`  FAIL  manifest.ts: page "${page.id}" contains invalid item: ${JSON.stringify(item)}.`)
                }
            }
        }
    }
}

// Check for duplicate items in manifest
for (const [item, count] of manifestItemCounts.entries()) {
    if (count > 1) {
        errors.push(`  FAIL  manifest.ts: key "${item}" appears ${count} times in the manifest (must appear exactly once).`)
    }
}

// Check that EVERY registered key with ui: belonging to a migrated page is in manifest.ts.
// NOTE: Prefix matching (key.split(".")[0]) works for these eight pages because their key
// prefixes match page IDs (accessibility, dock, input, notifications, bar, gaming, power, region).
// In Phase P2b, when mixed pages like Appearance migrate (containing cross-cutting keys like
// nightlight.* and wallpaper.transition — exactly 4 keys), the manifest itself becomes the
// universal denominator with zero exemptions.
for (const [key] of keysWithUi.entries()) {
    const pageId = key.split(".")[0]
    if (migratedPageIds.has(pageId)) {
        const count = manifestItemCounts.get(key) || 0
        if (count === 0) {
            errors.push(`  FAIL  config-entries.ts: key "${key}" declares ui: for migrated page "${pageId}", but is missing from manifest.ts.`)
        }
    }
}

// 5. Parse allowlist
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

// 6. Scan remaining pages in ui/shell/surfaces/settings/pages
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

// 7. Check for unused allowlist entries
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
    `settings-config-contract: ${manifest.length} manifest pages (${totalManifestItems} items), ${settingRowCount} settingRow in unmigrated pages, ${totalAllowlisted} allowlisted exceptions, all contracts verified.`
)
