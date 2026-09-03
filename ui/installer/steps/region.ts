// Step 2 — where you are: country, and the three answers it narrows.
//
// This replaces three separate steps (language, keyboard, timezone) that were the
// same widget three times over a hand-written slice of the real data. They are one
// question in the person's head — "where am I" — and they were three pages because
// they are three fields in archinstall's config, which is our problem and not theirs.
//
// ⚠️ The fold is NOT because the live session already knows. It does not, and it
// cannot: the ISO generates `en_US.UTF-8` and nothing else, symlinks /etc/localtime
// to UTC and defaults Hyprland to `us`, so the three "detected" values are three
// constants. The page has to ASK, and the point of asking for the country first is
// that one answer narrows all three — Britain to one timezone and `en_GB`,
// Argentina to `es_AR`, Brazil to sixteen zones that still have to be chosen from.
//
// ⚠️ There is deliberately no separate "interface language" question. The shell
// picks its language by reading LANG (core/i18n/index.ts), so choosing the system
// locale already decides what the installed desktop speaks; asking twice would let
// the two disagree. The installer switches its own text the same way, below.
//
// ⚠️ Nor is there a separate "regional format" question, and that is NOT the
// installer disagreeing with Settings, which does keep the two apart:
//
//   Language        → /etc/locale.conf, LANG            — system-wide
//   Regional format → ~/.config/environment.d/…, LC_*   — this user only
//
// The installer writes only LANG (through archinstall's `locale_config.sys_lang`),
// so the seven LC_* variables in core/RegionConfig.ts fall back to it — which is
// exactly `regionalLocale: ""`, the value Settings shows as **"Same as language"**
// and ships as its DEFAULT. A machine installed here lands in Settings' own
// default state, and splitting them is one control away for the person who wants
// German dates under a Spanish desktop.
//
// So the row is labelled "Language", not "Language and formats". Asking twice
// would put a second question on a page we just folded down from three, to offer
// a default that is already the default.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { execAsync } from "../../lib/process"
import { NidaraList, NidaraRow, NidaraDropDownRow } from "../../lib/nidara-kit"
import { t, setLocale, getLocale } from "../lib/i18n"
import {
  getAnswers, setCountryAnswer, setKeyboardAnswer, setTimezoneAnswer,
} from "../lib/answers"
import {
  countries, timezonesFor, allTimezones, localeFor,
  keyboardsFor, allKeyboards, defaultsFor,
  type Country, type KeyboardLayout,
} from "../lib/region"
import { heading, prose, searchableList } from "./common"
import { languageFor } from "../lib/languages"
import { setLanguageAnswer } from "../lib/answers"
import { countryName, countryHaystack, timezoneName } from "../../lib/locale-names"
import { isPreview } from "../lib/preview"

/**
 * ⚠️ This is the installer reaching into the session it is RUNNING IN, not into
 * the system it is installing — which is exactly right on the live medium (you
 * should be able to test the layout you just picked) and unacceptable on
 * somebody's desktop, where it would change the keyboard they are typing on.
 */
function applyKeyboardLive(k: KeyboardLayout) {
  if (isPreview()) return
  execAsync(["hyprctl", "keyword", "input:kb_layout", k.layout]).catch(() => {})
  execAsync(["hyprctl", "keyword", "input:kb_variant", k.variant]).catch(() => {})
}

/**
 * Everything a country ANSWERS — the country itself, the territory it lends the
 * language, and the timezone and keyboard it settles.
 *
 * ⚠️ It lives out here, away from the widgets, because there were two ways to
 * choose a country and only one of them was complete. `onEnter` used to seed the
 * country alone from the language's territory, and the page then showed España
 * ticked, an empty card where the timezone and keyboard rows belong, and Continue
 * greyed out — `ready()` wants all four answers — until you clicked the country
 * that was already ticked. A default that cannot be accepted is worse than no
 * default: it looks like the page is broken, and it looks that way to everybody
 * whose language carries a territory, which after the welcome page's seed is
 * nearly everybody.
 *
 * What it deliberately does NOT settle is a country with more than one timezone:
 * `defaultsFor` returns null there, the row says "Choose…" and Continue waits.
 * That is the one question this page is entitled to hold the flow for.
 *
 * Returns the keyboard it settled, if any, so the caller can decide whether to
 * apply it to the running session.
 */
