// Step 5 — which disk/partitions to install onto, and the warning if erased.
//
// Supports two modes:
// 1. Entire Disk: Erase selected block device, choose Btrfs (recommended) or Ext4.
// 2. Manual Partitioning: Assign mount points (/, /boot, /home, swap)
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
import { espMount } from "../lib/disk-config"
import { ESP_MOUNTS, manualProblems } from "../lib/manual-problems"
import { freeSpaceGaps } from "../lib/free-space"
import { isUefi, secureBootState } from "../lib/firmware"
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
  start?: number | string | null
  "log-sec"?: number | string
  children?: RawBlockDevice[]
}

function listDisks(): BlockDevice[] {
  try {
    const raw = exec(["lsblk", "-J", "-b", "-d", "-o", "NAME,PATH,SIZE,MODEL,TYPE,RM,LOG-SEC"])
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
        // ⚠️ Defaulted rather than assumed away. 512 is what almost every drive
        // reports, but a 4Kn disk that silently got 512 would have its partition
        // arithmetic done in the wrong unit — so the default sits here, once, next
        // to the thing that can be missing, instead of in the caller.
        logicalSectorSize: Number(d["log-sec"]) || 512,
      }))
  } catch (e) {
    console.error("[Installer] Failed to list disks with lsblk:", e)
    return []
  }
}

interface DetectedPartition {
  name: string
  path: string
  /** The disk it is on, taken from the parent node of the tree — see ManualPartitionMount. */
  device: string
  /** Start offset in BYTES. lsblk reports it in 512-byte units; converted here, once. */
  start: number
  size: number
  logicalSectorSize: number
  fstype: string | null
  label: string | null
  pkname: string | null
}

/**
 * ⚠️ `START` is in 512-byte sectors ALWAYS — it is `/sys/class/block/<part>/start`,
 * which the kernel publishes in fixed 512-byte units whatever the drive's own
 * logical sector size. Multiplying by `LOG-SEC` would put every partition of a
 * 4Kn drive eight times too far along the disk, and manual mode now sends these
 * numbers to archinstall, which re-creates the partition at them when the row is
 * formatted.
 */
/**
 * A line of the manual table: an existing partition, or a gap that could become
 * one. They differ in three places only — the name, whether Format is a choice,
 * and whether the plan is told to CREATE — so they travel as one shape rather
 * than forking the row builder.
 */
type RowSource = DetectedPartition & { isFree: boolean; key: string }

const LSBLK_SECTOR = 512

