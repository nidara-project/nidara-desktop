// Where you are, read off the system rather than typed out by hand.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The installer used to carry three hand-written lists: 12 locales, 16 keyboard
// layouts, 26 timezones. Each was a curated slice of something much larger, with
// no way out of the slice — somebody in Asia/Kolkata could not pick their own
// timezone, and there was no "other". And nothing on the live medium can fill
// them in for you: the ISO generates `en_US.UTF-8` and nothing else, symlinks
// /etc/localtime to UTC and defaults Hyprland to `us`, so the three "detected"
// answers are three constants.
//
// So the honest thing is to ask well, from the complete data — which is already
// on every Arch system, in four files nobody has to maintain:
//
//   /usr/share/zoneinfo/iso3166.tab   249 countries, code → name        (tzdata)
//   /usr/share/zoneinfo/zone1970.tab  312 zones, each tied to countries (tzdata)
//   /usr/share/i18n/SUPPORTED         502 locales glibc can generate    (glibc)
//   /usr/share/systemd/kbd-model-map  72 keyboards, keymap ↔ xkb ↔ lang (systemd)
//
// ⚠️ `zone1970.tab` is 312 rows while `timedatectl list-timezones` is 598. The
// difference is backward-compatibility aliases (America/Buenos_Aires for
// America/Argentina/Buenos_Aires, and so on). The curated table is the one an
// installer should offer: every row is a real, current zone AND says which
// countries it belongs to, which is what lets a country answer the question.
//
// ⚠️ `kbd-model-map` is why the keyboard list is not hand-written any more. It is
// the canonical bridge between the CONSOLE keymap (/etc/vconsole.conf, the TTY,
// and the LUKS prompt) and the XKB layout (Hyprland, this session) — two
// namespaces with overlapping names that disagree for four of the layouts we
// used to offer. See references/dev-workflow.md.

import GLib from "gi://GLib"

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

/** Data rows only: `#` comments and blank lines are never rows in any of these. */
function dataLines(path: string): string[] {
  return readLines(path)
    .map(l => l.replace(/\r$/, ""))
    .filter(l => l.length > 0 && !l.startsWith("#"))
}

// ── Countries ────────────────────────────────────────────────────────────────

export interface Country {
  /** ISO 3166-1 alpha-2, uppercase — the key every other table joins on. */
  code: string
  name: string
}

let _countries: Country[] | null = null

/** The 249 countries tzdata knows, sorted by name. */
export function countries(): Country[] {
  if (_countries) return _countries
  const out: Country[] = []
  for (const line of dataLines("/usr/share/zoneinfo/iso3166.tab")) {
    const [code, name] = line.split("\t")
    if (code && name) out.push({ code: code.trim(), name: name.trim() })
  }
  _countries = out.sort((a, b) => a.name.localeCompare(b.name))
  return _countries
}

// ── Timezones ────────────────────────────────────────────────────────────────

interface ZoneRow {
  /** Every country this zone serves — a zone can belong to several. */
  codes: string[]
  tz: string
}

let _zones: ZoneRow[] | null = null

function zoneRows(): ZoneRow[] {
  if (_zones) return _zones
  const out: ZoneRow[] = []
  for (const line of dataLines("/usr/share/zoneinfo/zone1970.tab")) {
    const cols = line.split("\t")
    // codes \t coordinates \t TZ \t comments(optional)
    if (cols.length < 3) continue
    const codes = cols[0].split(",").map(c => c.trim()).filter(Boolean)
    const tz = cols[2].trim()
    if (tz) out.push({ codes, tz })
  }
  _zones = out
  return _zones
}

/** Every timezone, sorted — the escape hatch when a country has none listed. */
export function allTimezones(): string[] {
  return [...new Set(zoneRows().map(z => z.tz))].sort()
}

/**
 * The timezones of one country, in tzdata's own order.
 *
 * ⚠️ That order is NOT by population and `[0]` is NOT a default. Measured: Brazil
 * begins America/Noronha (an island of ~3 000 people) and São Paulo is further
 * down; the United States begins New York out of 29. A country with more than one
 * zone has to be asked, which is what every installer that shows you a map is
 * doing. `defaultsFor` only fills this in when there is exactly one.
 */
