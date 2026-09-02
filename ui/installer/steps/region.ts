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
import { NidaraList, NidaraRow, NidaraDropDownRow, NidaraSelectionCheck, NidaraScrolled } from "../../lib/nidara-kit"
import { t, setLocale, getLocale, type Locale } from "../lib/i18n"
import {
  getAnswers, setCountryAnswer, setLanguageAnswer, setKeyboardAnswer, setTimezoneAnswer,
} from "../lib/answers"
import {
  countries, timezonesFor, allTimezones, localesFor, allLocales,
  keyboardsFor, allKeyboards, defaultsFor,
  type Country, type KeyboardLayout,
} from "../lib/region"
import { heading, prose } from "./common"
import { countryName, countryHaystack, languageName, timezoneName } from "../../lib/locale-names"
import { isPreview } from "../lib/preview"

/**
 * Kept as a named re-export because the probe and the page both import it, and
 * the naming itself now lives in ui/lib/locale-names.ts where the greeter and
 * Settings can reach it too.
 */
export const localeLabel = languageName

/**
 * Which of the twelve translations the installer should wear, given the system
 * locale the user just chose. Anything we do not speak falls to English — the same
 * chain as the shell's `detectLanguage` and the greeter's `detectLocale`, and it
 * has to stay the same chain or the installer and the desktop it installs would
 * disagree about what "pt" means.
 */
