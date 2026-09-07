// Keyboards — ONE catalogue, derived, shared by the installer and by Settings.
//
// ─── WHY THIS FILE EXISTS (#473) ─────────────────────────────────────────────
// The product asked "which keyboard?" twice and answered from two lists that did
// not know each other: Settings carried 28 rows written out by hand, the
// installer derived 62 from `/usr/share/systemd/kbd-model-map`. They overlapped
// on 26. Install with a keyboard from the other 36 and Settings showed you the
// raw code, because its list had never heard of it.
//
// ⚠️ **`kbd-model-map` is a BRIDGE TABLE, not a catalogue.** That is the
// measurement that decided the shape of this file: of the 598 keyboards
// `xkeyboard-config` describes, systemd names a console keymap for **58**. Nine
// per cent. Building the single list on it would have meant the single list was
// wrong — and provably so: `us(colemak)` is real in BOTH namespaces (xkb lists
// the variant, `kbd` ships the `colemak` keymap) and systemd simply never wrote
// the row, so unifying on the bridge would have DELETED Colemak from Settings.
//
// It cuts the other way too. Two rows systemd still carries — `ro(cedilla)` and
// `ro(std_cedilla)` — no longer exist in xkb at all: `symbols/ro` renamed them to
// `comma`/`std_comma`. The installer was offering two keyboards that would not
// have applied to the graphical session either.
//
// So the catalogue is **xkb**, which is the namespace both surfaces actually set,
// and the console keymap is a PROPERTY joined onto it. One derivation, two
// scopes, and each surface takes the slice its own question needs:
//
//   Settings   → allKeyboards()      — it writes Hyprland's `input:kb_layout`
//                                      and nothing else, so it cannot lock
//                                      anybody out of anything and has no reason
//                                      to withhold a layout.
//   installer  → bridgedKeyboards()  — it also writes /etc/vconsole.conf, so it
//                                      offers what systemd knows how to say in
//                                      BOTH namespaces.
//
// The two are not two lists. `bridged` is a field, and the second call is the
// first one filtered.
//
// Four files on every Arch system carry all of it, and nobody here maintains them:
//
//   /usr/share/X11/xkb/rules/base.lst   99 layouts + 499 variants = 598
//   /usr/share/systemd/kbd-model-map    the console↔xkb bridge, 60 rows
//   /usr/share/kbd/keymaps/…            252 console keymaps that exist
//
// ⚠️ The two tiny file readers below are a deliberate second copy of the ones in
// `ui/installer/lib/region.ts`. They read system data tables and never throw,
// which is a different contract from `ui/lib/file.ts` (config, and it throws);
// sharing them would have made the installer's country parser import the keyboard
// module for six lines.

import GLib from "gi://GLib"
import { keyboardName } from "./locale-names"

function readLines(path: string): string[] {
  try {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return []
    const [ok, data] = GLib.file_get_contents(path)
    if (!ok) return []
    return new TextDecoder().decode(data as Uint8Array).split("\n")
  } catch {
    return []
  }
}

/** Data rows only: `#` comments and blank lines are never rows in these files. */
function dataLines(path: string): string[] {
  return readLines(path)
    .map(l => l.replace(/\r$/, ""))
    .filter(l => l.length > 0 && !l.startsWith("#"))
}

