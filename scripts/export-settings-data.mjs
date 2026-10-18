#!/usr/bin/env node
// What the native Settings (toolkit phase 1, toolkit/PHASE1.md D2/D4) reads of the current one,
// exported from the SAME files — never a second copy to keep in step:
//
//   <out>/manifest.json        ui/shell/surfaces/settings/manifest.ts — pages, groups, items
//   <out>/i18n/<locale>.json   ui/shell/core/i18n/locales/<locale>.ts — flat key → string
//
// Run with `node --experimental-strip-types` (both sources are pure data for that reason:
// the manifest says so in its header; a locale is one `export default {…}`).
// usage: node --experimental-strip-types scripts/export-settings-data.mjs [OUT]   (default build/settings-data)
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { SETTINGS_DATA_VERSION } from "./settings-data-version.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const out = resolve(process.argv[2] ?? join(repo, "build/settings-data"))
const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 1) + "\n")
}
// Shared by both exporters: the same number, whichever ran last.
mkdirSync(out, { recursive: true })
writeFileSync(join(out, "version"), `${SETTINGS_DATA_VERSION}\n`)

const { manifest } = await import(pathToFileURL(join(repo, "ui/shell/surfaces/settings/manifest.ts")).href)
write(join(out, "manifest.json"), manifest)

const localeDir = join(repo, "ui/shell/core/i18n/locales")
const locales = readdirSync(localeDir).filter(f => f.endsWith(".ts")).sort()
for (const file of locales) {
    const strings = (await import(pathToFileURL(join(localeDir, file)).href)).default
    for (const [key, value] of Object.entries(strings))
        if (typeof value !== "string") throw new Error(`${file}: ${key} is not a string`)
    write(join(out, "i18n", file.replace(/\.ts$/, ".json")), strings)
}
console.log(`export-settings-data: ${manifest.length} pages, ${locales.length} locales → ${out}`)
