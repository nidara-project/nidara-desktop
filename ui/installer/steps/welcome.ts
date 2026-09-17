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
import GLib from "gi://GLib"
import type { Step } from "../lib/flow"
import { readBaseConfig } from "../lib/base-config"
import { checkArchinstall, archinstallVerdict, blocksInstall } from "../lib/archinstall-check"
import { t, setLocale, getLocale } from "../lib/i18n"
import { nidaraLogoIcon } from "../../lib/icons"
import { NidaraRow } from "../../lib/nidara-kit"
import { heading, prose, searchableList } from "./common"
import { connectivity, isUsable } from "../lib/network"
import { onBattery } from "../lib/power"
import { readDisplayDevice, watchDisplayDevice } from "../lib/upower"
import { LANGUAGES, languageFor, type Language } from "../lib/languages"
import { languageMenuLabels, languageHaystack } from "../../lib/locale-names"
import { getAnswers, setLanguageAnswer } from "../lib/answers"

/**
 * The language the installer opens on, as an ANSWER rather than a constant.
 *
 * There has to be one: Continue is live from the first frame so that somebody
 * who does not care can click past, and what they get then is whatever this
 * returns. It used to be the literal `en_US.UTF-8` — "what the medium
 * generated", which is true of the medium and says nothing about the person. On
 * the ISO that agrees with `getLocale()` by accident, because the ISO generates
 * no other locale; anywhere else — a preview run on somebody's own desktop — the
 * window came up in Spanish with the tick on American English. One question, two
 * sources, which is the defect #397 went and removed from the naming side.
 */
function defaultLanguage(): Language {
  return LANGUAGES.find(l => l.key === getLocale()) ?? LANGUAGES[0]
}

/**
 * The twelve rows, in the order they are shown: the current choice first, then
 * the rest alphabetically by endonym in the reader's collation.
 *
 * ⚠️ Computed ONCE, and that is the point of the memo. "Chosen first" is the
 * answer this bundle already gives to "where is my language?" — the country list
 * does it, and `searchableList`'s own header says why it beats scrolling to the
 * selected row. But this page rebuilds itself the moment somebody picks
 * (`setLocale` → `Flow.invalidate`), so recomputing the order would yank the row
 * that was just clicked out from under the pointer and up to the top. Deciding
 * the order the first time the page is built gives both: your language is on top
 * when you arrive, and the list holds still while you use it.
 *
 * The labels themselves are endonyms and do not change with the UI language, so
 * there is nothing stale about keeping them; only the collation is the reader's,
 * and it is the one in force when the question was first asked.
 */
let languageOrder: Array<{ l: Language, label: string }> | null = null
function languageRows(): Array<{ l: Language, label: string }> {
  if (languageOrder) return languageOrder
  const labels = languageMenuLabels(LANGUAGES.map(l => l.key))
  const current = defaultLanguage().key
  const rows = LANGUAGES
    .map((l, i) => ({ l, label: labels[i] }))
    .sort((a, b) => a.label.localeCompare(b.label, getLocale()))
  const picked = rows.filter(r => r.l.key === current)
  languageOrder = [...picked, ...rows.filter(r => r.l.key !== current)]
  return languageOrder
}