export interface KeyboardLayout {
  /**
   * The name this keyboard has everywhere the product writes one down: `us`,
   * `us-colemak`, `de-nodeadkeys`. Layout, then `-`, then the variant.
   *
   * 🔑 Unambiguous because **no xkb layout code contains a hyphen** (checked: 0 of
   * 99), so the id splits at the FIRST one and a variant may keep its own —
   * `us-dvorak-alt-intl` is `us` + `dvorak-alt-intl`.
   *
   * ⚠️ It deliberately does not reuse the console keymap's spelling. `cz-qwerty`
   * as an id means the xkb variant; as a keymap name it means a file `kbd` does
   * not ship (#472). Same string, two namespaces, and that overlap is what cost
   * us that bug — so the id appears in labels and configs, the keymap only ever
   * in `/etc/vconsole.conf`.
   */
  id: string
  /** xkb layout — Hyprland, and what the installer applies to the live session. */
  layout: string
  /** xkb variant, or "". */
  variant: string
  /**
   * Console keymap — /etc/vconsole.conf, the TTY, the initramfs LUKS prompt.
   *
   * ⚠️ **`""` for most of the catalogue**, and that is not a defect: only the
   * bridged 58 have one at all, and three of those name a file `kbd` does not
   * ship. Writing a name that cannot load leaves the console silently unset
   * (#472), so `""` is the honest value and the installer keeps the medium's
   * `us` when it sees one.
   */
  keymap: string
  /**
   * systemd names a console keymap for this keyboard — i.e. `kbd-model-map` has
   * a row for it. It is what the installer offers, and it is NOT the same
   * question as `keymap !== ""`: three bridged rows resolve to no keymap at all.
   */
  bridged: boolean
  /** BCP-47 tags this keyboard serves, from the bridge. Empty for the rest. */
  langs: string[]
  /**
   * Human label: the ENDONYM of the language the layout serves — "español de
   * España", "British English" — falling back to xkb's English description, which
   * is what the 540 unbridged ones get since only the bridge carries languages.
   *
   * ⚠️ It used to be xkb's description unconditionally, which showed "Spanish" to
   * somebody running the installer in Spanish. See ui/lib/locale-names.ts for why
   * the fix is an endonym and not a translation.
   */
  label: string
}

/** `us` / `us-colemak` — see `KeyboardLayout.id`. */
export function keyboardId(layout: string, variant: string): string {
  return variant ? `${layout}-${variant}` : layout
}

/** The inverse, splitting at the FIRST hyphen because variants keep their own. */
export function parseKeyboardId(id: string): { layout: string, variant: string } {
  const i = id.indexOf("-")
  return i < 0 ? { layout: id, variant: "" } : { layout: id.slice(0, i), variant: id.slice(i + 1) }
}

// ── xkb: the catalogue ───────────────────────────────────────────────────────

let _xkb: Map<string, string> | null = null

/**
 * Every keyboard xkb describes, keyed by id → English description.
 *
 * `base.lst` holds two sections we need. `! layout` is `code  description`;
 * `! variant` is `code  layout: description`, so the variant rows are what turn
 * 99 layouts into 598 keyboards.
 */
function xkbCatalogue(): Map<string, string> {
  if (_xkb) return _xkb
  const map = new Map<string, string>()
  let section = ""
  for (const line of readLines("/usr/share/X11/xkb/rules/base.lst")) {
    if (line.startsWith("!")) {
      section = line.trim()
      continue
    }
    const m = /^\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    if (section === "! layout") {
      // ⛔ `custom` is xkb's escape hatch for a layout the user writes themselves
      // into ~/.config/xkb, not a keyboard. Alphabetically it is the FIRST thing
      // in the catalogue, so leaving it in made "A user-defined custom Layout"
      // the opening line of the list — an answer to a question nobody asked, and
      // one that does nothing at all unless that file already exists.
      if (m[1] !== "custom") map.set(m[1], m[2])
    } else if (section === "! variant") {
      const v = /^(\S+):\s*(.*)$/.exec(m[2])
      if (v) map.set(keyboardId(v[1], m[1]), v[2])
    }
  }
  _xkb = map
  return map
}

// ── kbd: which console keymaps actually exist ────────────────────────────────

/**
 * Where `kbd` keeps console keymaps — the same three trees systemd walks for
 * `localectl list-keymaps`, which is why walking them here returns the identical
 * set (252 names, diffed against `localectl`) without a subprocess.
 */