export function timezonesFor(code: string): string[] {
  const c = code.toUpperCase()
  return zoneRows().filter(z => z.codes.includes(c)).map(z => z.tz)
}

// ── Locales ──────────────────────────────────────────────────────────────────

let _locales: string[] | null = null

/**
 * Every UTF-8 locale glibc can generate, normalised to the `xx_YY.UTF-8` form
 * that goes in LANG.
 *
 * ⚠️ SUPPORTED writes the same thing two ways: `es_ES.UTF-8 UTF-8` and, for
 * locales with no legacy charset, `aa_ER UTF-8` — name without the suffix. Both
 * mean a UTF-8 locale; only the second needs the suffix added. Filtering on the
 * literal string ".UTF-8" in the name silently loses ~90 languages.
 */
export function allLocales(): string[] {
  if (_locales) return _locales
  const out = new Set<string>()
  for (const line of dataLines("/usr/share/i18n/SUPPORTED")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const [name, charset] = parts
    if (charset.toUpperCase() !== "UTF-8") continue
    out.add(name.includes(".") ? name : `${name}.UTF-8`)
  }
  _locales = [...out].sort()
  return _locales
}

/**
 * The locales whose territory is this country, likeliest first.
 *
 * ⚠️ Alphabetical order is actively misleading here and was shipped once: sorted
 * by code, Spain begins `an_ES` (Aragonese), Brazil `hrx_BR` (Hunsrik), the United
 * States `chr_US` (Cherokee) and the United Kingdom `cy_GB` (Welsh). Every one of
 * those is a real locale of that country and none is the answer. `primaryLocaleFor`
 * is what puts a plausible row first; the rest stay, sorted, underneath.
 */
export function localesFor(code: string): string[] {
  const c = code.toUpperCase()
  const all = allLocales().filter(l => /^[a-z]+_([A-Z]+)/.exec(l)?.[1] === c)
  const primary = primaryLocaleFor(code)
  if (!primary) return all
  return [primary, ...all.filter(l => l !== primary)]
}

/**
 * The locale a country most likely wants, or null when nothing on the system says.
 *
 * There is no country → language table in glibc or tzdata. What there IS is
 * systemd's keyboard map, whose BCP-47 column was curated for exactly this kind of
 * question: `es → es-ES,es`, `br-abnt2 → pt-BR`, `uk → en-GB`, `sg → de-CH`. It
 * covers 54 of the 249 countries, which is most of the ones anybody installs on;
 * a country with a single locale answers itself; and the remainder get **null**
 * rather than a guess, because the page can ask and a wrong preselection is a
 * system installed in Cherokee by somebody who never noticed the row.
 *
 * (Anaconda and Ubiquity solve this with `langtable`, a data package we would have
 * to carry and keep in step. If the null branch ever proves annoying in practice,
 * that is the thing to reach for — not a table of our own invention.)
 */
export function primaryLocaleFor(code: string): string | null {
  const c = code.toUpperCase()
  const all = allLocales()
  for (const kb of keyboardsFor(code)) {
    for (const tag of kb.langs) {
      const [lang, region] = tag.split("-")
      if (!region || region.toUpperCase() !== c) continue
      const candidate = `${lang}_${c}.UTF-8`
      if (all.includes(candidate)) return candidate
    }
  }
  const own = all.filter(l => /^[a-z]+_([A-Z]+)/.exec(l)?.[1] === c)
  return own.length === 1 ? own[0] : null
}

// ── Keyboards ────────────────────────────────────────────────────────────────

export interface KeyboardLayout {
  /** Console keymap — /etc/vconsole.conf, the TTY, the initramfs LUKS prompt. */
  keymap: string
  /** xkb layout — Hyprland, and what we apply to the live session. */
  layout: string
  /** xkb variant, or "" — kbd-model-map writes an absent one as "-". */
  variant: string
  /** BCP-47 tags this keyboard serves, e.g. ["es-419","es-MX",…]. May be empty. */
  langs: string[]
  /** Human label, from xkb's own description of the layout. */
  label: string
}

