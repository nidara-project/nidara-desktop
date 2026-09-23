#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/bundle.mjs — the esbuild step of scripts/bundle.sh, through esbuild's
// JS API (tech-debt #108 phase 3, 2026-09-23).
//
//   node scripts/bundle.mjs app <entry.ts> <out.js> [--kit-external=<dir>] [--alias:k=v|--define:k=v|--external:x …]
//   node scripts/bundle.mjs kit <outdir>
//
// `bundle.sh` used to call the esbuild CLI directly, and the flags below are
// still ITS flags — `ags bundle`'s, transcribed and verified byte-identical
// (read bundle.sh's header before changing one; the two load-bearing ones are
// `tsconfig` and the gjs built-ins). They moved here for ONE reason: the CLI
// cannot take a plugin, and leaving the kit out of an app takes one.
// ⚠️ Without `--kit-external` the output is byte-identical to the CLI's — that
// was measured on all four bundles when this file was written; keep it so.
//
// `--kit-external=<dir>`: every import that resolves into `ui/lib/nidara-kit/`
// becomes `import … from "file://<dir>/<module>.js"`, and the kit is NOT copied
// into the bundle. The app then loads the kit that is INSTALLED — one copy on
// the system, shared by every app, updated once (the owner's option B). An
// absolute file:// URI because the bundle itself runs from $XDG_RUNTIME_DIR
// (bundle.sh's wrapper unpacks it there), so nothing relative would resolve.
//
// `kit <outdir>`: the kit compiled as ES modules, one per source module plus
// shared chunks (esbuild `splitting`) — so a module's state (the host's `app`,
// the appearance seam, every registered GType) exists ONCE however many entry
// points an app imports it through. Measured on a gallery probe: same pixels as
// the bundled kit, same start-up time (~210 ms both).
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, statSync, rmSync, existsSync } from "fs"
import { join, dirname, resolve, relative } from "path"
import { fileURLToPath } from "url"

// The system esbuild's JS API (pacman `esbuild` ships it next to the binary).
// ESBUILD_JS overrides, like ESBUILD does for bundle.sh.
const esbuild = await import(process.env.ESBUILD_JS || "/usr/lib/node_modules/esbuild/lib/main.js")

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const KIT = join(REPO, "ui/lib/nidara-kit")

// gjs's built-in module names + the URI schemes it resolves itself. bundle.sh's list.
const GJS_EXTERNALS = ["gi://*", "file://*", "resource://*", "system", "console", "cairo", "gettext"]
const TARGET = ["es2022", "firefox115"]

function usage() {
    console.error("usage: bundle.mjs app <entry.ts> <out.js> [--kit-external=<dir>] [--alias:k=v|--define:k=v|--external:x …]")
    console.error("       bundle.mjs kit <outdir>")
    process.exit(2)
}

/** The kit's modules: every .ts under ui/lib/nidara-kit, minus declarations. */
function kitModules(dir = KIT) {
    return readdirSync(dir).flatMap(e => {
        const f = join(dir, e)
        if (statSync(f).isDirectory()) return e === "build" || e === "styles" ? [] : kitModules(f)
        return e.endsWith(".ts") && !e.endsWith(".d.ts") ? [f] : []
    })
}

/** Imports that land in the kit → an external file:// URI into `dir`. */
function kitExternal(dir) {
    const base = "file://" + resolve(dir)
    return {
        name: "nidara-kit-external",
        setup(build) {
            build.onResolve({ filter: /nidara-kit/ }, args => {
                if (!args.path.startsWith(".") && !args.path.startsWith("/")) return
                const abs = resolve(args.resolveDir, args.path).replace(/\.ts$/, "")
                if (abs !== KIT && !abs.startsWith(KIT + "/")) return
                const mod = abs === KIT ? "index" : relative(KIT, abs)
                return { path: `${base}/${mod}.js`, external: true }
            })
        },
    }
}

const [mode, ...rest] = process.argv.slice(2)

if (mode === "kit") {
    const [outdir] = rest
    if (!outdir) usage()
    // Wipe first: chunk names are content hashes, so a stale directory keeps
    // chunks nothing imports any more.
    if (existsSync(outdir)) rmSync(outdir, { recursive: true })
    await esbuild.build({
        entryPoints: kitModules(),
        outbase: KIT,
        outdir,
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "neutral",
        target: TARGET,
        // The shell's tsconfig: `target: ES2020` is what keeps useDefineForClassFields
        // OFF, and the kit has GObject subclasses (see bundle.sh's header).
        tsconfig: join(REPO, "ui/shell/tsconfig.json"),
        external: GJS_EXTERNALS,
        logLevel: "warning",
    })
} else if (mode === "app") {
    const [entry, outfile, ...extra] = rest
    if (!entry || !outfile) usage()
    const entryAbs = resolve(entry)
    const entryDir = dirname(entryAbs)
    const tsconfig = join(entryDir, "tsconfig.json")
    const alias = {}, define = { SRC: JSON.stringify(entryDir) }, external = [...GJS_EXTERNALS]
    const plugins = []
    for (const a of extra) {
        let m
        if ((m = a.match(/^--kit-external=(.+)$/))) plugins.push(kitExternal(m[1]))
        else if ((m = a.match(/^--alias:([^=]+)=(.*)$/))) alias[m[1]] = m[2]
        else if ((m = a.match(/^--define:([^=]+)=(.*)$/))) define[m[1]] = m[2]
        else if ((m = a.match(/^--external:(.+)$/))) external.push(m[1])
        else { console.error(`bundle.mjs: unsupported extra argument: ${a}`); process.exit(2) }
    }
    await esbuild.build({
        entryPoints: [entryAbs],
        outfile: resolve(outfile),
        bundle: true,
        format: "esm",
        platform: "neutral",
        target: TARGET,
        sourcemap: "inline",
        ...(existsSync(tsconfig) ? { tsconfig } : {}),
        loader: { ".css": "text" },
        define,
        alias,
        external,
        plugins,
        logLevel: "info",
    })
} else usage()
