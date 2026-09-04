#!/usr/bin/env node
// The Lua this shell GENERATES has to parse, for the same reason
// `config/hypr/hyprland.lua` does: `hyprland.lua` requires
// ~/.config/nidara/nidara-settings.lua at every login, and a syntax error there
// costs the session its whole Nidara configuration. Nothing else catches it —
// the generator is TypeScript, so `tsc` sees a string and `luac` never sees the
// string tsc produced.
//
// `ui/shell/core/hyprland-lua.ts` exists as a pure module precisely so this can
// run: `HyprlandState` opens the compositor's event socket at import time and
// `InputConfig` reads effective options the moment it is constructed, so
// neither is reachable from CI. The builders are.
//
// ⚠️ This check carries its OWN positive control. `luac -p` returning 0 proves
// nothing until you have seen it return non-zero for a broken chunk with the
// same invocation — an absent or misnamed luac would otherwise report every
// render as fine, forever.

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = new URL("../..", import.meta.url).pathname
const tmp = mkdtempSync(join(tmpdir(), "hypr-lua-"))
let failures = 0

const ok = (name) => console.log(`  ok    ${name}`)
const fail = (name, detail) => { failures++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`) }

// ── Locate the tools ─────────────────────────────────────────────────────────
const which = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0

const LUAC = ["luac5.4", "luac"].find(which)
if (!LUAC) {
    console.error("hypr-lua-check: no luac on PATH (need luac5.4 or luac)")
    process.exit(1)
}

// esbuild if it is installed (it is, on a dev machine and in the bundle jobs),
// otherwise a pinned npx. Either way the version is not left to chance.
const ESBUILD = which("esbuild") ? ["esbuild"] : ["npx", "--yes", "esbuild@0.28.2"]

// ── Build the pure module ────────────────────────────────────────────────────
const OUT = join(tmp, "hyprland-lua.mjs")
try {
    execFileSync(ESBUILD[0], [
        ...ESBUILD.slice(1),
        join(ROOT, "ui/shell/core/hyprland-lua.ts"),
        "--format=esm",
        `--outfile=${OUT}`,
    ], { stdio: "pipe" })
} catch (e) {
    console.error("hypr-lua-check: could not build hyprland-lua.ts\n", e.stderr?.toString() ?? e)
    process.exit(1)
}

const { luaLiteral, luaConfigExpr, luaConfigBlock } = await import(OUT)

/** null when luac accepts the chunk, its complaint otherwise. */
function parses(src, name = "chunk") {
    const file = join(tmp, `${name}.lua`)
    writeFileSync(file, src)
    const r = spawnSync(LUAC, ["-p", file], { encoding: "utf8" })
    return r.status === 0 ? null : (r.stderr || "rejected").trim()
}

// ── The control, FIRST ───────────────────────────────────────────────────────
// If a broken chunk is accepted, every result below is meaningless.
if (parses("hl.config({ input = { ", "control") === null) {
    console.error(`hypr-lua-check: ${LUAC} accepted a deliberately broken chunk — it is not checking anything`)
    process.exit(1)
}
ok(`${LUAC} rejects a broken chunk (control)`)

// ── The real generated file ──────────────────────────────────────────────────
// The ten options `InputConfig` declares, with values chosen to exercise every
// literal kind and the nested table.
const ENTRIES = [
    ["input:sensitivity", "0.35"],
    ["input:accel_profile", luaLiteral("adaptive")],
    ["input:natural_scroll", luaLiteral(false)],
    ["input:numlock_by_default", luaLiteral(true)],
    ["input:kb_layout", luaLiteral("es")],
    ["input:kb_variant", luaLiteral("nodeadkeys")],
    ["input:repeat_delay", luaLiteral(600)],
    ["input:repeat_rate", luaLiteral(25)],
    ["input:touchpad:natural_scroll", luaLiteral(false)],
    ["input:touchpad:tap_to_click", luaLiteral(true)],
]

const block = luaConfigBlock(ENTRIES)
const err = parses(block, "generated")
if (err) fail("the generated input config parses", `${err}\n${block}`)
else ok("the generated input config parses")

// A boolean spelled `1` would still parse and still be accepted by Hyprland,
// which is exactly why it needs asserting rather than eyeballing: the live eval
// and the file it mirrors used two different spellings.
if (/= (0|1),/.test(block)) fail("booleans are true/false, not 1/0", block)
else ok("booleans are true/false, not 1/0")

if (!/touchpad = \{/.test(block)) fail("a two-segment option nests", block)
else ok("a two-segment option nests")

// ── Every single-option eval ─────────────────────────────────────────────────
let evalBad = null
for (const [path, literal] of ENTRIES) {
    const value = literal.startsWith('"') ? JSON.parse(literal)
        : literal === "true" ? true
        : literal === "false" ? false
        : Number(literal)
    const e = parses(luaConfigExpr(path, value), "expr")
    if (e) { evalBad = `${path}: ${e}`; break }
}
if (evalBad) fail("every single-option eval parses", evalBad)
else ok("every single-option eval parses")

// ── Escaping ─────────────────────────────────────────────────────────────────
// A value carrying a quote must not be able to add a key to the table. The
// control is the same value NOT escaped, which must produce something different.
const NASTY = 'x" , injected = "y'
const escaped = luaConfigBlock([["input:kb_variant", luaLiteral(NASTY)]])
const raw = luaConfigBlock([["input:kb_variant", `"${NASTY}"`]])

// The question is whether `injected` is a KEY or just text inside a string, so
// the string literals have to come out before looking. Testing the raw text
// finds it either way — which it did, on the first run of this check.
const withoutStrings = (src) => src.replace(/"(?:\\.|[^"\\])*"/g, '""')

if (parses(escaped, "escaped") !== null) fail("an escaped quote still parses", escaped)
else if (/injected/.test(withoutStrings(escaped))) fail("an escaped quote cannot add a key", escaped)
else ok("a quote is escaped rather than closing the string")

if (!/injected\s*=/.test(withoutStrings(raw))) fail("control: the UNescaped value should have injected a key", raw)
else ok("the unescaped same value would have injected a key (control)")

// ── The greeter's keyboard layout, RESOLVED rather than parsed ───────────────
//
// `config/greetd/hyprland-greeter.lua` decides which layout the login screen
// types in, and until #434 it answered "us" on every fresh machine: it read only
// the greeter's saved preference, which does not exist yet on a machine nobody
// has logged into. The language on that same screen already falls back to
// /etc/locale.conf; the keyboard fell back to nothing.
//
// ⚠️ Parsing is not the check here. The file parsed perfectly while it was
// wrong, and so did the `sed` in `nidara-setup` that was supposed to patch it —
// it looked for a literal that had left the file seven days after the sed was
// written, and a sed that matches nothing succeeds. So this RUNS the config, with
// `hl` stubbed and `io.open` serving fixture files, and reads the value it
// actually hands to `input.kb_layout`.
const GREETER_LUA = join(ROOT, "config/greetd/hyprland-greeter.lua")
const PREFS = "/var/lib/greeter/.config/nidara/greeter-prefs.json"
const VCONSOLE = "/etc/vconsole.conf"

const LAYOUT_CASES = [
    { name: "a machine installed with a Spanish keyboard", want: "es",
      files: { [VCONSOLE]: "# written by systemd-localed\nKEYMAP=es\nXKBLAYOUT=es\n" } },
    { name: "the greeter's own pick wins over the system", want: "fr",
      files: { [PREFS]: '{"locale":"","kbLayout":"fr","lastUser":"a"}',
               [VCONSOLE]: "KEYMAP=es\nXKBLAYOUT=es\n" } },
    { name: "an empty saved pick falls through to the system", want: "es",
      files: { [PREFS]: '{"locale":"","kbLayout":"","lastUser":"a"}',
               [VCONSOLE]: "KEYMAP=es\nXKBLAYOUT=es\n" } },
    { name: "no XKBLAYOUT: the console keymap, translated", want: "gb",
      files: { [VCONSOLE]: "KEYMAP=uk\n" } },
    { name: "a quoted value", want: "es", files: { [VCONSOLE]: 'KEYMAP="es"\n' } },
    { name: "XKBLAYOUT on the very first line", want: "de",
      files: { [VCONSOLE]: "XKBLAYOUT=de\nKEYMAP=de-latin1\n" } },
    { name: "a machine that says nothing at all", want: "us", files: {} },
]

// ⚠️ A JS object is not a Lua table: `{"a": "b"}` is a syntax error over there.
const luaTable = (files) => "{ "
    + Object.entries(files).map(([k, v]) => `[${JSON.stringify(k)}] = ${JSON.stringify(v)}`).join(", ")
    + " }"

const HARNESS = (files) => `
local FILES = ${luaTable(files)}
local realOpen = io.open
io.open = function(path, mode)
    local content = FILES[path]
    if content == nil then return nil end
    return { read = function() return content end, close = function() end }
end
local captured = nil
hl = setmetatable({}, { __index = function(_, key)
    if key == "config" then
        return function(t) if t.input and t.input.kb_layout then captured = t.input.kb_layout end end
    end
    return function() end
end })
dofile(${JSON.stringify(GREETER_LUA)})
io.open = realOpen
print(captured)
`

const LUA = ["lua5.4", "lua"].find(which)
if (!LUA) fail("a lua interpreter to resolve the greeter's layout", "need lua5.4 or lua on PATH")
else {
    for (const c of LAYOUT_CASES) {
        const script = join(tmp, "greeter-kb.lua")
        writeFileSync(script, HARNESS(c.files))
        const r = spawnSync(LUA, [script], { encoding: "utf8" })
        const got = (r.stdout || "").trim()
        if (r.status !== 0) fail(`greeter layout — ${c.name}`, (r.stderr || "").trim())
        else if (got !== c.want) fail(`greeter layout — ${c.name}`, `resolved ${got || "(nothing)"}, expected ${c.want}`)
        else ok(`greeter layout — ${c.name}`)
    }
}

rmSync(tmp, { recursive: true, force: true })

if (failures > 0) {
    console.error(`\nhypr-lua-check: ${failures} failure(s)`)
    process.exit(1)
}
console.log("hypr-lua-check: the Lua this shell generates parses, and says what it means.")