function answerCountry(c: Country): KeyboardLayout | null {
  setCountryAnswer({ code: c.code, name: c.name })

  // Only what the data says unambiguously; the rest stays open and the dropdown
  // says "Choose…". See lib/region.ts — null is the useful answer.
  //
  // ⚠️ The LANGUAGE is not overwritten. It was asked on the welcome page, before
  // this one, and a country arriving later must not undo it — somebody living in
  // Germany with a Spanish desktop is not a bug. The country supplies the
  // TERRITORY the language was missing: `es` + AR → es_AR. When glibc has no
  // locale for the pair (Spanish in Japan) the language keeps its own default,
  // which is the honest outcome rather than an invented one.
  const a = getAnswers()
  if (a.language) {
    const lang = languageFor(a.language.locale)
    const refined = localeFor(lang.lang, c.code)
    if (refined) {
      const [sysLang, sysEnc] = refined.split(".")
      setLanguageAnswer({ locale: refined, sysLang, sysEnc, label: a.language.label })
    }
  }

  const d = defaultsFor(c.code)
  if (d.timezone) setTimezoneAnswer({ timezone: d.timezone })
  if (!d.keyboard) return null
  const k = d.keyboard
  setKeyboardAnswer({ layout: k.layout, variant: k.variant, keymap: k.keymap, label: k.label })
  return k
}

/** The country's own options first, then everything else — never a truncated list. */
function scoped<T>(own: T[], all: T[], key: (x: T) => string): T[] {
  const seen = new Set(own.map(key))
  return [...own, ...all.filter(x => !seen.has(key(x)))]
}

