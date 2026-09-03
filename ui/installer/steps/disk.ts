// Step 5 — which disk/partitions to install onto, and the warning if erased.
//
// Supports two modes:
// 1. Entire Disk: Erase selected block device, choose Btrfs (recommended) or Ext4.
// 2. Manual Partitioning: Assign mount points (/, /boot, /boot/efi, /efi, /home, swap)
//    to existing partitions, with format toggles and filesystem selection, plus
//    an action button to launch GParted.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import type { Step } from "../lib/flow"
import { exec, execAsync } from "../../lib/process"
import {
  NidaraList,
  NidaraRow,
  NidaraEmptyRow,
  NidaraDropDown,
  NidaraButton,
  NidaraSelectionCheck,
  NidaraTable,
} from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import {
  getAnswers,
  setDiskAnswer,
  type DiskAnswer,
  type BlockDevice,
  type FilesystemType,
  type ManualPartitionMount,
} from "../lib/answers"
import { heading, prose, formatSize } from "./common"

interface RawBlockDevice {
  name: string
  path: string
  size: number
  model?: string | null
  fstype?: string | null
  label?: string | null
  mountpoint?: string | null
  type: string
  rm?: boolean | string | number
  pkname?: string | null
  children?: RawBlockDevice[]
}

function isUefi(): boolean {
  return GLib.file_test("/sys/firmware/efi", GLib.FileTest.EXISTS)
}

