// Step 2 — System language selection.
//
// Allows the user to choose the main language for the installed system and desktop.
// Changing the language here also updates the installer's active locale in real time.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraRow, NidaraSelectionCheck } from "../../lib/nidara-kit"
import { t, setLocale, getLocale, type Locale } from "../lib/i18n"
import { getAnswers, setLanguageAnswer, type LanguageAnswer } from "../lib/answers"
import { heading, prose } from "./common"

interface LocaleItem {
  locale: string
  sysLang: string
  sysEnc: string
  localeKey: Locale
  label: string
}

// ⚠️ Japanese and Simplified Chinese are translated — `ui/shell/core/i18n` carries
// both — and are deliberately NOT offered here, because Nidara ships no input
// method. A keyboard has about a hundred keys and those languages have thousands
// of characters, so writing them needs a program sitting between the keyboard and
// the application (fcitx5, ibus); there is none in `packages.x86_64` and none in
// the desktop's depends. Offering the language would install a system its owner
// cannot type into — not in a document, not in a search box, not in a file name.
// A password is the one field that would have worked, because input methods stay
// out of those on purpose.
//
// They come back the day an input method ships. Until then this list is the
// promise, and it only holds what we can keep.
const SUPPORTED_LOCALES: LocaleItem[] = [
  { locale: "en_US.UTF-8", sysLang: "en_US", sysEnc: "UTF-8", localeKey: "en",    label: "English (United States)" },
  { locale: "es_ES.UTF-8", sysLang: "es_ES", sysEnc: "UTF-8", localeKey: "es",    label: "Español (España)" },
  { locale: "fr_FR.UTF-8", sysLang: "fr_FR", sysEnc: "UTF-8", localeKey: "fr",    label: "Français (France)" },
  { locale: "de_DE.UTF-8", sysLang: "de_DE", sysEnc: "UTF-8", localeKey: "de",    label: "Deutsch (Deutschland)" },
  { locale: "it_IT.UTF-8", sysLang: "it_IT", sysEnc: "UTF-8", localeKey: "it",    label: "Italiano (Italia)" },
  { locale: "pt_BR.UTF-8", sysLang: "pt_BR", sysEnc: "UTF-8", localeKey: "pt-BR", label: "Português (Brasil)" },
  { locale: "pt_PT.UTF-8", sysLang: "pt_PT", sysEnc: "UTF-8", localeKey: "pt-PT", label: "Português (Portugal)" },
  { locale: "pl_PL.UTF-8", sysLang: "pl_PL", sysEnc: "UTF-8", localeKey: "pl",    label: "Polski (Polska)" },
  { locale: "nl_NL.UTF-8", sysLang: "nl_NL", sysEnc: "UTF-8", localeKey: "nl",    label: "Nederlands (Nederland)" },
  { locale: "ru_RU.UTF-8", sysLang: "ru_RU", sysEnc: "UTF-8", localeKey: "ru",    label: "Русский (Россия)" },
]

export function LanguageStep(): Step {
  const found = () =>
    SUPPORTED_LOCALES.find(item => item.localeKey === getLocale()) ?? SUPPORTED_LOCALES[0]

  return {
    id: "language",
    title: () => t("languageTitle"),
    nextLabel: () => t("continue"),
    ready: () => getAnswers().language !== null,

    // Seeded on entry rather than in the factory — see Step.onEnter in lib/flow.
    // Harmless here today (this is the first question asked), but the factory is
    // where the keyboard step's identical line became a real bug, and one of the
    // two staying behind is how it comes back.
    onEnter() {
      if (getAnswers().language) return
      const item = found()
      setLanguageAnswer({
        locale: item.locale,
        sysLang: item.sysLang,
        sysEnc: item.sysEnc,
        label: item.label,
      })
    },

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading(t("languageHeading")))
      box.append(prose(t("languageProse")))

      const { box: listBoxContainer, listBox } = NidaraList()
      listBox.selection_mode = Gtk.SelectionMode.NONE

      const checkMap = new Map<LocaleItem, Gtk.Widget>()
      const rowItemMap = new Map<Gtk.ListBoxRow, LocaleItem>()
      const itemRowMap = new Map<LocaleItem, Gtk.ListBoxRow>()

      const updateRowSelection = (activeItem: LocaleItem) => {
        for (const [item, row] of itemRowMap.entries()) {
          const check = checkMap.get(item)
          if (item === activeItem) {
            row.add_css_class("is-selected")
            if (check) check.visible = true
          } else {
            row.remove_css_class("is-selected")
            if (check) check.visible = false
          }
        }
      }

      const selectLocale = (item: LocaleItem) => {
        setLanguageAnswer({
          locale: item.locale,
          sysLang: item.sysLang,
          sysEnc: item.sysEnc,
          label: item.label,
        })
        setLocale(item.localeKey)
        updateRowSelection(item)
        notifyReady?.()
      }

      const currentAnswer = getAnswers().language

      for (const item of SUPPORTED_LOCALES) {
        const isCurrent = currentAnswer ? currentAnswer.locale === item.locale : item === found()
        const check = NidaraSelectionCheck(16)
        check.visible = isCurrent
        checkMap.set(item, check)

        const row = NidaraRow(item.label, item.locale, check)
        rowItemMap.set(row, item)
        itemRowMap.set(item, row)

        if (isCurrent) {
          row.add_css_class("is-selected")
        }

        listBox.append(row)
      }

      listBox.connect("row-activated", (_, row) => {
        const item = rowItemMap.get(row)
        if (item) selectLocale(item)
      })

      box.append(listBoxContainer)
      return box
    },
  }
}
