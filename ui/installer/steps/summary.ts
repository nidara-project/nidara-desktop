// Step 7 — Summary and final confirmation before execution.
//
// Shows the clear breakdown of what will happen: which disk is erased, the user account
// created, language, keyboard, timezone, and the software packages being installed.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraRow } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { readBaseConfig, basePackages } from "../lib/base-config"
import { getLiveDefaults } from "../lib/plan"
import { heading, prose } from "./common"

export function SummaryStep(): Step {
  return {
    id: "summary",
    title: () => t("summaryTitle"),
    nextLabel: () => t("installNow"),
    ready: () => {
      const answers = getAnswers()
      return answers.disk !== null && answers.account !== null
    },

    build() {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading(t("summaryHeading")))
      box.append(prose(t("summaryWarning"), "installer-prose--warning"))

      const { box: listCard, listBox } = NidaraList()

      const answers = getAnswers()
      const disk = answers.disk
      const account = answers.account
      const live = getLiveDefaults()
      const baseResult = readBaseConfig()
      const packages = baseResult ? basePackages(baseResult.config) : []

      // Row 1: Target Disk
      if (disk) {
        const gib = (disk.size / (1024 ** 3)).toFixed(1)
        const diskTitle = disk.model || disk.name
        const diskSubtitle = `${gib} GiB · ${disk.path}${disk.rm ? ` · ${t("diskRemovable")}` : ""}`
        listBox.append(NidaraRow(t("summaryDisk"), `${diskTitle} (${diskSubtitle})`))
      }

      // Row 2: Account
      if (account) {
        listBox.append(NidaraRow(
          t("summaryAccount"),
          `${account.fullName} (${account.username}) · sudo`,
        ))
      }

      // Row 3: Language
      const chosenLang = answers.language?.label ?? `${live.localeConfig.sys_lang}.${live.localeConfig.sys_enc}`
      listBox.append(NidaraRow(t("summaryLanguage"), chosenLang))

      // Row 4: Keyboard
      const chosenKb = answers.keyboard?.label
        ? `${answers.keyboard.label}${answers.keyboard.variant ? ` (${answers.keyboard.variant})` : ""}`
        : live.localeConfig.kb_layout
      listBox.append(NidaraRow(t("summaryKeyboard"), chosenKb))

      // Row 5: Timezone
      const chosenTz = answers.timezone?.timezone ?? live.timezone
      listBox.append(NidaraRow(t("summaryTimezone"), chosenTz))

      // Row 6: Packages
      if (packages.length > 0) {
        listBox.append(NidaraRow(
          t("summaryPackages"),
          packages.join(", "),
        ))
      }

      box.append(listCard)
      return box
    },
  }
}