const KEYMAP_DIRS = ["/usr/share/keymaps", "/usr/share/kbd/keymaps", "/usr/lib/kbd/keymaps"]

let _keymaps: Set<string> | null = null

/** Every console keymap this machine can load, named as vconsole.conf names it. */
function availableKeymaps(): Set<string> {
  if (_keymaps) return _keymaps
  const out = new Set<string>()
  // ⚠️ Symlinks are keymaps too: `sr-latin` is one, and a walk that only counted
  // regular files came back with 251 names against localectl's 252. GLib.Dir does
  // not distinguish them, which is what we want — the depth cap is what guards
  // against a symlinked directory loop.
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return
    if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) return
    try {
      const d = GLib.Dir.open(dir, 0)
      let name: string | null
      while ((name = d.read_name()) !== null) {
        const path = `${dir}/${name}`
        if (GLib.file_test(path, GLib.FileTest.IS_DIR)) {
          walk(path, depth + 1)
          continue
        }
        const m = /^(.+)\.map(\.gz)?$/.exec(name)
        if (m) out.add(m[1])
      }
      d.close()
    } catch {}
  }
  for (const root of KEYMAP_DIRS) walk(root, 0)
  _keymaps = out
  return out
}

/** A keymap name reduced to its parts, order and separator thrown away. */
const keymapTokens = (name: string): string =>
  name.replace(/_/g, "-").split("-").filter(Boolean).sort().join(" ")

let _byTokens: Map<string, string[]> | null = null

function keymapsByTokens(): Map<string, string[]> {
  if (_byTokens) return _byTokens
  const map = new Map<string, string[]>()
  for (const k of availableKeymaps()) {
    const t = keymapTokens(k)
    const list = map.get(t)
    if (list) list.push(k)
    else map.set(t, [k])
  }
  _byTokens = map
  return map
}

/**
 * The console keymap for one keyboard, or `""` when this system has none.
 *
 * kbd-model-map is systemd's file and `kbd` is a different project, so eight of
 * the names it hands us are not keymaps here (#472). Nothing downstream notices:
 * archinstall validates, logs, returns False — and its only caller ignores the
 * return value — so the install SUCCEEDS and the console is left unset, i.e. `us`.
 * With disk encryption that console is the LUKS prompt, so the name has to be
 * checked here, where the list is built and a wrong one can still be dropped.
 *
 * Two rules, both derived, neither one a table of names to keep in sync:
 *
 *  1. **Another row for the same keyboard.** kbd-model-map lists several console
 *     keymaps per xkb layout; if the first one is not on disk, a later row for the
 *     same layout+variant may be (`cz-qwerty` → `cz-lat2`).
 *  2. **The same parts, spelled differently.** `kbd` and systemd disagree about
 *     order and separator, not about content: `es-dvorak` → `dvorak-es`,
 *     `ro-std` → `ro_std`. Applied ONLY when exactly one keymap carries those
 *     parts, so an ambiguous match can never substitute a different keyboard —
 *     which is the whole risk here, and worse than no keymap at all.
 *
 * What is deliberately NOT a rule: falling back to the layout's plain keymap.
 * `ro` for `ro-cedilla` would be a silent swap of one keyboard for another, and
 * that is the class of failure this function exists to end, not to automate.
 *
 * ⚠️ Nor is matching by NAME across the two namespaces, which looks like the
 * obvious way to widen the bridge and is not. Measured 2026-09-07: it rescues 64
 * pairs and gets them wrong — Arabic (AZERTY) lands on the French `azerty`
 * keymap, Polish (British keyboard) on `pl`. Same failure, dressed as a feature.
 */
function resolveKeymap(candidates: string[]): string {
  const have = availableKeymaps()
  const exact = candidates.find(k => have.has(k))
  if (exact) return exact
  for (const k of candidates) {
    const same = keymapsByTokens().get(keymapTokens(k))
    if (same && same.length === 1) return same[0]
  }
  return ""
}

