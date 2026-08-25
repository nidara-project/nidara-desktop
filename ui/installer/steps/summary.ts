// Step 4 — Summary and final confirmation before execution.
//
// Shows the clear breakdown of what will happen: which disk is erased, the user account
// created, live session defaults, and the software packages being installed.

import Gtk from "gi://Gtk?version=4.0"
import Pango from "gi://Pango"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraRow } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { readBaseConfig, basePackages } from "../lib/base-config"
import { getLiveDefaults } from "../lib/plan"

function heading(text: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: ["installer-heading"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
  })
}

function prose(text: string, extraClass?: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: extraClass ? ["installer-prose", extraClass] : ["installer-prose"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
    wrap: true,
    wrap_mode: Pango.WrapMode.WORD_CHAR,
  })
}

export function SummaryStep(): Step {
  return {
    id: "summary",
    title: t("summaryTitle"),
    nextLabel: t("installNow"),
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

      // Row 1: Disk
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

      // Row 3: Timezone & locale
      listBox.append(NidaraRow(
        t("summaryTimezone"),
        `${live.timezone} · ${live.localeConfig.kb_layout} · ${live.localeConfig.sys_lang}`,
      ))

      // Row 4: Packages
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
