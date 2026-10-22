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
//   <out>/tokens/glass.json    the shell's glass as the kit's material answers it (toolkit/PHASE1.md
//                              D7): each piece's tone, ink tone and shadow by the pane's shorter
//                              side, dark/light × reduce transparency, its glass parameters and
//                              blur. Asked of `registerGlassMaterial`'s own source with a host
//                              that says the mode and the switch — the sizing, the solid face of
//                              reduce transparency and the popover's extra pass are the kit's
//                              code running, not numbers read off its tables. Each step of the
//                              control piece also carries `toolkit/tokens/control.json` — how a
//                              control answers its backdrop, its states' washes, its inks — for
//                              the variant it is in: the native kit's own source, not the kit's.
//   <out>/tokens/components.json common geometry, named content widths and D8 list data,
//                              per dark/light × reduce transparency, separate from material.
//
// The engine (`platform/theme-tokens.ts`) imports Gio/GLib for its file helpers only; a loader
// stubs `gi://` and resolves the kit's extension-less imports, so the kit (frozen, #818) is
// run as it is, untouched.
// usage: node --experimental-strip-types scripts/export-tokens.mjs [OUT]   (default build/settings-data)
//        SASS="…" overrides the compiler (default: npx --yes sass@1.97.3, as the styles job)
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
        // GLib: the material's dev tuning file is looked for only under ~/.config/nidara/.dev,
        // which this says is not there. Gtk: a Popover is all the material asks it (its blur).
        const stub = body => ({ url: "data:text/javascript," + encodeURIComponent(body), shortCircuit: true })
        if (spec.startsWith("gi://GLib"))
            return stub("export default { get_home_dir: () => '/nonexistent', file_test: () => false, FileTest: { EXISTS: 16 } }")
        if (spec.startsWith("gi://Gtk")) return stub("export default { Popover: class {} }")
        if (spec.startsWith("gi://")) return { url: "data:text/javascript,export default {}", shortCircuit: true }
        // The material keeps the source it is given in material.ts, a GTK module; here it is
        // handed to the exporter instead.
        if (spec === "./material" && ctx.parentURL?.endsWith("/platform/glass-material.ts"))
            return stub("export function setMaterialSource(s) { globalThis.__nidaraMaterialSource = s; return () => {} }; "
                + "export function inkFollowsMode() { return false }")
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
// ── glass ────────────────────────────────────────────────────────────────
// The shell's host in a Hyalo session (ui/shell/core/hyalo-settings.ts `blurBaseline`): the
// material's own blur; the mode and reduce transparency are what each variant says.
const material = await import(pathToFileURL(join(kit, "platform/glass-material.ts")).href)
const state = { light: false, reduce: false }
const changed = []
material.registerGlassMaterial({
    reduceTransparency: () => state.reduce,
    panelBlur: () => ({ ...engine.GLASS_BLUR }),
    lightMode: () => state.light,
    onChange: cb => { changed.push(cb); return () => {} },
})
const source = globalThis.__nidaraMaterialSource
source.onChange(() => {})   // hooks the material's cache of tones to `changed`
const Gtk = (await import("gi://Gtk?version=4.0")).default
// Every whole side from 0 to past the widest ramp the material sizes by; a step where the
// answer changes, so a reader takes the last step at or under its pane's side (rounded, as the
// material rounds it).
const SIDES = 400
// A control on glass (toolkit/CONTRACT.md, "Floating control capsule"): `default`, then every
// entry of `variants` whose dark/reduceTransparency match, field by field.
const control = JSON.parse(readFileSync(join(repo, "toolkit/tokens/control.json"), "utf8"))
const list = JSON.parse(readFileSync(join(repo, "toolkit/tokens/list.json"), "utf8"))
const choices = JSON.parse(readFileSync(join(repo, "toolkit/tokens/choices.json"), "utf8"))
const range = JSON.parse(readFileSync(join(repo, "toolkit/tokens/range.json"), "utf8"))
const switchLook = JSON.parse(readFileSync(join(repo, "toolkit/tokens/switch.json"), "utf8"))
const rows = JSON.parse(readFileSync(join(repo, "toolkit/tokens/rows.json"), "utf8"))
const variantFor = (recipe, dark, reduceTransparency) => recipe.variants
    .filter(o => (o.dark ?? dark) === dark && (o.reduceTransparency ?? reduceTransparency) === reduceTransparency)
    .reduce((acc, o) => ({ ...acc, ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== "dark" && k !== "reduceTransparency")) }),
        recipe.default)
const controlFor = (dark, reduceTransparency) => {
    const { response, states, ink } = variantFor(control, dark, reduceTransparency)
    return { response, states, ink }
}
const variants = []
const componentVariants = []
for (const dark of [true, false])
    for (const reduceTransparency of [false, true]) {
        Object.assign(state, { light: !dark, reduce: reduceTransparency })
        for (const cb of changed) cb()
        const pieces = {}
        for (const piece of Object.keys(material.GLASS_TONES)) {
            const steps = []
            for (let side = 0; side <= SIDES; side++) {
                const answer = JSON.stringify(source.tone(null, piece, !dark, side))
                if (steps.at(-1)?.answer !== answer) steps.push({ side, answer })
            }
            if (steps.at(-1).side === SIDES) throw new Error(`glass: ${piece} still changes at ${SIDES} px`)
            const extra = piece === "control" ? controlFor(dark, reduceTransparency) : {}
            pieces[piece] = steps.map(({ side, answer }) => ({ fromSide: side, ...JSON.parse(answer), ...extra }))
        }
        // The ink: when a pane's text turns dark (Hyalo measures the darkest point under it, WCAG
        // luminance), as the shell asks it — null with reduce transparency (no ink).
        variants.push({ dark, reduceTransparency, glass: source.glass(null), ink: source.ink(null), pieces })
        const pixels = key => {
            const value = Number.parseFloat(scss[key])
            if (!Number.isFinite(value)) throw new Error(`missing component geometry: ${key}`)
            return value
        }
        componentVariants.push({ dark, reduceTransparency,
            list: variantFor(list, dark, reduceTransparency),
            choices: variantFor(choices, dark, reduceTransparency),
            range: variantFor(range, dark, reduceTransparency),
            switch: variantFor(switchLook, dark, reduceTransparency),
            rows: variantFor(rows, dark, reduceTransparency),
            common: { padding: pixels("space-3"), gap: pixels("space-1"),
                radius: ts.RADIUS.sm, groupRadius: ts.RADIUS.md },
            widths: { form: { preferred: ts.WINDOW_LAYOUT.content, floor: ts.WINDOW_LAYOUT.contentFloor },
                reading: null, none: null },
        })
    }
write(join(out, "tokens/glass.json"), {
    inputs: { dark: "appearance.darkMode", reduceTransparency: "accessibility.reduceTransparency" },
    blur: { panel: source.blur({}), popover: source.blur(new Gtk.Popover()) },
    variants,
})

write(join(out, "tokens/components.json"), {
    inputs: { dark: "appearance.darkMode", reduceTransparency: "accessibility.reduceTransparency" },
    variants: componentVariants,
})

console.log(`export-tokens: ${Object.keys(scss).length} scss + ${Object.keys(ts).length} ts static, `
    + `${sets.length} colour sets of ${Object.keys(sets[0].tokens).length}, `
    + `${variants.length} glass variants of ${Object.keys(variants[0].pieces).length} pieces, `
    + `${componentVariants.length} component variants → ${out}/tokens`)
