// Step 1 — welcome, and the first question: the language.
//
// ─── WHY THE LANGUAGE IS HERE AND NOT LATER ──────────────────────────────────
// Researched 2026-09-03 against Calamares, Anaconda, subiquity, GNOME Initial
// Setup and archinstall (~/Dev/nidara-handoff/INFORME-LOCALE.md). Four things in
// that ecosystem are unanimous, and this is the first: **the language is always
// the first question, and the country is never the first screen.**
//
//   calamares/settings.conf:115  sequence: welcome → locale → keyboard → …
//                                where `welcome` IS the language chooser
//   anaconda .../welcome.py:124  `_langView` on the left, `_localeView` — the
//                                territory — as a secondary column beside it
//
// The reason is not taste. **In what language do you print the country names
// before the reader has told you their language?** Our region page asked the
// country first and named the countries in the UI locale, which on the live
// medium is always `en_US` — the ISO generates nothing else. A Japanese user got
// a screen of English country names, or a screen they could not read at all.
//
// So the welcome page stops being prose with a Continue button and asks the one
// question everything after it is printed in. This is GNOME Initial Setup's
// first page and Calamares' welcome module, and it costs no extra step.
//
// ⚠️ ONE language question, not two. What is chosen here is the SYSTEM locale
// (`LANG`), which the shell reads to pick its own language on the installed
// machine — and the installer switches its own text to match, when it speaks it.
// Writing only LANG is the ecosystem's second unanimous rule: `LC_*` inherit from
// it, and separating them belongs in Settings, whose default for that is
// literally "Same as language".

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { readBaseConfig } from "../lib/base-config"
import { t, setLocale } from "../lib/i18n"
import { nidaraLogoIcon } from "../../lib/icons"
import { NidaraRow } from "../../lib/nidara-kit"
import { heading, prose, searchableList } from "./common"
import { connectivity, isUsable } from "../lib/network"
import { LANGUAGES, languageFor } from "../lib/languages"
import { languageName } from "../../lib/locale-names"
import { getAnswers, setLanguageAnswer } from "../lib/answers"

/** What the medium generated, and the only locale it actually has. */
const MEDIUM_LOCALE = "en_US.UTF-8"

export function WelcomeStep(): Step {
  const base = readBaseConfig()

  // Advisory here, enforced in the run step. Warning without blocking is the
  // right shape: the person can walk over to the desktop behind this window,
  // join a network, and come back — and coming back re-runs onEnter, which is
  // the whole reason the check can live on a page instead of in a dialog.
  let netWarn: Gtk.Label | null = null
  let netOk = true

  const refreshNetwork = () => {
    connectivity().then(c => {
      netOk = isUsable(c)
      if (netWarn) netWarn.visible = !netOk
    })
  }

  return {
    id: "welcome",
    title: () => t("welcomeTitle"),
    nextLabel: () => t("continue"),

    // A language is always set, so Continue is live from the first frame: the
    // person who does not care clicks past, and the medium's own locale is what
    // they get. Only `base` can hold the flow here, and that is not a question —
    // it means this is not a Nidara medium and there is nothing to install from.
    ready: () => base !== null && getAnswers().language !== null,

    onEnter() {
      refreshNetwork()
      if (getAnswers().language) return
      const [sysLang, sysEnc] = MEDIUM_LOCALE.split(".")
      setLanguageAnswer({
        locale: MEDIUM_LOCALE, sysLang, sysEnc,
        label: languageName(MEDIUM_LOCALE),
      })
    },

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
        vexpand: true,
      })

      const logoIcon = nidaraLogoIcon()
      if (logoIcon) {
        box.append(new Gtk.Image({
          gicon: logoIcon,
          pixel_size: 64,
          css_classes: ["installer-logo"],
          halign: Gtk.Align.START,
        }))
      }

      // ⚠️ The page is the QUESTION, not a leaflet with a list at the bottom.
      //
      // It first carried the logo, a heading, three lines of intro, a second
      // heading, two lines about formats and THEN 328 rows — and the list came out
      // three rows tall, because everything above it had already spent the page.
      // GNOME Initial Setup's first screen is, in practice, just the language
      // list; the sidebar already says what the other steps are, so the intro was
      // describing a navigation the user can see.
      box.append(heading(t("welcomeHeading")))

      if (!base) {
        box.append(prose(t("welcomeNotMedium"), "installer-prose--warning"))
      }
      netWarn = prose(t("welcomeNoNetwork"), "installer-prose--warning")
      netWarn.visible = !netOk
      box.append(netWarn)
      refreshNetwork()

      box.append(prose(t("welcomeLanguageDesc"), "installer-prose--dim"))

      // Sorted by ENDONYM, in the reader's collation. Not by locale code: sorted
      // that way Spain's list opens on Aragonese and the United States' on
      // Cherokee, which is what shipped once (see lib/region.ts).
      // Twelve rows, not 328 — the languages Nidara actually speaks. See
      // lib/languages.ts: offering a language the installer and the installed
      // desktop will not speak is a promise nobody can keep, and it is what
      // Calamares and Anaconda both refuse to do.
      //
      // Endonyms, and NOT translated into the current UI: everyone has to be able
      // to find their own language regardless of what the screen currently says.
      // That is the greeter's rule, written in LocaleBar.ts, and now shared.
      const items = LANGUAGES.map(l => ({ l, label: languageName(l.defaultLocale) }))
      const currentKey = () => languageFor(getAnswers().language?.locale ?? MEDIUM_LOCALE).key

      const list = searchableList({
        placeholder: t("welcomeLanguagePlaceholder"),
        items,
        height: 320,
        row: ({ l, label }, check) => NidaraRow(label, l.defaultLocale, check),
        haystack: ({ l, label }) => [label.toLowerCase(), l.key.toLowerCase(), l.lang],
        isSelected: ({ l }) => l.key === currentKey(),
        onActivate: ({ l, label }) => {
          const [sysLang, sysEnc] = l.defaultLocale.split(".")
          setLanguageAnswer({ locale: l.defaultLocale, sysLang, sysEnc, label })
          // Switches the installer's own text, which rebuilds every page
          // (Flow.invalidate) — including this one. Nothing may touch a widget
          // after this call.
          setLocale(l.key)
          notifyReady?.()
        },
      })
      box.append(list.widget)

      return box
    },
  }
}
