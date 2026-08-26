// Step 3 — Keyboard layout selection and interactive test box.
//
// Lets the user select their keyboard layout and variant, and test characters in a
// live input field. Switching layout updates the running session immediately.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { execAsync } from "../../lib/process"
import { NidaraList, NidaraRow } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers, setKeyboardAnswer, type KeyboardAnswer } from "../lib/answers"
import { heading, prose } from "./common"

interface KeyboardLayoutItem {
  label: string
  layout: string
  variant: string
}

const KEYBOARD_LAYOUTS: KeyboardLayoutItem[] = [
  { label: "Español",                         layout: "es",    variant: "" },
  { label: "English (US)",                    layout: "us",    variant: "" },
  { label: "English (UK)",                    layout: "gb",    variant: "" },
  { label: "Español (Latinoamérica)",         layout: "latam", variant: "" },
  { label: "Français",                        layout: "fr",    variant: "" },
  { label: "Deutsch",                         layout: "de",    variant: "" },
  { label: "Italiano",                        layout: "it",    variant: "" },
  { label: "Português",                       layout: "pt",    variant: "" },
  { label: "Português (Brasil)",              layout: "br",    variant: "" },
  { label: "Polski",                          layout: "pl",    variant: "" },
  { label: "Nederlands",                      layout: "nl",    variant: "" },
  { label: "Русский",                         layout: "ru",    variant: "" },
  { label: "日本語 (Romaji)",                 layout: "jp",    variant: "" },
  { label: "中文 (Pinyin)",                   layout: "cn",    variant: "" },
  { label: "English (Dvorak)",                layout: "us",    variant: "dvorak" },
  { label: "English (Colemak)",               layout: "us",    variant: "colemak" },
]

export function KeyboardStep(): Step {
  // Default to Spanish or US layout based on language
  if (!getAnswers().keyboard) {
    const lang = getAnswers().language?.locale ?? "en_US.UTF-8"
    const defaultLayout = lang.startsWith("es")
      ? KEYBOARD_LAYOUTS[0]
      : (KEYBOARD_LAYOUTS.find(k => lang.toLowerCase().startsWith(k.layout)) ?? KEYBOARD_LAYOUTS[1])
    setKeyboardAnswer({
      layout: defaultLayout.layout,
      variant: defaultLayout.variant,
      label: defaultLayout.label,
    })
  }

  return {
    id: "keyboard",
    title: () => t("keyboardTitle"),
    nextLabel: () => t("continue"),
    ready: () => getAnswers().keyboard !== null,

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading(t("keyboardHeading")))
      box.append(prose(t("keyboardProse")))

      const { box: listBoxContainer, listBox } = NidaraList()
      listBox.selection_mode = Gtk.SelectionMode.NONE

      let firstRadio: Gtk.CheckButton | null = null
      const radioMap = new Map<KeyboardLayoutItem, Gtk.CheckButton>()
      const rowMap = new Map<Gtk.ListBoxRow, KeyboardLayoutItem>()

      const applyLayout = (item: KeyboardLayoutItem) => {
        setKeyboardAnswer({
          layout: item.layout,
          variant: item.variant,
          label: item.label,
        })
        const radio = radioMap.get(item)
        if (radio && !radio.active) radio.active = true

        // Apply immediately to the live session
        execAsync(["localectl", "set-x11-keymap", item.layout, "pc105", item.variant]).catch(() => {})
        execAsync(["hyprctl", "keyword", "input:kb_layout", item.layout]).catch(() => {})
        if (item.variant) {
          execAsync(["hyprctl", "keyword", "input:kb_variant", item.variant]).catch(() => {})
        }
        notifyReady?.()
      }

      const currentAnswer = getAnswers().keyboard

      for (const item of KEYBOARD_LAYOUTS) {
        const radio = new Gtk.CheckButton()
        if (firstRadio) {
          radio.set_group(firstRadio)
        } else {
          firstRadio = radio
        }
        radioMap.set(item, radio)

        const subtitle = item.variant ? `${item.layout} (${item.variant})` : item.layout
        const row = NidaraRow(item.label, subtitle, radio)
        rowMap.set(row, item)

        radio.connect("toggled", () => {
          if (radio.active) applyLayout(item)
        })

        if (currentAnswer && currentAnswer.layout === item.layout && currentAnswer.variant === item.variant) {
          radio.active = true
        }

        listBox.append(row)
      }

      listBox.connect("row-activated", (_, row) => {
        const item = rowMap.get(row)
        if (item) applyLayout(item)
      })

      const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        max_content_height: 240,
        propagate_natural_height: true,
        child: listBoxContainer,
      })

      box.append(scrolled)

      // Interactive test input field
      const testEntry = new Gtk.Entry({
        placeholder_text: t("keyboardTestPlaceholder"),
        css_classes: ["installer-keyboard-test"],
        hexpand: true,
      })

      const testCard = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ["nidara-list-card"],
        margin_top: 4,
      })
      testCard.append(testEntry)
      box.append(testCard)

      return box
    },
  }
}
