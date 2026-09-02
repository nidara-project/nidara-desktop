// Step 3 — Keyboard layout selection and interactive test box.
//
// Lets the user select their keyboard layout and variant, and test characters in a
// live input field. Switching layout updates the running session immediately.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { execAsync } from "../../lib/process"
import { NidaraList, NidaraRow, NidaraSelectionCheck } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers, setKeyboardAnswer, type KeyboardAnswer } from "../lib/answers"
import { heading, prose } from "./common"

interface KeyboardLayoutItem {
  label: string
  /** X11/xkb layout name — what Hyprland speaks, and what we apply live. */
  layout: string
  variant: string
  /**
   * Console (vconsole) keymap name — what `/etc/vconsole.conf` speaks.
   *
   * ⚠️ These are TWO DIFFERENT NAMESPACES, and four of the rows below disagree
   * between them: `gb`, `latam`, `pt` and `br` are all valid xkb layouts and none
   * of them exists as a console keymap. We were sending the xkb name straight into
   * archinstall's `locale_config.kb_layout`, which is the CONSOLE one — so for
   * those four the graphical session got the right layout and the TTY silently
   * stayed on US. (`jp` and `cn` had the same fault and are gone for a different
   * reason — see the note on the language list.)
   *
   * Today that is a nuisance. It stops being one the day disk encryption lands
   * (#310): mkinitcpio's shipped HOOKS carry `sd-vconsole`, so the LUKS passphrase
   * prompt uses THIS name. A passphrase typed on a Brazilian keyboard and then
   * asked for on a US one is a machine its owner cannot unlock.
   *
   * Verified against `localectl list-keymaps` (console) and
   * `/usr/share/X11/xkb/rules/base.lst` (xkb), 2026-09-02.
   */
  keymap: string
}

const KEYBOARD_LAYOUTS: KeyboardLayoutItem[] = [
  { label: "Español",                 layout: "es",    variant: "",        keymap: "es" },
  { label: "English (US)",            layout: "us",    variant: "",        keymap: "us" },
  { label: "English (UK)",            layout: "gb",    variant: "",        keymap: "uk" },
  { label: "Español (Latinoamérica)", layout: "latam", variant: "",        keymap: "la-latin1" },
  { label: "Français",                layout: "fr",    variant: "",        keymap: "fr" },
  { label: "Deutsch",                 layout: "de",    variant: "",        keymap: "de" },
  { label: "Italiano",                layout: "it",    variant: "",        keymap: "it" },
  { label: "Português",               layout: "pt",    variant: "",        keymap: "pt-latin1" },
  { label: "Português (Brasil)",      layout: "br",    variant: "",        keymap: "br-abnt2" },
  { label: "Polski",                  layout: "pl",    variant: "",        keymap: "pl" },
  { label: "Nederlands",              layout: "nl",    variant: "",        keymap: "nl" },
  { label: "Русский",                 layout: "ru",    variant: "",        keymap: "ru" },
  { label: "English (Dvorak)",        layout: "us",    variant: "dvorak",  keymap: "dvorak" },
  { label: "English (Colemak)",       layout: "us",    variant: "colemak", keymap: "colemak" },
]

export function KeyboardStep(): Step {
  // Set the moment somebody activates a row, and never again suggested over.
  // Without it, walking back to change the language would either be ignored
  // (an answer already exists) or would silently discard a layout the user
  // chose on purpose.
  let userPicked = false

  return {
    id: "keyboard",
    title: () => t("keyboardTitle"),
    nextLabel: () => t("continue"),
    ready: () => getAnswers().keyboard !== null,

    // ⚠️ This ran in the factory until 2026-09-02, and the factory runs inside the
    // array literal in InstallerWindow — before the window exists, and therefore
    // before anybody has chosen a language. It read `getAnswers().language` and
    // always got the initial value, so picking Spanish left English (US) ticked.
    onEnter() {
      if (userPicked) return
      const lang = getAnswers().language?.locale ?? "en_US.UTF-8"
      const suggestion = lang.startsWith("es")
        ? KEYBOARD_LAYOUTS[0]
        : (KEYBOARD_LAYOUTS.find(k => lang.toLowerCase().startsWith(k.layout)) ?? KEYBOARD_LAYOUTS[1])
      setKeyboardAnswer({
        layout: suggestion.layout,
        variant: suggestion.variant,
        keymap: suggestion.keymap,
        label: suggestion.label,
      })
    },

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

      const checkMap = new Map<KeyboardLayoutItem, Gtk.Widget>()
      const rowItemMap = new Map<Gtk.ListBoxRow, KeyboardLayoutItem>()
      const itemRowMap = new Map<KeyboardLayoutItem, Gtk.ListBoxRow>()

      const updateRowSelection = (activeItem: KeyboardLayoutItem) => {
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

      const applyLayout = (item: KeyboardLayoutItem) => {
        userPicked = true
        setKeyboardAnswer({
          layout: item.layout,
          variant: item.variant,
          keymap: item.keymap,
          label: item.label,
        })
        updateRowSelection(item)

        // Apply immediately to the live session (Hyprland keyword without polkit prompt)
        execAsync(["hyprctl", "keyword", "input:kb_layout", item.layout]).catch(() => {})
        if (item.variant) {
          execAsync(["hyprctl", "keyword", "input:kb_variant", item.variant]).catch(() => {})
        }
        notifyReady?.()
      }

      const currentAnswer = getAnswers().keyboard

      for (const item of KEYBOARD_LAYOUTS) {
        const isCurrent = currentAnswer
          ? currentAnswer.layout === item.layout && currentAnswer.variant === item.variant
          : false

        const check = NidaraSelectionCheck(16)
        check.visible = isCurrent
        checkMap.set(item, check)

        const subtitle = item.variant ? `${item.layout} (${item.variant})` : item.layout
        const row = NidaraRow(item.label, subtitle, check)
        rowItemMap.set(row, item)
        itemRowMap.set(item, row)

        if (isCurrent) {
          row.add_css_class("is-selected")
        }

        listBox.append(row)
      }

      listBox.connect("row-activated", (_, row) => {
        const item = rowItemMap.get(row)
        if (item) applyLayout(item)
      })

      box.append(listBoxContainer)

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
