// Step 2 — System language selection.
//
// Allows the user to choose the main language for the installed system and desktop.
// Changing the language here also updates the installer's active locale in real time.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraRow, NidaraScrolled } from "../../lib/nidara-kit"
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
  { locale: "zh_CN.UTF-8", sysLang: "zh_CN", sysEnc: "UTF-8", localeKey: "zh-CN", label: "简体中文 (中国)" },
  { locale: "ja_JP.UTF-8", sysLang: "ja_JP", sysEnc: "UTF-8", localeKey: "ja",    label: "日本語 (日本)" },
]

export function LanguageStep(): Step {
  // Initialize default language answer if not already set
  const initialLocaleKey = getLocale()
  const found = SUPPORTED_LOCALES.find(item => item.localeKey === initialLocaleKey) ?? SUPPORTED_LOCALES[0]
  if (!getAnswers().language) {
    setLanguageAnswer({
      locale: found.locale,
      sysLang: found.sysLang,
      sysEnc: found.sysEnc,
      label: found.label,
    })
  }

  return {
    id: "language",
    title: () => t("languageTitle"),
    nextLabel: () => t("continue"),
    ready: () => getAnswers().language !== null,

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

      let firstRadio: Gtk.CheckButton | null = null
      const radioMap = new Map<LocaleItem, Gtk.CheckButton>()
      const rowItemMap = new Map<Gtk.ListBoxRow, LocaleItem>()
      const itemRowMap = new Map<LocaleItem, Gtk.ListBoxRow>()

      const updateRowSelection = (activeItem: LocaleItem) => {
        for (const [item, row] of itemRowMap.entries()) {
          if (item === activeItem) {
            row.add_css_class("is-selected")
          } else {
            row.remove_css_class("is-selected")
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
        const radio = radioMap.get(item)
        if (radio && !radio.active) radio.active = true
        updateRowSelection(item)
        notifyReady?.()
      }

      const currentAnswer = getAnswers().language

      for (const item of SUPPORTED_LOCALES) {
        const radio = new Gtk.CheckButton()
        if (firstRadio) {
          radio.set_group(firstRadio)
        } else {
          firstRadio = radio
        }
        radioMap.set(item, radio)

        const isCurrent = currentAnswer ? currentAnswer.locale === item.locale : item === found
        const row = NidaraRow(item.label, item.locale, radio)
        rowItemMap.set(row, item)
        itemRowMap.set(item, row)

        radio.connect("toggled", () => {
          if (radio.active) selectLocale(item)
        })

        if (isCurrent) {
          radio.active = true
          row.add_css_class("is-selected")
        }

        listBox.append(row)
      }

      listBox.connect("row-activated", (_, row) => {
        const item = rowItemMap.get(row)
        if (item) selectLocale(item)
      })

      const { widget: scrolledWidget } = NidaraScrolled({
        child: listBoxContainer,
        maxContentHeight: 320,
        propagateNaturalHeight: true,
        alwaysVisible: true,
      })

      box.append(scrolledWidget)
      return box
    },
  }
}