export function RegionStep(): Step {
  return {
    id: "region",
    title: () => t("regionTitle"),
    nextLabel: () => t("continue"),

    // All four, because a country alone is not an installable answer and the three
    // it narrows are exactly the ones it may leave open. Brazil fills in the locale
    // and the keyboard and leaves sixteen timezones; the page says so and Continue
    // waits.
    ready: () => {
      const a = getAnswers()
      return a.country !== null && a.language !== null && a.keyboard !== null && a.timezone !== null
    },

    // The language chosen on the welcome page carries a TERRITORY, and it is a
    // better first guess at the country than nothing: es_AR means Argentina.
    // Only a suggestion, and only when nothing has been chosen — walking back to
    // change the language must not silently move a country somebody picked.
    //
    // ⚠️ Deliberately NOT seeded from the medium's own en_US, which would suggest
    // the United States to every person on earth who has not answered yet. The
    // welcome page sets that locale as its default; a default is not an answer.
    onEnter() {
      const a = getAnswers()
      if (a.country || !a.language || a.language.locale === "en_US.UTF-8") return
      const territory = /^[a-z]+_([A-Z]+)/.exec(a.language.locale)?.[1]
      if (!territory) return
      const c = countries().find(x => x.code === territory)
      if (!c) return
      const k = answerCountry(c)
      if (k) applyKeyboardLive(k)
    },

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
        // The page FILLS the pane, so that the one vexpanding thing on it — the
        // country list — is the one that receives whatever the window has spare.
        vexpand: true,
      })

      box.append(heading(t("regionHeading")))
      box.append(prose(t("regionProse")))

      // ── The country ────────────────────────────────────────────────────────
      // Named in the READER's language and sorted in it — tzdata's own order is
      // alphabetical by its ENGLISH spelling, which is not an ordering of the list
      // anybody is looking at. `build()` re-runs on every language change
      // (Flow.invalidate), so both follow the UI.
      const ui = getLocale()
      let selectedCode = getAnswers().country?.code ?? null

      // Chosen country first, for the same reason the language list does it: a
      // list of 249 should not have to be scrolled to show what is already picked.
      const all = countries()
        .map(c => ({ c, label: countryName(c.code, ui, c.name) }))
        .sort((a, b) => a.label.localeCompare(b.label, ui))
      const picked = all.filter(x => x.c.code === selectedCode)
      const named = [...picked, ...all.filter(x => x.c.code !== selectedCode)]

      const list = searchableList({
        placeholder: t("regionCountryPlaceholder"),
        items: named,
        row: ({ c, label }, check) => NidaraRow(label, c.code, check),
        // The reader's name, tzdata's English one AND the code — not just what is
        // on screen. Matching only the display name is how the English list came
        // to be unfindable by typing "España"; matching only English is the same
        // bug facing the other way.
        haystack: ({ c }) => countryHaystack(c.code, ui, c.name),
        isSelected: ({ c }) => c.code === selectedCode,
        onActivate: ({ c }) => selectCountry(c),
      })
      box.append(list.widget)

      // ── What the country narrows ───────────────────────────────────────────
      // Rebuilt whole on every country change: NidaraDropDownRow takes its model at
      // construction, and three rows is cheaper to rebuild than to keep in sync.
      const derived = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, hexpand: true })
      box.append(derived)

      const rebuildDerived = () => {
        let child = derived.get_first_child()
        while (child) { const n = child.get_next_sibling(); derived.remove(child); child = n }
        if (!selectedCode) return

        const code = selectedCode
        const a = getAnswers()
        const { box: card, listBox } = NidaraList()

        // Timezone ────────────────────────────────────────────────────────────
        const tzs = scoped(timezonesFor(code), allTimezones(), x => x)
        // The IANA name, unchanged — the same thing Settings lists. This used to
        // render "Madrid — Europe", a format only this screen spoke.
        const tzLabels = tzs.map(timezoneName)
        const tzCurrent = a.timezone?.timezone ?? null
        listBox.append(NidaraDropDownRow(
          t("regionTimezone"),
          "",
          tzCurrent ? tzLabels[tzs.indexOf(tzCurrent)] ?? tzCurrent : t("regionAsk"),
          tzCurrent ? tzLabels : [t("regionAsk"), ...tzLabels],
          (_v, i) => {
            const idx = tzCurrent ? i! : i! - 1
            const tz = tzs[idx]
            if (!tz) return
            setTimezoneAnswer({ timezone: tz })
            notifyReady?.()
          },
        ))

        // Keyboard ────────────────────────────────────────────────────────────
        const kbs = scoped(keyboardsFor(code), allKeyboards(), k => `${k.layout}:${k.variant}`)
        const kbLabels = kbs.map(k => k.label)
        const kbCurrent = a.keyboard
          ? kbs.findIndex(k => k.layout === a.keyboard!.layout && k.variant === a.keyboard!.variant)
          : -1
        listBox.append(NidaraDropDownRow(
          t("regionKeyboard"),
          "",
          kbCurrent >= 0 ? kbLabels[kbCurrent] : t("regionAsk"),
          kbCurrent >= 0 ? kbLabels : [t("regionAsk"), ...kbLabels],
          (_v, i) => {
            const idx = kbCurrent >= 0 ? i! : i! - 1
            const k = kbs[idx]
            if (!k) return
            setKeyboardAnswer({ layout: k.layout, variant: k.variant, keymap: k.keymap, label: k.label })
            applyKeyboardLive(k)
            notifyReady?.()
          },
        ))

        derived.append(card)

        // The test box lives with the keyboard row, and only appears once there is
        // a keyboard to test: an empty field under a question nobody answered is
        // furniture.
        const testCard = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          css_classes: ["nidara-list-card"],
        })
        testCard.append(new Gtk.Entry({
          placeholder_text: t("keyboardTestPlaceholder"),
          css_classes: ["installer-keyboard-test"],
          hexpand: true,
        }))
        derived.append(testCard)
      }

      function selectCountry(c: Country) {
        selectedCode = c.code
        const k = answerCountry(c)
        if (k) applyKeyboardLive(k)
        list.repaint()
        rebuildDerived()
        notifyReady?.()
      }

      // The card the country narrows is built HERE too, not only on a click: a
      // country can already be answered when the page opens (seeded from the
      // language's territory, or walked back to), and a page that draws the tick
      // but not what the tick decided is a page that looks half-loaded.
      rebuildDerived()

      return box
    },
  }
}