let _xkbNames: Map<string, string> | null = null

/** xkb layout code → English description, from `base.lst`'s `! layout` section. */
function xkbDescriptions(): Map<string, string> {
  if (_xkbNames) return _xkbNames
  const map = new Map<string, string>()
  let inLayouts = false
  for (const line of readLines("/usr/share/X11/xkb/rules/base.lst")) {
    if (line.startsWith("!")) {
      inLayouts = line.trim() === "! layout"
      continue
    }
    if (!inLayouts) continue
    const m = /^\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (m) map.set(m[1], m[2])
  }
  _xkbNames = map
  return map
}

let _keyboards: KeyboardLayout[] | null = null

/**
 * Every keyboard systemd knows how to describe in both namespaces, sorted by label.
 *
 * ⚠️ Rows whose xkb column names several layouts (`mk,us`) are multi-layout
 * console setups; we take the first, because the installer sets ONE layout and a
 * comma would be written into the config verbatim.
 */
export function allKeyboards(): KeyboardLayout[] {
  if (_keyboards) return _keyboards
  const desc = xkbDescriptions()
  const seen = new Set<string>()
  const out: KeyboardLayout[] = []
  for (const line of dataLines("/usr/share/systemd/kbd-model-map")) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    const keymap = cols[0]
    const layout = cols[1].split(",")[0]
    const variant = cols[3] === "-" ? "" : cols[3]
    const langs = (cols[5] && cols[5] !== "-") ? cols[5].split(",") : []
    const key = `${layout}:${variant}`
    // kbd-model-map has several console keymaps per xkb layout (de, de-latin1,
    // de-latin1-nodeadkeys …). The list is of KEYBOARDS, not of keymap files, so
    // the first row for a layout+variant wins — and it is the one whose console
    // keymap is the plain name, which is what the file lists first.
    if (seen.has(key)) continue
    seen.add(key)
    const base = desc.get(layout) ?? layout
    out.push({
      keymap, layout, variant, langs,
      label: variant ? `${base} — ${variant}` : base,
    })
  }
  _keyboards = out.sort((a, b) => a.label.localeCompare(b.label))
  return _keyboards
}

/**
 * The keyboards that serve a country, best first.
 *
 * Matched through kbd-model-map's BCP-47 column (`es-419,es-MX,…`), whose region
 * subtag is the country — which is why this is read off a file instead of guessed
 * from the layout code. The guess would be close (`es`→ES, `fr`→FR) and wrong
 * exactly where it matters: `gb` for GB, `latam` for a dozen countries whose code
 * appears nowhere in the layout name.
 */
export function keyboardsFor(code: string): KeyboardLayout[] {
  const c = code.toUpperCase()
  return allKeyboards().filter(k => k.langs.some(t => t.split("-")[1]?.toUpperCase() === c))
}

// ── The one question that answers the others ─────────────────────────────────

export interface RegionDefaults {
  timezone: string | null
  locale: string | null
  keyboard: KeyboardLayout | null
}

/**
 * What choosing a country implies. A country NARROWS the three questions; it does
 * not answer them, and each field is filled in only when the data is unambiguous:
 *
 *   timezone — exactly one zone, because tzdata's order is not a ranking
 *   locale   — see primaryLocaleFor: a curated tag, or the country's only locale
 *   keyboard — exactly one, since Switzerland alone offers `ch` and `ch/fr`
 *
 * ⚠️ **null is the useful answer, not a failure.** A page that shows the country's
 * three zones and waits has asked a small question; a page that silently picked
 * one of them has answered a different question than the user did.
 */
export function defaultsFor(code: string): RegionDefaults {
  const zones = timezonesFor(code)
  const keyboards = keyboardsFor(code)
  return {
    timezone: zones.length === 1 ? zones[0] : null,
    locale: primaryLocaleFor(code),
    keyboard: keyboards.length === 1 ? keyboards[0] : null,
  }
}