export function uiLocaleFor(sysLocale: string): Locale {
  const l = sysLocale.toLowerCase()
  if (l.startsWith("pt_br")) return "pt-BR"
  if (l.startsWith("pt")) return "pt-PT"
  if (l.startsWith("zh")) return "zh-CN"
  for (const k of ["es", "fr", "de", "it", "pl", "nl", "ru", "ja", "en"] as const) {
    if (l.startsWith(k)) return k
  }
  return "en"
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

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading(t("regionHeading")))
      box.append(prose(t("regionProse")))

      // ── The country ────────────────────────────────────────────────────────
      // A plain Gtk.Entry, not a Gtk.SearchEntry. The installer's sheet styles
      // `entry`, which is the node every other field in this bundle draws on; a
      // SearchEntry draws on `entry.search` with its own icon and clear button,
      // and none of that is styled here — on glass it came out as an unstyled
      // native control with the magnifier jammed against the text.
      const search = new Gtk.Entry({
        placeholder_text: t("regionCountryPlaceholder"),
        hexpand: true,
      })
      box.append(search)

      const { box: countryCard, listBox: countryList } = NidaraList()
      countryList.selection_mode = Gtk.SelectionMode.NONE

      const rowFor = new Map<Gtk.ListBoxRow, Country>()
      const checkFor = new Map<string, Gtk.Widget>()
      let selectedCode = getAnswers().country?.code ?? null

      const paintCountry = () => {
        for (const [row, c] of rowFor) {
          const on = c.code === selectedCode
          row[on ? "add_css_class" : "remove_css_class"]("is-selected")
          const chk = checkFor.get(c.code)
          if (chk) chk.visible = on
        }
      }

      // Named in the READER's language, and sorted in it — tzdata's own order is
      // alphabetical by its English spelling, which is not an ordering of the list
      // anybody is looking at. `build()` re-runs on every language change
      // (Flow.invalidate), so both follow the UI.
      const ui = getLocale()
      const named = countries()
        .map(c => ({ c, label: countryName(c.code, ui, c.name) }))
        .sort((a, b) => a.label.localeCompare(b.label, ui))

      for (const { c, label } of named) {
        const chk = NidaraSelectionCheck(16)
        chk.visible = c.code === selectedCode
        checkFor.set(c.code, chk)
        const row = NidaraRow(label, c.code, chk)
        rowFor.set(row, c)
        countryList.append(row)
      }

      // A filter over rows that already exist, rather than rebuilding 249 of them
      // on every keystroke: the list keeps its selection and its scroll position.
      //
      // ⚠️ It matches the reader's name, tzdata's English one AND the code — not
      // just what is on screen. Matching only the display name is how the English
      // list came to be unfindable by typing "España"; matching only English is
      // the same bug facing the other way.
      countryList.set_filter_func((row) => {
        const c = rowFor.get(row as Gtk.ListBoxRow)
        if (!c) return true
        const q = (search.get_text?.() ?? "").trim().toLowerCase()
        if (!q) return true
        return countryHaystack(c.code, ui, c.name).some(h => h.includes(q))
      })
      search.connect("changed", () => countryList.invalidate_filter())

      // The list TAKES the height that is left, rather than sitting at a fixed
      // 240 with dead space under it: before a country is chosen the page is one
      // question and the list should fill it, and after one is chosen the derived
      // card appears below and the list gives the room back.
      const { widget: countryScroller, scrolled: countryScrolled } = NidaraScrolled({
        child: countryCard,
        minContentHeight: 180,
        propagateNaturalHeight: false,
        reserveLane: false,
      })
      countryScrolled.vexpand = true
      countryScroller.vexpand = true
      box.vexpand = true
      box.append(countryScroller)

      // ── What the country narrows ───────────────────────────────────────────
      // Rebuilt whole on every country change: NidaraDropDownRow takes its model at
      // construction, and three rows is cheaper to rebuild than to keep in sync.
      const derived = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, hexpand: true })
      box.append(derived)

      // ⚠️ This is the installer reaching into the session it is RUNNING IN, not
      // into the system it is installing — which is exactly right on the live
      // medium (you should be able to test the layout you just picked) and
      // unacceptable on somebody's desktop, where clicking a row in a list would
      // change the keyboard they are typing on.
      const applyKeyboardLive = (k: KeyboardLayout) => {
        if (isPreview()) return
        execAsync(["hyprctl", "keyword", "input:kb_layout", k.layout]).catch(() => {})
        execAsync(["hyprctl", "keyword", "input:kb_variant", k.variant]).catch(() => {})
      }

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

        // System locale ───────────────────────────────────────────────────────
        const locs = scoped(localesFor(code), allLocales(), x => x)
        const locLabels = locs.map(localeLabel)
        const locCurrent = a.language?.locale ?? null
        listBox.append(NidaraDropDownRow(
          t("regionFormat"),
          t("regionFormatDesc"),
          locCurrent ? locLabels[locs.indexOf(locCurrent)] ?? locCurrent : t("regionAsk"),
          locCurrent ? locLabels : [t("regionAsk"), ...locLabels],
          (_v, i) => {
            const idx = locCurrent ? i! : i! - 1
            const loc = locs[idx]
            if (!loc) return
            const [sysLang, sysEnc] = loc.split(".")
            setLanguageAnswer({ locale: loc, sysLang, sysEnc: sysEnc || "UTF-8", label: localeLabel(loc) })
            // The installer follows the system locale it was just handed. This is
            // the call that re-translates every page (Flow.invalidate), so it also
            // rebuilds THIS one — which is why nothing below it may touch a widget.
            setLocale(uiLocaleFor(loc))
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

      const selectCountry = (c: Country) => {
        selectedCode = c.code
        setCountryAnswer({ code: c.code, name: c.name })
        paintCountry()

        // Only what the data says unambiguously; the rest stays open and the
        // dropdown says "Choose…". See lib/region.ts — null is the useful answer.
        const d = defaultsFor(c.code)
        if (d.timezone) setTimezoneAnswer({ timezone: d.timezone })
        if (d.locale) {
          const [sysLang, sysEnc] = d.locale.split(".")
          setLanguageAnswer({ locale: d.locale, sysLang, sysEnc: sysEnc || "UTF-8", label: localeLabel(d.locale) })
        }
        if (d.keyboard) {
          const k = d.keyboard
          setKeyboardAnswer({ layout: k.layout, variant: k.variant, keymap: k.keymap, label: k.label })
          applyKeyboardLive(k)
        }

        rebuildDerived()
        notifyReady?.()
      }

      countryList.connect("row-activated", (_l, row) => {
        const c = rowFor.get(row)
        if (c) selectCountry(c)
      })

      paintCountry()
      rebuildDerived()

      // Put the chosen country back under the eye when the page is rebuilt.
      //
      // It matters because rebuilding is now routine: changing the language throws
      // every page away (Flow.invalidate), and coming back to this one showed a
      // list scrolled to Afghanistan with the answer 27 screens down — the page
      // looked unanswered while Continue was lit.
      //
      // ⚠️ Driven off the ADJUSTMENT, not off the row. `translate_coordinates` on
      // an idle returns nothing useful: the row has no allocation until the
      // scroller has laid out, and one idle is too early (measured — the list did
      // not move). The adjustment says when there is content, and the rows are
      // uniform, so the fraction is exact and needs no allocation at all.
      if (selectedCode) {
        const all = named
        const idx = all.findIndex(x => x.c.code === selectedCode)
        const adj = countryScrolled.vadjustment
        const scrollToSelected = (): boolean => {
          if (idx < 0 || !adj || adj.upper <= adj.page_size) return false
          const y = (idx / all.length) * adj.upper - 60
          adj.value = Math.max(0, Math.min(y, adj.upper - adj.page_size))
          return true
        }
        if (adj && !scrollToSelected()) {
          const id = adj.connect("changed", () => {
            if (scrollToSelected()) adj.disconnect(id)
          })
        }
      }

      return box
    },
  }
}