export function WelcomeStep(): Step {
  const base = readBaseConfig()

  // ⚠️ Enforced HERE since 2026-09-14, and it used to be advisory. The warning
  // showed, Continue stayed live, and somebody with no connection answered every
  // page — region, disk, a LUKS passphrase, the account — to be refused by the run
  // step after confirming the summary (measured on the VM: the first line of the
  // log was the refusal). Calamares' welcome module holds the page instead
  // (`required: [internet]` in CachyOS' welcome_online.conf).
  //
  // It is a requirement only while there is no offline install (#20, decided
  // "later"): the day the medium carries its packages, this goes back to a
  // warning. `unknown` still passes — see lib/network.ts — and the run step keeps
  // its own check, because a connection can drop between here and there.
  //
  // The person joins a network from the desktop behind this window without
  // leaving the page, so the page re-asks every few seconds while it is on screen
  // and unlocks Continue on its own the moment there is one.
  let netWarn: Gtk.Label | null = null
  let netOk = true
  let batteryWarn: Gtk.Label | null = null
  let notifyNet: (() => void) | null = null

  const refreshNetwork = () => {
    connectivity().then(c => {
      const was = netOk
      netOk = isUsable(c)
      if (netWarn) netWarn.visible = !netOk
      if (was !== netOk) notifyNet?.()
    })
  }

  // ⚠️ Not part of the network poll. It used to be, and that poll only runs while
  // the NETWORK warning is on screen — so on a machine with a connection, which is
  // every machine that can install at all, plugging the charger in never cleared
  // the battery warning. UPower tells us instead; one watcher for the installer's
  // lifetime, pointed at whichever label the latest rebuild made.
  const refreshBattery = () => {
    if (batteryWarn) batteryWarn.visible = onBattery(readDisplayDevice())
  }
  let batteryWatched = false

  // One timer for the page's lifetime, re-armed on rebuild (a language change
  // rebuilds every page). It only asks while its label is actually on screen.
  let pollId = 0
  const startPolling = () => {
    if (pollId) GLib.source_remove(pollId)
    pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      if (netWarn?.get_mapped()) refreshNetwork()
      return GLib.SOURCE_CONTINUE
    })
  }

  // ── and the other half of "can this medium install anything" ────────────────
  //
  // The network question above is advisory; this one is not, and the difference
  // is what happens if it is ignored. `steps/run.ts` partitions and mounts before
  // archinstall is handed the plan, so a configuration archinstall refuses costs
  // the disk first and fails second. See lib/archinstall-check.ts.
  //
  // It is asked here, on the first page, for the same reason the network is: a
  // person can do something about it — pick a different medium — and the answer
  // is worth more three pages before the disk step than one line after it.
  let archWarn: Gtk.Label | null = null
  let notify: (() => void) | null = null

  const refreshArchinstall = () => {
    checkArchinstall().then(() => {
      if (archWarn) applyVerdict(archWarn)
      // The verdict can turn Continue off, and it lands after the page is drawn.
      notify?.()
    })
  }

  /** The one label, carrying whichever of the three states is in force. */
  const applyVerdict = (label: Gtk.Label) => {
    const v = archinstallVerdict()
    switch (v?.kind) {
      case "missing":
        label.label = t("welcomeArchinstallMissing")
        label.visible = true
        break
      case "rejected":
        label.label = t("welcomeArchinstallRejected")
        label.visible = true
        break
      case "mismatch":
        // The two numbers are the whole content of this warning and there is no
        // interpolation in `t()`, so they are appended rather than embedded —
        // which also keeps them out of eleven translations that would each have
        // to be trusted to keep the order.
        label.label = `${t("welcomeArchinstallMismatch")} (${v.found} ≠ ${v.declared})`
        label.visible = true
        break
      default:
        label.visible = false
    }
  }

  return {
    id: "welcome",
    title: () => t("welcomeTitle"),
    nextLabel: () => t("continue"),

    // A language is always set, so Continue is live from the first frame: the
    // person who does not care clicks past, and the medium's own locale is what
    // they get. What holds the flow here is never a question: no `base` (this is
    // not a Nidara medium), no usable network (see `refreshNetwork`), or an
    // archinstall this medium cannot drive.
    // ⚠️ A verdict that has not arrived yet does NOT hold the button: see
    // `archinstallVerdict()` for why an unknown answer is allowed through.
    ready: () => base !== null
      && getAnswers().language !== null
      && netOk
      && !blocksInstall(archinstallVerdict()),

    onEnter() {
      refreshNetwork()
      refreshArchinstall()
      if (getAnswers().language) return
      const seed = defaultLanguage()
      const [sysLang, sysEnc] = seed.defaultLocale.split(".")
      setLanguageAnswer({
        locale: seed.defaultLocale, sysLang, sysEnc,
        label: languageMenuLabels([seed.key])[0],
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
      batteryWarn = prose(t("welcomeOnBattery"), "installer-prose--warning")
      batteryWarn.visible = false
      box.append(batteryWarn)
      refreshBattery()
      if (!batteryWatched) {
        batteryWatched = true
        watchDisplayDevice(refreshBattery)
      }
      notifyNet = () => notifyReady?.()
      refreshNetwork()
      startPolling()

      notify = () => notifyReady?.()
      archWarn = prose("", "installer-prose--warning")
      applyVerdict(archWarn)
      box.append(archWarn)
      refreshArchinstall()

      box.append(prose(t("welcomeLanguageDesc"), "installer-prose--dim"))

      // Twelve rows, not 328 — the languages Nidara actually speaks. See
      // lib/languages.ts: offering a language the installer and the installed
      // desktop will not speak is a promise nobody can keep, and it is what
      // Calamares and Anaconda both refuse to do.
      //
      // Endonyms, and NOT translated into the current UI: everyone has to be able
      // to find their own language regardless of what the screen currently says.
      // That is the greeter's rule, written in LocaleBar.ts, and now shared —
      // `languageMenuLabels` is where the shape of these twelve strings is
      // decided, and the greeter draws the same twelve from it.
      //
      // ⚠️ Current choice first, then sorted by that label in the READER's
      // collation — and it really is sorted, which the comment that used to sit
      // here claimed while the code shipped `LANGUAGES` in declaration order.
      // Alphabetical is what GNOME Initial Setup and Calamares both do; the row
      // on top is the rule the country list already follows. See
      // `languageRows()` for why the order is decided once and then held.
      //
      // ⚠️ The subtitle is the language TAG, not the locale. It used to be
      // `es_ES.UTF-8`, which named a territory this page does not decide.
      const items = languageRows()
      const currentKey = () => languageFor(
        getAnswers().language?.locale ?? defaultLanguage().defaultLocale,
      ).key

      const list = searchableList({
        placeholder: t("welcomeLanguagePlaceholder"),
        items,
        row: ({ l, label }, check) => NidaraRow(label, l.key, check),
        haystack: ({ l, label }) => [label, ...languageHaystack(l.key, getLocale())],
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
