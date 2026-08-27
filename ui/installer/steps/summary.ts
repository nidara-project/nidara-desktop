import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraRow } from "../../lib/nidara-kit"
import { t, onLocaleChange } from "../lib/i18n"
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

      const headLabel = heading(t("summaryHeading"))
      const warnLabel = prose(t("summaryWarning"), "installer-prose--warning")
      box.append(headLabel)
      box.append(warnLabel)

      const { box: listCard, listBox } = NidaraList()
      box.append(listCard)

      const refresh = () => {
        headLabel.label = t("summaryHeading")
        warnLabel.label = t("summaryWarning")

        let child = listBox.get_first_child()
        while (child) {
          const next = child.get_next_sibling()
          listBox.remove(child)
          child = next
        }

        const answers = getAnswers()
        const disk = answers.disk
        const account = answers.account
        const live = getLiveDefaults()
        const baseResult = readBaseConfig()
        const packages = baseResult ? basePackages(baseResult.config) : []

        // Row 1: Target Disk / Partitions
        if (disk) {
          if (disk.mode === "entire_disk") {
            const d = disk.disk
            const gib = (d.size / (1024 ** 3)).toFixed(1)
            const diskTitle = d.model || d.name
            const fsLabel = disk.filesystem.toUpperCase()
            const diskSubtitle = `${gib} GiB · ${d.path} · ${fsLabel}${d.rm ? ` · ${t("diskRemovable")}` : ""}`
            listBox.append(NidaraRow(t("summaryDisk"), `${diskTitle} (${diskSubtitle})`))
          } else if (disk.mode === "manual") {
            const breakdown = disk.mounts
              .map(m => `${m.path} → ${m.mountpoint} (${m.format ? `${m.filesystem} [${t("diskFormat")}]` : t("diskKeep")})`)
              .join(", ")
            listBox.append(NidaraRow(t("summaryPartitionLayout"), breakdown))
          }
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
      }

      refresh()
      box.connect("map", refresh)
      onLocaleChange(refresh)

      return box
    },
  }
}