// ── The bridge, read once ────────────────────────────────────────────────────

interface BridgeRow { keymaps: string[], langs: string[] }

let _bridge: Map<string, BridgeRow> | null = null

/**
 * `kbd-model-map`, grouped by keyboard id.
 *
 * ⚠️ Rows whose xkb column names several layouts (`mk,us`) are multi-layout
 * console setups; we take the first, because we set ONE layout and a comma would
 * be written into the config verbatim. **The variant column is the same list,
 * positionally**, so it is cut the same way: two rows carry `,phonetic` and
 * `qwerty,`, and reading those whole produced a keyboard called "bg, ,phonetic"
 * and a second, broken Czech next to the working one (#472).
 *
 * Every keymap for an id is kept, in file order, because when the first one is
 * missing a later one may exist.
 */
function bridge(): Map<string, BridgeRow> {
  if (_bridge) return _bridge
  const map = new Map<string, BridgeRow>()
  for (const line of dataLines("/usr/share/systemd/kbd-model-map")) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    const id = keyboardId(cols[1].split(",")[0], cols[3] === "-" ? "" : cols[3].split(",")[0])
    const row = map.get(id)
    if (row) {
      row.keymaps.push(cols[0])
      continue
    }
    map.set(id, {
      keymaps: [cols[0]],
      langs: (cols[5] && cols[5] !== "-") ? cols[5].split(",") : [],
    })
  }
  _bridge = map
  return map
}

// ── The catalogue itself ─────────────────────────────────────────────────────

let _all: KeyboardLayout[] | null = null

/**
 * Every keyboard xkb describes, sorted by label — the whole catalogue, 598 of
 * them, each carrying whatever the console bridge could say about it.
 *
 * This is what Settings offers: it writes the xkb layout and nothing else, so
 * there is no keyboard it has a reason to withhold.
 */
export function allKeyboards(): KeyboardLayout[] {
  if (_all) return _all
  const br = bridge()
  const out: KeyboardLayout[] = []
  for (const [id, desc] of xkbCatalogue()) {
    const { layout, variant } = parseKeyboardId(id)
    const row = br.get(id)
    // ⚠️ The layout CODE is part of the label, not decoration. Naming a keyboard
    // by the language it serves makes it read the same as the locale row right
    // above it — "español de España" twice, for two different questions — which
    // was only visible with the page open. The code is also the thing that
    // actually gets written, so it earns its place.
    //
    // Separated by a middot rather than wrapped in brackets, because half the
    // endonyms already carry their own: "日本語 (日本) (jp)" and
    // "português (Brasil) (br)" were the first attempt. `·` is what the disk step
    // already uses between facts about one thing.
    const base = keyboardName(row?.langs ?? [], desc)
    out.push({
      id,
      layout,
      variant,
      keymap: row ? resolveKeymap(row.keymaps) : "",
      bridged: !!row,
      langs: row?.langs ?? [],
      label: `${base} · ${id}`,
    })
  }
  _all = out.sort((a, b) => a.label.localeCompare(b.label))
  return _all
}

/**
 * The keyboards systemd knows how to name in BOTH namespaces — what the
 * installer offers, because it writes `/etc/vconsole.conf` as well.
 *
 * ⚠️ 58, not the bridge's 60: `ro(cedilla)` and `ro(std_cedilla)` are rows systemd
 * still carries for variants xkb no longer has (`symbols/ro` renamed them to
 * `comma`/`std_comma`), so they are not in the catalogue and were never going to
 * apply to the graphical session either.
 */
export function bridgedKeyboards(): KeyboardLayout[] {
  return allKeyboards().filter(k => k.bridged)
}

/** One keyboard by id, or undefined — the id is `us` / `us-colemak`. */
export function keyboardById(id: string): KeyboardLayout | undefined {
  return allKeyboards().find(k => k.id === id)
}
