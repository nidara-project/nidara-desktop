import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraRow } from "../../lib/nidara-kit"
import { t, onLocaleChange } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { getLiveDefaults } from "../lib/plan"
import { heading, prose, formatSize } from "./common"

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

        // Row 1: Target Disk / Partitions
        if (disk) {
          if (disk.mode === "entire_disk") {
            const d = disk.disk
            const diskTitle = d.model || d.name
            const fsLabel = disk.filesystem.toUpperCase()
            const diskSubtitle = `${formatSize(d.size)} · ${d.path} · ${fsLabel}${d.rm ? ` · ${t("diskRemovable")}` : ""}`
            listBox.append(NidaraRow(t("summaryDisk"), `${diskTitle} (${diskSubtitle})`))
          } else if (disk.mode === "manual") {
            // ⚠️ ONE LINE PER MOUNT, not a comma-joined sentence (D-26). This is the
            // last screen before a disk is written, and what a reader has to do here
            // is check a list against what they meant — which a paragraph of
            // "/dev/sda1 → /boot (vfat [Format]), /dev/sda2 → / (btrfs [Format])"
            // does not let them do. The row's subtitle wraps, and both row heights
            // are floors (see `nidara-row--double`), so it simply grows.
            const breakdown = disk.mounts
              // No `toLowerCase()` anywhere near a translated string: German
              // capitalises its nouns, so "Formatieren" lowercased is a misspelling.
              .map(m => `${m.mountpoint}  ·  ${m.path}  ·  ${formatSize(m.size)}  ·  ${m.format ? `${m.filesystem} · ${t("diskFormat")}` : t("diskKeep")}`)
              .join("\n")
            listBox.append(NidaraRow(t("summaryPartitionLayout"), breakdown))
          }
        }

        // Row 2: Account
        if (account) {
          const userAtHost = account.hostname ? `${account.username}@${account.hostname}` : account.username
          listBox.append(NidaraRow(
            t("summaryAccount"),
            `${account.fullName} (${userAtHost}) · sudo`,
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
      }

      refresh()
      box.connect("map", refresh)
      onLocaleChange(refresh)

      return box
    },
  }
}

