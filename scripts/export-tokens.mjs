#!/usr/bin/env node
// The design tokens the native Settings paints with (toolkit/PHASE1.md D4), computed by the
// SAME code that paints the current desktop — no number copied, no formula ported:
//
//   <out>/tokens/static.json   mode-independent: every variable of the kit's `_tokens.scss`
//                              (sass enumerates them itself, `meta.module-variables`) and
//                              every plain-data export of `platform/tokens.ts`
//   <out>/tokens/colors.json   the colour tokens in force for EVERY input of the token engine:
//                              accent × dark/light × reduce transparency × window transparency.
//                              In force = `_base.scss`'s compiled `*` block with the engine's
//                              `nidaraVars` over it, which is what a GJS process loads.
//                              A client picks its set from org.nidara.Config1's values.
//
// The engine (`platform/theme-tokens.ts`) imports Gio/GLib for its file helpers only; a loader
// stubs `gi://` and resolves the kit's extension-less imports, so the kit (frozen, #818) is
// run as it is, untouched.
// usage: node --experimental-strip-types scripts/export-tokens.mjs [OUT]   (default build/settings-data)
//        SASS="…" overrides the compiler (default: npx --yes sass@1.97.3, as the styles job)
import { execSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { register } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { SETTINGS_DATA_VERSION } from "./settings-data-version.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const out = resolve(process.argv[2] ?? join(repo, "build/settings-data"))
const kit = join(repo, "ui/lib/nidara-kit")
const write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 1) + "\n")
}
// Shared by both exporters: the same number, whichever ran last.
mkdirSync(out, { recursive: true })
writeFileSync(join(out, "version"), `${SETTINGS_DATA_VERSION}\n`)

register("data:text/javascript," + encodeURIComponent(`
    import { existsSync } from "node:fs"
    import { fileURLToPath } from "node:url"
    export async function resolve(spec, ctx, next) {
        if (spec.startsWith("gi://")) return { url: "data:text/javascript,export default {}", shortCircuit: true }
        if (/^\\.\\.?\\//.test(spec) && !/\\.[cm]?[jt]s$/.test(spec) && ctx.parentURL?.startsWith("file:")) {
            const u = new URL(spec + ".ts", ctx.parentURL)
            if (existsSync(fileURLToPath(u))) return { url: u.href, shortCircuit: true }
        }
        return next(spec, ctx)
    }`))

// ── static ───────────────────────────────────────────────────────────────
const sass = process.env.SASS || "npx --yes sass@1.97.3"
const css = execSync(`${sass} --stdin --no-source-map --load-path=${join(kit, "styles")}`, {
    input: '@use "sass:meta";\n@use "tokens";\n'
        + ':root { @each $k, $v in meta.module-variables("tokens") { --#{$k}: #{meta.inspect($v)}; } }\n',
    encoding: "utf8",
})
const scss = Object.fromEntries([...css.matchAll(/^\s*--([\w-]+):\s*(.*);$/gm)].map(m => [m[1], m[2]]))
const tsTokens = await import(pathToFileURL(join(kit, "platform/tokens.ts")).href)
const ts = Object.fromEntries(Object.entries(tsTokens).filter(([, v]) => typeof v !== "function"))
write(join(out, "tokens/static.json"), { scss, ts })

// ── colours ──────────────────────────────────────────────────────────────
// The starting block COMPILED, not read: its mixins (`radius-vars`) and expressions resolved,
// exactly what GTK is handed before the engine writes over it.
const baseCss = execSync(`${sass} --stdin --no-source-map --load-path=${join(repo, "ui/shell/styles")}`, {
    input: '@use "base";\n', encoding: "utf8",
})
const props = text => Object.fromEntries(
    [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--nidara-[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
const starting = props(baseCss.slice(baseCss.indexOf("* {"), baseCss.indexOf("}", baseCss.indexOf("* {"))))

const engine = await import(pathToFileURL(join(kit, "platform/theme-tokens.ts")).href)
const accents = Object.keys(engine.ACCENT_PALETTE)
const sets = []
for (const accent of accents)
    for (const dark of [true, false])
        for (const reduceTransparency of [false, true])
            for (const windowBackground of ["opaque", "tinted", "translucent"]) {
                const config = engine.withGlass({ ...engine.DEFAULT_CONFIG, accent, reduceTransparency, windowBackground })
                const tokens = { ...starting, ...props(engine.nidaraVars(config, dark).join("\n")) }
                sets.push({ accent, dark, reduceTransparency, windowBackground, tokens })
            }
write(join(out, "tokens/colors.json"), {
    inputs: {
        accent: "appearance.accent", dark: "appearance.darkMode",
        reduceTransparency: "accessibility.reduceTransparency", windowBackground: "appearance.windowBackground",
    },
    accents: Object.fromEntries(accents.map(k => [k, engine.ACCENT_PALETTE[k].color])),
    sets,
})
console.log(`export-tokens: ${Object.keys(scss).length} scss + ${Object.keys(ts).length} ts static, `
    + `${sets.length} colour sets of ${Object.keys(sets[0].tokens).length} → ${out}/tokens`)
