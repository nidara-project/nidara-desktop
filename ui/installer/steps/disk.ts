// Step 2 — which disk to install onto, and the warning that it will be erased.
//
// Enumerates block devices via `lsblk`, collects the user's choice, and stores it
// in `lib/answers.ts`. Does not partition, mount or write anything to disk.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { exec } from "../../lib/process"
import { NidaraList, NidaraRow, NidaraEmptyRow } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers, setDiskAnswer, type DiskAnswer } from "../lib/answers"

interface RawBlockDevice {
  name: string
  path: string
  size: number
  model: string | null
  type: string
  rm: boolean | string | number
}

function listDisks(): DiskAnswer[] {
  try {
    const raw = exec(["lsblk", "-J", "-b", "-d", "-o", "NAME,PATH,SIZE,MODEL,TYPE,RM"])
    const parsed = JSON.parse(raw)
    const devices: RawBlockDevice[] = parsed.blockdevices ?? []
    return devices
      .filter(d => d.type === "disk")
      .map(d => ({
        name: d.name,
        path: d.path,
        size: typeof d.size === "number" ? d.size : Number(d.size) || 0,
        model: d.model ? String(d.model).trim() : null,
        rm: d.rm === true || d.rm === "1" || d.rm === 1 || d.rm === "true",
      }))
  } catch (e) {
    console.error("[Installer] Failed to list disks with lsblk:", e)
    return []
  }
}

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
    wrap_mode: 2, // Pango.WrapMode.WORD_CHAR
  })
}

export function DiskStep(): Step {
  return {
    id: "disk",
    title: t("diskTitle"),
    nextLabel: t("continue"),
    ready: () => getAnswers().disk !== null,

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      box.append(heading(t("diskHeading")))
      box.append(prose(t("diskWarning"), "installer-prose--warning"))

      const disks = listDisks()
      const { box: listBoxContainer, listBox } = NidaraList()

      if (disks.length === 0) {
        listBox.append(NidaraEmptyRow(t("diskNoDisks")))
      } else {
        let firstRadio: Gtk.CheckButton | null = null
        const radioMap = new Map<DiskAnswer, Gtk.CheckButton>()
        const rowMap = new Map<Gtk.ListBoxRow, DiskAnswer>()

        const selectDisk = (disk: DiskAnswer) => {
          const current = getAnswers().disk
          if (current?.path === disk.path) return
          setDiskAnswer(disk)
          const radio = radioMap.get(disk)
          if (radio && !radio.active) radio.active = true
          notifyReady?.()
        }

        const currentAnswer = getAnswers().disk

        for (const disk of disks) {
          const radio = new Gtk.CheckButton()
          if (firstRadio) {
            radio.set_group(firstRadio)
          } else {
            firstRadio = radio
          }
          radioMap.set(disk, radio)

          const gib = (disk.size / (1024 ** 3)).toFixed(1)
          const title = disk.model || disk.name
          const subtitle = `${gib} GiB · ${disk.path}${disk.rm ? ` · ${t("diskRemovable")}` : ""}`

          const row = NidaraRow(title, subtitle, radio)
          rowMap.set(row, disk)

          radio.connect("toggled", () => {
            if (radio.active) selectDisk(disk)
          })

          if (currentAnswer && currentAnswer.path === disk.path) {
            radio.active = true
          }

          listBox.append(row)
        }

        listBox.connect("row-activated", (_, row) => {
          const disk = rowMap.get(row)
          if (disk) selectDisk(disk)
        })
      }

      box.append(listBoxContainer)

      return box
    },
  }
}