function listDisks(): BlockDevice[] {
  try {
    const raw = exec(["lsblk", "-J", "-b", "-d", "-o", "NAME,PATH,SIZE,MODEL,TYPE,RM"])
    const parsed = JSON.parse(raw)
    const devices: RawBlockDevice[] = parsed.blockdevices ?? []
    return devices
      .filter(d => d.type === "disk" && !d.name.startsWith("loop") && !d.name.startsWith("zram"))
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

interface DetectedPartition {
  name: string
  path: string
  size: number
  fstype: string | null
  label: string | null
  pkname: string | null
}

function listPartitions(): DetectedPartition[] {
  try {
    const raw = exec(["lsblk", "-J", "-b", "-o", "NAME,PATH,SIZE,FSTYPE,LABEL,MOUNTPOINT,TYPE,PKNAME"])
    const parsed = JSON.parse(raw)
    const results: DetectedPartition[] = []

    const walk = (items: RawBlockDevice[]) => {
      for (const item of items) {
        if (item.type === "part") {
          // Exclude live session mounts
          const mp = item.mountpoint || ""
          if (!mp.startsWith("/run/archiso") && !mp.startsWith("/run/user")) {
            results.push({
              name: item.name,
              path: item.path,
              size: typeof item.size === "number" ? item.size : Number(item.size) || 0,
              fstype: item.fstype || null,
              label: item.label || null,
              pkname: item.pkname || null,
            })
          }
        }
        if (item.children) walk(item.children)
      }
    }

    walk(parsed.blockdevices ?? [])
    return results
  } catch (e) {
    console.error("[Installer] Failed to list partitions:", e)
    return []
  }
}

/**
 * What a partition can be mounted as. The label IS the mount point, except for
 * the empty one — which is the only entry that is not a place and so is the only
 * one with a translated name.
 *
 * ⚠️ They used to read "Root (/)", "EFI System (/boot/efi)", "Home (/home)", and
 * that is a decision this table reversed on two counts:
 *
 *   · It is what the column heading already says. Under a heading reading "Mount
 *     point", "EFI System (/boot)" spends a line saying the kind of thing a mount
 *     point is; the answer is the path. Calamares' mount-point combo shows the
 *     bare paths for the same reason, and it is the closest prior art there is.
 *   · It cost the layout its stability. A `Gtk.DropDown`'s button is as wide as
 *     the SELECTED item, so a column measured with every row unanswered grew by
 *     ~100px the moment somebody chose one — measured 2026-09-03, en 543 → 645 —
 *     and a table that grows inside a fixed pane is a table that gets clipped.
 *     Six labels of nearly equal width make the column a constant.
 *
 * The three EFI spellings stay three entries rather than one: which of them is
 * right depends on the layout the user already has, and guessing is how an
 * installer mounts the ESP where the bootloader will not look for it.
 */
const MOUNT_OPTIONS = [
  { id: "", labelKey: "diskMountNone", label: "", mountpoint: "" },
  { id: "/", labelKey: null, label: "/", mountpoint: "/" },
  { id: "/boot", labelKey: null, label: "/boot", mountpoint: "/boot" },
  { id: "/boot/efi", labelKey: null, label: "/boot/efi", mountpoint: "/boot/efi" },
  { id: "/efi", labelKey: null, label: "/efi", mountpoint: "/efi" },
  { id: "/home", labelKey: null, label: "/home", mountpoint: "/home" },
  { id: "swap", labelKey: null, label: "swap", mountpoint: "swap" },
] as const

/** The strings the mount dropdown shows, in this locale. */
const mountLabels = () =>
  MOUNT_OPTIONS.map(opt => (opt.labelKey ? t(opt.labelKey) : opt.label))

const FS_OPTIONS: FilesystemType[] = ["btrfs", "ext4", "xfs", "f2fs", "vfat"]

/** The three mount points that can hold the EFI system partition on this install. */
const ESP_MOUNTS = new Set(["/boot", "/boot/efi", "/efi"])

/**
 * Everything wrong with a manual layout right now, in the user's language.
 * Empty means installable — which is exactly what `ready()` asks.
 *
 * It exists as one function because the page and the Continue button have to
 * agree, and before this they did not agree about anything a user could see:
 * `ready()` knew the two requirements and said nothing (the button simply stayed
 * dead, D-16), and NOTHING knew about the third — two partitions could both be
 * given `/home`, or `/`, and the installer accepted it and then mounted one over
 * the other (D-17).
 *
 * ⚠️ `swap` is deliberately not a duplicate. Several swap partitions on one
 * machine are a normal layout, and unlike a mount point swap is not a place —
 * `swapon` takes as many as it is given.
 */
function manualProblems(mounts: ManualPartitionMount[]): string[] {
  const problems: string[] = []
  if (!mounts.some(m => m.mountpoint === "/")) problems.push(t("diskErrNoRoot"))
  if (isUefi() && !mounts.some(m => ESP_MOUNTS.has(m.mountpoint))) problems.push(t("diskErrNoBoot"))

  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const m of mounts) {
    if (m.mountpoint === "" || m.mountpoint === "swap") continue
    if (seen.has(m.mountpoint)) dupes.add(m.mountpoint)
    seen.add(m.mountpoint)
  }
  if (dupes.size > 0) problems.push(t("diskErrDuplicateMount") + [...dupes].join(", "))

  return problems
}

export function DiskStep(): Step {
  return {
    id: "disk",
    title: () => t("diskTitle"),
    nextLabel: () => t("continue"),
    ready: () => {
      // ⚠️ The whole install is UEFI-only and nothing used to say so. Entire-disk
      // mode lays down a GPT with an `ef00` partition unconditionally and
      // base.json asks for Systemd-boot, which does not exist outside UEFI — so on
      // a legacy-BIOS machine the install ran to completion, reported success, and
      // produced a disk that does not boot. `isUefi()` was already here and was
      // only ever consulted by the MANUAL branch below.
      //
      // Refusing is the honest answer while that is true: there is no BIOS path to
      // fall back to. If one is ever written, this is the guard that lifts.
      if (!isUefi()) return false
      const a = getAnswers().disk
      if (!a) return false
      if (a.mode === "entire_disk") return a.disk !== null
      // The same list the page prints under the table — see manualProblems.
      if (a.mode === "manual") return manualProblems(a.mounts).length === 0
      return false
    },

    build(notifyReady) {
      const rootBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
        hexpand: true,
      })

      rootBox.append(heading(t("diskHeading")))

      // Said at the top of the page, before any choice is offered: a refusal the
      // user cannot see the reason for is just a Continue button that does nothing.
      if (!isUefi()) {
        rootBox.append(prose(t("diskErrNoUefi"), "installer-prose--warning"))
      }

      let currentMode: "entire_disk" | "manual" = "entire_disk"
      let selectedDisk: BlockDevice | null = null
      let selectedFs: FilesystemType = "btrfs"
      const manualMounts = new Map<string, ManualPartitionMount>()

      const existingAnswer = getAnswers().disk
      if (existingAnswer) {
        currentMode = existingAnswer.mode
        if (existingAnswer.mode === "entire_disk") {
          selectedDisk = existingAnswer.disk
          selectedFs = existingAnswer.filesystem
        } else {
          for (const m of existingAnswer.mounts) {
            manualMounts.set(m.path, m)
          }
        }
      }

      // Assigned by the manual page below, which is built after this. The answer
      // and the sentence explaining why it is not accepted have to move together:
      // every path that changes a mount point goes through syncAnswer.
      let refreshProblems: () => void = () => {}

      const syncAnswer = () => {
        if (currentMode === "entire_disk") {
          if (selectedDisk) {
            setDiskAnswer({
              mode: "entire_disk",
              disk: selectedDisk,
              filesystem: selectedFs,
            })
          } else {
            setDiskAnswer(null)
          }
        } else {
          const mounts = Array.from(manualMounts.values()).filter(m => m.mountpoint !== "")
          setDiskAnswer({
            mode: "manual",
            mounts,
          })
        }
        refreshProblems()
        notifyReady?.()
      }

      // ── Mode Switcher ──────────────────────────────────────────────────
      // Choices, so one tab stop with arrows inside — the same keyboard model as
      // the country and language lists (NidaraPickList). The partition TABLE below
      // is the other case: its rows hold controls, so each control is its own stop.
      const { box: modeListBoxContainer, listBox: modeListBox } = NidaraList("", [], "", { pick: true })
      modeListBoxContainer.set_margin_bottom(4)

      const checkEntire = NidaraSelectionCheck(16)
      const checkManual = NidaraSelectionCheck(16)
      checkEntire.visible = currentMode === "entire_disk"
      checkManual.visible = currentMode === "manual"

      const rowEntire = NidaraRow(t("diskModeEntire"), t("diskModeEntireDesc"), checkEntire)
      const rowManual = NidaraRow(t("diskModeManual"), t("diskModeManualDesc"), checkManual)

      if (currentMode === "entire_disk") rowEntire.add_css_class("is-selected")
      else rowManual.add_css_class("is-selected")

      const updateModeSelection = (mode: "entire_disk" | "manual") => {
        if (mode === "entire_disk") {
          rowEntire.add_css_class("is-selected")
          rowManual.remove_css_class("is-selected")
          checkEntire.visible = true
          checkManual.visible = false
        } else {
          rowManual.add_css_class("is-selected")
          rowEntire.remove_css_class("is-selected")
          checkManual.visible = true
          checkEntire.visible = false
        }
      }

      modeListBox.append(rowEntire)
      modeListBox.append(rowManual)

      rootBox.append(modeListBoxContainer)

      // ── Containers for Entire Disk vs Manual ───────────────────────────
      const stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        transition_duration: 150,
      })

      // ──── Page 1: Entire Disk ──────────────────────────────────────────
      const entireBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        hexpand: true,
      })

      entireBox.append(prose(t("diskWarning"), "installer-prose--warning"))

      const disks = listDisks()
      const { box: diskListBoxContainer, listBox: diskListBox } = NidaraList("", [], "", { pick: true })
      const diskRowMap = new Map<BlockDevice, Gtk.ListBoxRow>()
      const diskCheckMap = new Map<BlockDevice, Gtk.Widget>()

      const updateDiskSelection = (activeDisk: BlockDevice) => {
        for (const [d, row] of diskRowMap.entries()) {
          const chk = diskCheckMap.get(d)
          if (d.path === activeDisk.path) {
            row.add_css_class("is-selected")
            if (chk) chk.visible = true
          } else {
            row.remove_css_class("is-selected")
            if (chk) chk.visible = false
          }
        }
      }

      if (disks.length === 0) {
        diskListBox.append(NidaraEmptyRow(t("diskNoDisks")))
      } else {
        if (!selectedDisk) selectedDisk = disks[0]

        const selectThisDisk = (disk: BlockDevice) => {
          selectedDisk = disk
          updateDiskSelection(disk)
          syncAnswer()
        }

        for (const disk of disks) {
          const isCurrent = selectedDisk?.path === disk.path
          const check = NidaraSelectionCheck(16)
          check.visible = isCurrent
          diskCheckMap.set(disk, check)

          const title = disk.model || disk.name
          const subtitle = `${formatSize(disk.size)} · ${disk.path}${disk.rm ? ` · ${t("diskRemovable")}` : ""}`

          const row = NidaraRow(title, subtitle, check)
          diskRowMap.set(disk, row)

          if (isCurrent) row.add_css_class("is-selected")

          diskListBox.append(row)
        }

        diskListBox.connect("row-activated", (_, row) => {
          const idx = row.get_index()
          if (disks[idx]) {
            selectThisDisk(disks[idx])
          }
        })
      }

      entireBox.append(diskListBoxContainer)

      // Filesystem Choice for Entire Disk
      const { box: fsListBoxContainer, listBox: fsListBox } = NidaraList("", [], "", { pick: true })
      const checkBtrfs = NidaraSelectionCheck(16)
      const checkExt4 = NidaraSelectionCheck(16)
      checkBtrfs.visible = selectedFs === "btrfs"
      checkExt4.visible = selectedFs === "ext4"

      const rowBtrfs = NidaraRow(t("diskFsBtrfs"), null, checkBtrfs)
      const rowExt4 = NidaraRow(t("diskFsExt4"), null, checkExt4)

      if (selectedFs === "btrfs") rowBtrfs.add_css_class("is-selected")
      else rowExt4.add_css_class("is-selected")

      const updateFsSelection = (fs: FilesystemType) => {
        if (fs === "btrfs") {
          rowBtrfs.add_css_class("is-selected")
          rowExt4.remove_css_class("is-selected")
          checkBtrfs.visible = true
          checkExt4.visible = false
        } else {
          rowExt4.add_css_class("is-selected")
          rowBtrfs.remove_css_class("is-selected")
          checkExt4.visible = true
          checkBtrfs.visible = false
        }
      }

      fsListBox.connect("row-activated", (_, row) => {
        if (row === rowBtrfs) {
          selectedFs = "btrfs"
          updateFsSelection("btrfs")
          syncAnswer()
        } else if (row === rowExt4) {
          selectedFs = "ext4"
          updateFsSelection("ext4")
          syncAnswer()
        }
      })

      fsListBox.append(rowBtrfs)
      fsListBox.append(rowExt4)

      entireBox.append(fsListBoxContainer)
      stack.add_named(entireBox, "entire_disk")

      // ──── Page 2: Manual Partitioning ──────────────────────────────────
      const manualBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        hexpand: true,
      })

      // What the layout still needs, said BEFORE Continue is pressed rather than
      // by a Continue that does nothing (D-16), and updated on every change. It
      // sits above the table because it is the instruction, not the verdict: on
      // arrival nothing is assigned yet, so this is the first thing read on the
      // page and it is the whole minimum in one place.
      const problemLabel = prose("", "installer-prose--warning")
      manualBox.append(problemLabel)

      refreshProblems = () => {
        const problems = manualProblems(
          Array.from(manualMounts.values()).filter(m => m.mountpoint !== ""),
        )
        problemLabel.label = problems.join("\n")
        problemLabel.visible = problems.length > 0
      }

      // ⚠️ The columns are the deliverable of #399, not decoration. A row used to
      // be a path, a dropdown, a checkbox and another dropdown with nothing saying
      // what any of them was (D-13) — the format checkbox carried its own label
      // because it was the only one that could, which made it the only control on
      // the row that read as a question.
      //
      // The mount point is the widest column and it is the one the page is FOR, so
      // it is not squeezed: `WINDOW_LAYOUT.wizardContent` is derived from what this
      // table measures (see the note there). Only the partition path expands.
      const table = NidaraTable([
        { title: t("diskColPartition"), expand: true },
        { title: t("diskColSize"), align: Gtk.Align.END, dim: true },
        { title: t("diskColContents"), dim: true },
        { title: t("diskMountpoint") },
        // Centred: the cell is a checkbox, which is a mark rather than a value,
        // and a mark hard against the left edge of a wide column stops reading as
        // that column's answer.
        { title: t("diskFormat"), align: Gtk.Align.CENTER },
        { title: t("diskFs") },
      ])
      manualBox.append(table.box)

      const buildPartitionsList = () => {
        table.clear()

        const partitions = listPartitions()

        // Assignments to partitions that are no longer there go with them. Refresh
        // exists because the disk can change under the page (a USB pulled, a table
        // rewritten elsewhere), and a mount point pointing at a path that has gone
        // is one the user can neither see nor take back — it would simply arrive at
        // the run step as a mount of nothing.
        const present = new Set(partitions.map(p => p.path))
        for (const path of Array.from(manualMounts.keys())) {
          if (!present.has(path)) manualMounts.delete(path)
        }

        if (partitions.length === 0) {
          table.appendMessage(t("diskNoPartitions"))
          return
        }

        for (const p of partitions) {
          const currentEntry = manualMounts.get(p.path)

          // What is on the partition NOW, which is what tells a user whether they
          // are about to overwrite something. It used to fall back to the literal
          // word "Partitions" on a row that is a partition (D-15); an em dash is
          // the honest answer — lsblk knows of no filesystem here.
          const contents = [p.fstype, p.label].filter(Boolean).join(" · ") || "—"

          const mountStringList = Gtk.StringList.new(mountLabels())
          const mountDropDown = NidaraDropDown({
            model: mountStringList,
            valign: Gtk.Align.CENTER,
          })
          // Every control in a table cell is a control with no visible label of
          // its own — the column heading is the label, and a heading is not in the
          // row's accessibility tree. Named here so a reader (or `nidara-a11y`)
          // does not meet a column of identical unnamed controls.
          //
          // ⚠️ It only sticks on the CHECK BOX. Measured 2026-09-03: a
          // `Gtk.DropDown` reports its SELECTED ITEM as its accessible name and
          // overrides this — the a11y tree shows `Ninguno` / `btrfs`, which at
          // least says what the control holds, and never which partition. Left in
          // place because it is the correct call and costs nothing; do not read it
          // as a claim that the dropdowns are named.
          mountDropDown.update_property(
            [Gtk.AccessibleProperty.LABEL], [`${t("diskMountpoint")} — ${p.path}`])

          let initialMountIdx = 0
          if (currentEntry) {
            const idx = MOUNT_OPTIONS.findIndex(opt => opt.mountpoint === currentEntry.mountpoint)
            if (idx !== -1) initialMountIdx = idx
          }
          mountDropDown.set_selected(initialMountIdx)

          const formatCheck = new Gtk.CheckButton({
            valign: Gtk.Align.CENTER,
            active: currentEntry ? currentEntry.format : false,
          })
          formatCheck.update_property(
            [Gtk.AccessibleProperty.LABEL], [`${t("diskFormat")} — ${p.path}`])

          const fsStringList = Gtk.StringList.new(FS_OPTIONS)
          const fsDropDown = NidaraDropDown({
            model: fsStringList,
            valign: Gtk.Align.CENTER,
          })
          fsDropDown.update_property(
            [Gtk.AccessibleProperty.LABEL], [`${t("diskFs")} — ${p.path}`])
          const curFsIdx = currentEntry ? FS_OPTIONS.indexOf(currentEntry.filesystem) : 0
          fsDropDown.set_selected(curFsIdx >= 0 ? curFsIdx : 0)

          // The same rule `updatePartitionState` keeps, applied to the state the
          // row is BORN in — a page rebuilt from existing answers (walking back to
          // this step, or changing the language) has rows that are already
          // answered, and had they only been sensitive after a change, half the
          // table would have opened greyed out.
          const initialMount = MOUNT_OPTIONS[initialMountIdx]?.mountpoint ?? ""
          formatCheck.set_sensitive(initialMount !== "")
          fsDropDown.set_sensitive(initialMount !== "" && formatCheck.active)

          const updatePartitionState = () => {
            const selIdx = mountDropDown.get_selected()
            const chosenMount = MOUNT_OPTIONS[selIdx]?.mountpoint ?? ""
            const shouldFormat = formatCheck.active
            const chosenFs = FS_OPTIONS[fsDropDown.get_selected()] || "btrfs"

            // The rest of the row answers a question the mount point asks. With no
            // mount point there is no question: the partition is not part of this
            // install, and a live "Format" tick on it is a control that does
            // nothing — which on THIS page reads as a promise to erase something.
            formatCheck.set_sensitive(chosenMount !== "")
            fsDropDown.set_sensitive(chosenMount !== "" && shouldFormat)

            if (!chosenMount) {
              manualMounts.delete(p.path)
            } else {
              manualMounts.set(p.path, {
                name: p.name,
                path: p.path,
                size: p.size,
                fsType: p.fstype,
                label: p.label,
                mountpoint: chosenMount,
                filesystem: chosenFs,
                format: shouldFormat,
              })
            }
            syncAnswer()
          }

          mountDropDown.connect("notify::selected", () => {
            const selIdx = mountDropDown.get_selected()
            const chosenMount = MOUNT_OPTIONS[selIdx]?.mountpoint ?? ""
            // Smart format default: If EFI partition and already vfat, default to keep data (no format)
            if (ESP_MOUNTS.has(chosenMount)) {
              formatCheck.active = p.fstype !== "vfat"
            } else if (chosenMount === "/") {
              formatCheck.active = true
            }
            updatePartitionState()
          })

          formatCheck.connect("toggled", updatePartitionState)
          fsDropDown.connect("notify::selected", updatePartitionState)

          table.appendRow([
            p.path,
            formatSize(p.size),
            contents,
            mountDropDown,
            formatCheck,
            fsDropDown,
          ])
        }
      }

      buildPartitionsList()

      // ⚠️ UNDER the table, aligned to its right edge — the toolbar position every
      // table with actions uses, and the fix for D-18. These two used to lead the
      // page from its top-left corner, which was already odd when there were two of
      // them and became an orphan when #394 hid GParted on a medium that does not
      // ship it: a lone "Refresh" floating above a table, attached to nothing.
      //
      // ⚠️ Shown only if the program is actually here, which on the shipped medium
      // it is NOT: `gparted` is in none of the 174 lines of nidara-iso's
      // packages.x86_64. The button was offered on every install and did nothing —
      // and could not even say so, because the `try/catch` around it wraps a
      // PROMISE, so the spawn failure rejected into nowhere. Not a log line, not a
      // dialog, not a flicker.
      //
      // Hidden rather than deleted: manual mode has no partition editor of its own,
      // so if a partition editor is ever added to the medium this is where it goes.
      const manualActions = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
      })

      const gpartedBtn = NidaraButton({
        label: t("diskLaunchGparted"),
        variant: "secondary",
      })
      gpartedBtn.visible = GLib.find_program_in_path("gparted") !== null
      gpartedBtn.connect("clicked", () => {
        execAsync(["gparted"]).catch(e =>
          console.error("[Installer] Failed to launch GParted:", e))
      })

      const refreshBtn = NidaraButton({
        label: t("diskRefresh"),
        variant: "secondary",
      })
      refreshBtn.connect("clicked", () => {
        buildPartitionsList()
        syncAnswer()
      })

      manualActions.append(gpartedBtn)
      manualActions.append(refreshBtn)
      manualBox.append(manualActions)

      stack.add_named(manualBox, "manual")

      // Switch mode logic
      modeListBox.connect("row-activated", (_, row) => {
        if (row === rowEntire) {
          currentMode = "entire_disk"
          updateModeSelection("entire_disk")
          stack.set_visible_child_name("entire_disk")
          syncAnswer()
        } else if (row === rowManual) {
          currentMode = "manual"
          updateModeSelection("manual")
          stack.set_visible_child_name("manual")
          syncAnswer()
        }
      })

      stack.set_visible_child_name(currentMode)
      rootBox.append(stack)

      // The page takes the caret when it opens, on the choice it opens with
      // (#403). The two searchable steps do the same in their own list, and the
      // account step has always done it — without it a step reached by pressing
      // Return on Continue leaves the focus ON Continue, so the first thing a
      // keyboard user has to do is walk backwards into the page they just opened.
      //
      // ⚠️ Deferred by a beat for the same reason the account step defers: on
      // `map` the widgets exist but GTK settles focus a frame later and overwrites
      // a grab made here.
      rootBox.connect("map", () => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
          const row = currentMode === "entire_disk" ? rowEntire : rowManual
          row.grab_focus()
          return GLib.SOURCE_REMOVE
        })
      })

      // Initial sync
      syncAnswer()

      return rootBox
    },
  }
}