function listPartitions(): DetectedPartition[] {
  try {
    const raw = exec([
      "lsblk", "-J", "-b", "-o",
      "NAME,PATH,SIZE,FSTYPE,LABEL,MOUNTPOINT,TYPE,PKNAME,START,LOG-SEC",
    ])
    const parsed = JSON.parse(raw)
    const results: DetectedPartition[] = []

    // The parent is carried down rather than derived from the name: `nvme0n1p2`
    // does not become `nvme0n1` by dropping digits, and a partition's device is
    // the node it hangs from in this very tree.
    const walk = (items: RawBlockDevice[], parent: RawBlockDevice | null) => {
      for (const item of items) {
        if (item.type === "part") {
          // Exclude live session mounts
          const mp = item.mountpoint || ""
          if (!mp.startsWith("/run/archiso") && !mp.startsWith("/run/user")) {
            results.push({
              name: item.name,
              path: item.path,
              device: parent?.path || (item.pkname ? `/dev/${item.pkname}` : ""),
              start: (Number(item.start) || 0) * LSBLK_SECTOR,
              size: typeof item.size === "number" ? item.size : Number(item.size) || 0,
              logicalSectorSize: Number(item["log-sec"] ?? parent?.["log-sec"]) || 512,
              fstype: item.fstype || null,
              label: item.label || null,
              pkname: item.pkname || null,
            })
          }
        }
        if (item.children) walk(item.children, item)
      }
    }

    walk(parsed.blockdevices ?? [], null)
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
 *     Five labels of nearly equal width make the column a constant.
 *
 * ⚠️ There used to be THREE EFI spellings here — `/boot`, `/boot/efi` and `/efi`
 * — offered as three equally valid answers. Two of them produced a machine that
 * installed cleanly and did not boot (#430), because systemd-boot without UKIs
 * writes `linux /vmlinuz-linux` into an entry on the ESP and that path is
 * relative to the partition holding the entry, while pacman puts the kernel in
 * `/boot` on the ROOT filesystem. The two only line up when they are the same
 * place. Decision A of #430: `/boot` is the only one, because the two that went
 * are exactly the two that cannot work — and `/boot/efi`, the Debian/Ubuntu/
 * Fedora spelling, is the likeliest one for somebody to copy from a layout they
 * already have, where GRUB made it correct.
 */
const MOUNT_OPTIONS = [
  { id: "", labelKey: "diskMountNone", label: "", mountpoint: "" },
  { id: "/", labelKey: null, label: "/", mountpoint: "/" },
  { id: "/boot", labelKey: null, label: "/boot", mountpoint: "/boot" },
  { id: "/home", labelKey: null, label: "/home", mountpoint: "/home" },
  { id: "swap", labelKey: null, label: "swap", mountpoint: "swap" },
] as const

/** The strings the mount dropdown shows, in this locale. */
const mountLabels = () =>
  MOUNT_OPTIONS.map(opt => (opt.labelKey ? t(opt.labelKey) : opt.label))

const FS_OPTIONS: FilesystemType[] = ["btrfs", "ext4", "xfs", "f2fs", "vfat"]

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
      if (a.mode === "manual") return manualProblems(a.mounts, isUefi()).length === 0
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

      if (secureBootState() === "enforcing") {
        rootBox.append(prose(t("diskWarnSecureBoot"), "installer-prose--warning"))
      }

      let currentMode: "entire_disk" | "manual" = "entire_disk"
      let selectedDisk: BlockDevice | null = null
      // ⚠️ NOT a variable, and not a question. Entire-disk mode installs btrfs,
      // full stop — the subvolume layout (and with it `/.snapshots`, which every
      // snapshot surface is allowed to assume exists) is what the product IS, and
      // an ext4 root quietly produced a machine with no rollback point at all.
      // Manual mode still offers the whole `FS_OPTIONS` list per partition: there
      // the person is assembling a layout we did not design.
      const ENTIRE_DISK_FS: FilesystemType = "btrfs"
      const manualMounts = new Map<string, ManualPartitionMount>()

      const existingAnswer = getAnswers().disk
      if (existingAnswer) {
        currentMode = existingAnswer.mode
        if (existingAnswer.mode === "entire_disk") {
          selectedDisk = existingAnswer.disk
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
              filesystem: ENTIRE_DISK_FS,
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
      // Said here rather than only on the summary: it is the one thing this page
      // decides on the person's behalf, and the page that decides it is where a
      // decision should be disclosed.
      entireBox.append(prose(t("diskEntireFsNote")))

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

      // A partition editor that did not start, said where the rest of the page
      // says things. It goes through `refreshProblems` rather than into a label
      // of its own because this page already has ONE place where it tells you
      // what is wrong, and a second one is how a message ends up somewhere
      // nobody is looking (D-19, and the reason the account form was rebuilt).
      let editorError = ""

      refreshProblems = () => {
        const problems = manualProblems(
          Array.from(manualMounts.values()).filter(m => m.mountpoint !== ""),
          isUefi(),
        )
        if (editorError) problems.unshift(editorError)
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

        // ── Unpartitioned space is a ROW, not a silence (#447) ──────────────
        //
        // `lsblk` reports partitions, so a disk with room on it looked identical
        // to a full one — and somebody who had just shrunk Windows to make space
        // for us opened this page and found nothing to install into. Whole-disk
        // mode erases, and archinstall has no resize of any kind, so "make room,
        // then install into it" is the ONLY way to keep an existing system on the
        // same drive; it was the one route the table could not show.
        //
        // A row is what the field does: Calamares lists unallocated space in the
        // table and enables `Create` only there; Ubiquity and YaST the same.
        //
        // The list is sorted by (disk, offset) so a gap sits between the
        // partitions it lies between — a free-space row in lsblk's order would be
        // a size with no place. For partitions alone this changes nothing: lsblk
        // already returns them that way.
        const allDisks = listDisks()
        const freeRows: RowSource[] = allDisks.flatMap(d =>
          freeSpaceGaps(d, partitions).map(g => ({
            name: "", path: "", device: g.device, start: g.start, size: g.size,
            logicalSectorSize: g.logicalSectorSize, fstype: null, label: null, pkname: null,
            isFree: true, key: `free:${g.device}@${g.start}`,
          })))
        const rows: RowSource[] = [
          ...partitions.map(p => ({ ...p, isFree: false, key: p.path })),
          ...freeRows,
        ].sort((a, b) => a.device.localeCompare(b.device) || a.start - b.start)

        // Assignments to partitions that are no longer there go with them. Refresh
        // exists because the disk can change under the page (a USB pulled, a table
        // rewritten elsewhere), and a mount point pointing at a path that has gone
        // is one the user can neither see nor take back — it would simply arrive at
        // the run step as a mount of nothing.
        const present = new Set(rows.map(r => r.key))
        for (const path of Array.from(manualMounts.keys())) {
          if (!present.has(path)) manualMounts.delete(path)
        }

        if (rows.length === 0) {
          table.appendMessage(t("diskNoPartitions"))
          return
        }

        // ── One heading per disk (#447's neighbour, from the T2 matrix) ────
        //
        // The table listed every partition of every drive in one flat run, and
        // the only thing separating `/dev/sda2` from `/dev/nvme0n1p2` was the
        // path in the first cell. Every installer in the field either filters to
        // one disk (Calamares, a combo box above the table) or groups by it
        // (Ubiquity's flat list with per-disk headings; YaST and subiquity, a
        // tree). We were alone in doing neither.
        //
        // A heading rather than a filter, for the reason a filter exists at all:
        // dual-boot layouts routinely span drives — the ESP on the disk that
        // boots, `/home` on the spinning one — and a page that shows one disk at
        // a time hides the half of the answer somebody is trying to check. It
        // matters more since gaps became rows: "19.5 GiB free" means nothing
        // until you know which drive it is on.
        const diskLabel = (path: string) => {
          const d = allDisks.find(x => x.path === path)
          if (!d) return path
          const name = d.model || d.name
          return `${name}  ·  ${formatSize(d.size)}  ·  ${d.path}${d.rm ? `  ·  ${t("diskRemovable")}` : ""}`
        }

        let sectionFor = ""
        for (const p of rows) {
          // `rows` is sorted by (disk, offset), so a change of device is the
          // boundary — no grouping pass, and the heading cannot end up somewhere
          // the order does not actually break.
          if (p.device !== sectionFor) {
            sectionFor = p.device
            table.appendSection(diskLabel(p.device))
          }
          const currentEntry = manualMounts.get(p.key)

          // ── ONE filesystem column, and it always reads FORWARDS ────────────
          //
          // There used to be two: `Contents` (what is on the partition now) and
          // `Filesystem` (a live dropdown of what to create). Two same-looking
          // strings side by side, and on a row being KEPT the second one announced
          // a `btrfs` that was never going to happen — next to a `/home` somebody
          // was checking they would not lose. "Format to what, or format right
          // now?" was the question, and no wording answers it while both are there.
          //
          // Prior art says the same thing twice. Calamares disables its filesystem
          // combo when `Keep` is chosen and fills it with the EXISTING filesystem
          // (`EditExistingPartitionDialog.cpp`, `setEnabled(doFormat)` then
          // `setCurrentText(userVisibleFS(...))`); Anaconda does exactly that with
          // `fancy_set_sensitive(self._fsCombo, self._permissions.format_type)`.
          // Neither carries a second column — Calamares has an open TODO admitting
          // its table cannot show formatting at all.
          //
          // So the column means one thing on every row: **what this partition will
          // hold when the install finishes.** It is editable only where that is a
          // choice. The question above cannot be asked of it.
          //
          // The label is not lost, it moves: `oldroot` says WHICH partition this
          // is, which is the identity column's job, not the filesystem's.
          const rowName = p.isFree ? t("diskFreeSpace") : [p.path, p.label].filter(Boolean).join("  ·  ")
          // An em dash where lsblk knows of no filesystem — the honest answer, and
          // the same one the old `Contents` cell gave (D-15).
          const keptFsLabel = p.fstype || "—"

          // Every control in a table cell is a control with no visible label of
          // its own — the column heading is the label, and a heading is not in the
          // row's accessibility tree. Named here so a reader (or `nidara-a11y`)
          // does not meet a column of identical unnamed controls.
          //
          // ⚠️ On a dropdown it is the DESCRIPTION and not the label, and that is
          // not a style choice: a `Gtk.DropDown` publishes its SELECTED ITEM as
          // its accessible name and swallows a label set on it. This file carried
          // the measurement of that as a warning from 2026-09-03 until the kit
          // gained somewhere to put the answer (#465); the note now lives with
          // the mechanism, in `NidaraDropDown`.
          const mountStringList = Gtk.StringList.new(mountLabels())
          const mountDropDown = NidaraDropDown({
            model: mountStringList,
            valign: Gtk.Align.CENTER,
            accessibleDescription: `${t("diskMountpoint")} — ${rowName}`,
          })

          let initialMountIdx = 0
          if (currentEntry) {
            const idx = MOUNT_OPTIONS.findIndex(opt => opt.mountpoint === currentEntry.mountpoint)
            if (idx !== -1) initialMountIdx = idx
          }
          mountDropDown.set_selected(initialMountIdx)

          const formatCheck = new Gtk.CheckButton({
            valign: Gtk.Align.CENTER,
            // ⚠️ A gap is always formatted and it is never a question: there is
            // nothing on it to keep. Ticked and left insensitive below, so the
            // column still SAYS what will happen rather than going blank — the
            // same rule the filesystem cell follows.
            active: p.isFree ? true : currentEntry ? currentEntry.format : false,
          })
          formatCheck.update_property(
            [Gtk.AccessibleProperty.LABEL], [`${t("diskFormat")} — ${rowName}`])

          const fsStringList = Gtk.StringList.new(FS_OPTIONS)
          const fsDropDown = NidaraDropDown({
            model: fsStringList,
            valign: Gtk.Align.CENTER,
            accessibleDescription: `${t("diskFs")} — ${rowName}`,
          })
          const curFsIdx = currentEntry ? FS_OPTIONS.indexOf(currentEntry.filesystem) : 0
          fsDropDown.set_selected(curFsIdx >= 0 ? curFsIdx : 0)

          // ── Three states, one meaning ──────────────────────────────────────
          //
          // The row swaps the dropdown's MODEL rather than greying a list that
          // still shows something else. That was already true for swap rows — a
          // partition about to be `mkswap`ed must not sit there offering btrfs,
          // "a control showing a value that was not going to be used, which is
          // the same lie as a greyed control still displaying one" (#423) — and
          // merging the two columns makes the rule general:
          //
          //   keep    format off, or no mount point   → the filesystem it ALREADY
          //                                             has (or an em dash), fixed
          //   swap    mount point is swap             → `swap`, fixed
          //   choose  format on, anything else        → the real list, editable
          //
          // In every one of them the cell reads as the answer to the same
          // question, which is the whole point of there being one column.
          //
          // `lastFsIdx` remembers the real choice across the other two states, so
          // ticking Format back on does not silently reset a row to btrfs.
          // `swapping` is not decoration: `set_model` moves the selection and
          // re-enters the handler below.
          const swapStringList = Gtk.StringList.new(["swap"])
          const keptStringList = Gtk.StringList.new([keptFsLabel])
          type FsMode = "keep" | "swap" | "choose"
          let fsMode: FsMode = "choose"
          let swapping = false
          let lastFsIdx = fsDropDown.get_selected()
          const setFsMode = (mode: FsMode) => {
            if (mode === fsMode) return
            if (fsMode === "choose") lastFsIdx = fsDropDown.get_selected()
            swapping = true
            fsMode = mode
            fsDropDown.set_model(
              mode === "swap" ? swapStringList : mode === "keep" ? keptStringList : fsStringList)
            fsDropDown.set_selected(mode === "choose" ? lastFsIdx : 0)
            swapping = false
          }

          // The same rule `updatePartitionState` keeps, applied to the state the
          // row is BORN in — a page rebuilt from existing answers (walking back to
          // this step, or changing the language) has rows that are already
          // answered, and had they only been sensitive after a change, half the
          // table would have opened greyed out.
          const initialMount = MOUNT_OPTIONS[initialMountIdx]?.mountpoint ?? ""
          const modeFor = (mount: string, doFormat: boolean): FsMode =>
            mount === "swap" ? "swap" : (mount !== "" && (doFormat || p.isFree)) ? "choose" : "keep"
          setFsMode(modeFor(initialMount, formatCheck.active))
          formatCheck.set_sensitive(!p.isFree && initialMount !== "")
          // Editable exactly where the value is a choice; everywhere else the cell
          // still SAYS something true, which is why it is not simply blanked.
          fsDropDown.set_sensitive(modeFor(initialMount, formatCheck.active) === "choose")

          const updatePartitionState = () => {
            const selIdx = mountDropDown.get_selected()
            const chosenMount = MOUNT_OPTIONS[selIdx]?.mountpoint ?? ""
            const shouldFormat = formatCheck.active
            const isSwap = chosenMount === "swap"
            const mode = modeFor(chosenMount, shouldFormat)
            if (fsMode === "choose") lastFsIdx = fsDropDown.get_selected()
            setFsMode(mode)
            // Read from `lastFsIdx`, not from the widget: in `keep` and `swap` the
            // model is a one-item list and the selection is 0, which would answer
            // btrfs for every row. What the plan does with it is unchanged —
            // `manualDiskConfig` ignores `filesystem` entirely unless `format`.
            const chosenFs = (!isSwap && FS_OPTIONS[mode === "choose" ? fsDropDown.get_selected() : lastFsIdx]) || "btrfs"

            // The rest of the row answers a question the mount point asks. With no
            // mount point there is no question: the partition is not part of this
            // install, and a live "Format" tick on it is a control that does
            // nothing — which on THIS page reads as a promise to erase something.
            formatCheck.set_sensitive(!p.isFree && chosenMount !== "")
            fsDropDown.set_sensitive(mode === "choose")

            if (!chosenMount) {
              manualMounts.delete(p.key)
            } else {
              manualMounts.set(p.key, {
                name: p.name,
                path: p.path,
                device: p.device,
                start: p.start,
                size: p.size,
                logicalSectorSize: p.logicalSectorSize,
                fsType: p.fstype,
                label: p.label,
                mountpoint: chosenMount,
                filesystem: chosenFs,
                // A created partition is formatted by construction, and saying so
                // here is what lets every rule in `manual-problems.ts` stay as it
                // is: all of them are written against `format`.
                format: p.isFree ? true : shouldFormat,
                ...(p.isFree ? { create: true as const } : {}),
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
              // …and if it IS going to be formatted, with the only filesystem a
              // firmware can read. The default was btrfs, which is how a valid
              // layout produced a machine that does not boot. Still a default and
              // not a lock: the row can be changed, and `manualProblems` is what
              // refuses the change rather than a control that pretends it cannot
              // be made.
              const vfatIdx = FS_OPTIONS.indexOf("vfat")
              if (formatCheck.active && vfatIdx >= 0) fsDropDown.set_selected(vfatIdx)
            } else if (chosenMount === "/") {
              formatCheck.active = true
            } else if (chosenMount === "swap") {
              // Same shape as the ESP default above: a partition that is already
              // swap is left alone, one that is not has to be made into swap
              // before anything can be activated on it.
              formatCheck.active = p.fstype !== "swap"
            }
            updatePartitionState()
          })

          formatCheck.connect("toggled", updatePartitionState)
          fsDropDown.connect("notify::selected", () => {
            if (swapping) return
            updatePartitionState()
          })

          table.appendRow([
            rowName,
            formatSize(p.size),
            mountDropDown,
            formatCheck,
            fsDropDown,
          ])
        }
      }

      buildPartitionsList()
      // ⚠️ And SAY what is still missing, on arrival. Every other path into this
      // label goes through `syncAnswer`, which only runs when a control changes —
      // so a page rebuilt from answers that are already there (walking back from
      // the account step, or changing the language) came up with an empty warning
      // area and a dead Continue button. That is D-16 again through a side door:
      // the refusal was visible only to whoever had just caused it.
      refreshProblems()

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
        // ⚠️ The failure used to land in `console.error`, which on the medium is
        // a stream with no reader: the installer's window has no console and the
        // session's journal is not something anybody is looking at while they
        // are trying to make room on a disk. Pressing the button did nothing,
        // said nothing, and looked exactly like a program that had opened
        // somewhere behind the window.
        //
        // It matters more now than when it was written, because since
        // nidara-project/nidara-iso#23 the program is actually ON the medium —
        // so a silence here is no longer "we do not ship it", it is a real
        // failure. The likeliest one is escalation: GParted needs root and asks
        // for it through pkexec, which needs an authentication agent and the
        // live account's password. That password is `nidara` and it is on the
        // boot menu, but somebody who does not know that sees a prompt they
        // cannot answer, cancels it, and lands back here — which is precisely
        // the case that has to say something.
        editorError = ""
        refreshProblems?.()
        gpartedBtn.sensitive = false
        execAsync(["gparted"])
          .then(() => {
            // It exited, so the disk may be a different shape than the table is
            // showing. Re-reading it is the whole point of having sent somebody
            // to an editor, and leaving it to the Refresh button next door means
            // the page can sit there describing a layout that no longer exists.
            buildPartitionsList()
            syncAnswer()
          })
          .catch(e => {
            editorError = t("diskErrGpartedFailed")
            refreshProblems?.()
            console.error("[Installer] Failed to launch GParted:", e)
          })
          .finally(() => { gpartedBtn.sensitive = true })
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
