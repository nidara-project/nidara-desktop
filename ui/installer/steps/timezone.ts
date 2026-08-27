// Step 4 — Timezone selection.
//
// Allows the user to select their region and city/timezone for system clock configuration.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { execAsync } from "../../lib/process"
import { NidaraList, NidaraRow, NidaraScrolled } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers, setTimezoneAnswer, type TimezoneAnswer } from "../lib/answers"
import { getLiveDefaults } from "../lib/plan"
import { heading, prose } from "./common"

const COMMON_TIMEZONES = [
  "Europe/Madrid",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Lisbon",
  "Europe/Warsaw",
  "Europe/Amsterdam",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Buenos_Aires",
  "America/Sao_Paulo",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Asia/Dubai",
  "Australia/Sydney",
  "UTC",
]

export function TimezoneStep(): Step {
  if (!getAnswers().timezone) {
    const live = getLiveDefaults()
    setTimezoneAnswer({ timezone: live.timezone || "UTC" })
  }

  return {
    id: "timezone",
    title: () => t("timezoneTitle"),
    nextLabel: () => t("continue"),
    ready: () => getAnswers().timezone !== null,

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading(t("timezoneHeading")))
      box.append(prose(t("timezoneProse")))

      const currentTz = getAnswers().timezone?.timezone ?? "UTC"

      // Selected TZ display label
      const activeLabel = new Gtk.Label({
        label: currentTz,
        css_classes: ["nidara-badge", "active"],
        halign: Gtk.Align.END,
        valign: Gtk.Align.CENTER,
      })

      const { box: listBoxContainer, listBox } = NidaraList()
      listBox.selection_mode = Gtk.SelectionMode.NONE

      let firstRadio: Gtk.CheckButton | null = null
      const radioMap = new Map<string, Gtk.CheckButton>()
      const rowTzMap = new Map<Gtk.ListBoxRow, string>()
      const tzRowMap = new Map<string, Gtk.ListBoxRow>()

      const updateRowSelection = (activeTz: string) => {
        for (const [tz, row] of tzRowMap.entries()) {
          if (tz === activeTz) {
            row.add_css_class("is-selected")
          } else {
            row.remove_css_class("is-selected")
          }
        }
      }

      const selectTz = (tz: string) => {
        setTimezoneAnswer({ timezone: tz })
        activeLabel.label = tz
        const radio = radioMap.get(tz)
        if (radio && !radio.active) radio.active = true
        updateRowSelection(tz)
        notifyReady?.()
      }

      // Populate list with common timezones (plus current if not present)
      const tzList = [...COMMON_TIMEZONES]
      if (currentTz && !tzList.includes(currentTz)) {
        tzList.unshift(currentTz)
      }

      for (const tz of tzList) {
        const radio = new Gtk.CheckButton()
        if (firstRadio) {
          radio.set_group(firstRadio)
        } else {
          firstRadio = radio
        }
        radioMap.set(tz, radio)

        const [region, city] = tz.includes("/") ? tz.split("/", 2) : ["General", tz]
        const row = NidaraRow(city ? city.replace(/_/g, " ") : tz, region, radio)
        rowTzMap.set(row, tz)
        tzRowMap.set(tz, row)

        radio.connect("toggled", () => {
          if (radio.active) selectTz(tz)
        })

        if (tz === currentTz) {
          radio.active = true
          row.add_css_class("is-selected")
        }

        listBox.append(row)
      }

      listBox.connect("row-activated", (_, row) => {
        const tz = rowTzMap.get(row)
        if (tz) selectTz(tz)
      })

      const { widget: scrolledWidget } = NidaraScrolled({
        child: listBoxContainer,
        maxContentHeight: 280,
        propagateNaturalHeight: true,
        alwaysVisible: true,
      })

      box.append(scrolledWidget)
      return box
    },
  }
}
