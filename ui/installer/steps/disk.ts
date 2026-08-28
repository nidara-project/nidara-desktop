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
import { heading, prose } from "./common"

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

const MOUNT_OPTIONS = [
  { id: "", labelKey: "diskMountNone", mountpoint: "" },
  { id: "/", labelKey: "diskMountRoot", mountpoint: "/" },
  { id: "/boot", labelKey: "diskMountBoot", mountpoint: "/boot" },
  { id: "/boot/efi", labelKey: "diskMountBootEfi", mountpoint: "/boot/efi" },
  { id: "/efi", labelKey: "diskMountEfi", mountpoint: "/efi" },
  { id: "/home", labelKey: "diskMountHome", mountpoint: "/home" },
  { id: "swap", labelKey: "diskMountSwap", mountpoint: "swap" },
] as const

const FS_OPTIONS: FilesystemType[] = ["btrfs", "ext4", "xfs", "f2fs", "vfat"]

export function DiskStep(): Step {
  return {
    id: "disk",
    title: () => t("diskTitle"),
    nextLabel: () => t("continue"),
    ready: () => {
      const a = getAnswers().disk
      if (!a) return false
      if (a.mode === "entire_disk") return a.disk !== null
      if (a.mode === "manual") {
        const hasRoot = a.mounts.some(m => m.mountpoint === "/")
        if (!hasRoot) return false
        if (isUefi()) {
          const hasBoot = a.mounts.some(m => m.mountpoint === "/boot" || m.mountpoint === "/boot/efi" || m.mountpoint === "/efi")
          if (!hasBoot) return false
        }
        return true
      }
      return false
    },

    build(notifyReady) {
      const rootBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
        hexpand: true,
      })

      rootBox.append(heading(t("diskHeading")))

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
        notifyReady?.()
      }

      // ── Mode Switcher ──────────────────────────────────────────────────
      const { box: modeListBoxContainer, listBox: modeListBox } = NidaraList()
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
      const { box: diskListBoxContainer, listBox: diskListBox } = NidaraList()
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

          const gib = (disk.size / (1024 ** 3)).toFixed(1)
          const title = disk.model || disk.name
          const subtitle = `${gib} GiB · ${disk.path}${disk.rm ? ` · ${t("diskRemovable")}` : ""}`

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
      const { box: fsListBoxContainer, listBox: fsListBox } = NidaraList()
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

      // Top action bar: Launch GParted + Refresh
      const manualActions = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.START,
      })

      const gpartedBtn = NidaraButton({
        label: t("diskLaunchGparted"),
        variant: "secondary",
      })
      gpartedBtn.connect("clicked", () => {
        try {
          execAsync(["gparted"])
        } catch (e) {
          console.error("[Installer] Failed to launch GParted:", e)
        }
      })

      const refreshBtn = NidaraButton({
        label: t("diskRefresh"),
        variant: "secondary",
      })

      manualActions.append(gpartedBtn)
      manualActions.append(refreshBtn)
      manualBox.append(manualActions)

      const partListHolder = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        hexpand: true,
      })

      const buildPartitionsList = () => {
        while (partListHolder.get_first_child()) {
          partListHolder.remove(partListHolder.get_first_child()!)
        }

        const partitions = listPartitions()
        const { box: partListBoxContainer, listBox: partListBox } = NidaraList()

        if (partitions.length === 0) {
          partListBox.append(NidaraEmptyRow(t("diskNoDisks")))
        } else {
          for (const p of partitions) {
            const gib = (p.size / (1024 ** 3)).toFixed(1)
            const currentEntry = manualMounts.get(p.path)

            const title = `${p.path}  (${gib} GiB)`
            const sub = [p.fstype, p.label].filter(Boolean).join(" · ") || t("diskPartitions")

            // Right control box
            const ctrlBox = new Gtk.Box({
              orientation: Gtk.Orientation.HORIZONTAL,
              spacing: 8,
              valign: Gtk.Align.CENTER,
            })

            // Mountpoint dropdown
            const mountStrings = MOUNT_OPTIONS.map(opt => t(opt.labelKey))
            const mountStringList = Gtk.StringList.new(mountStrings)
            const mountDropDown = NidaraDropDown({
              model: mountStringList,
              valign: Gtk.Align.CENTER,
            })

            let initialMountIdx = 0
            if (currentEntry) {
              const idx = MOUNT_OPTIONS.findIndex(opt => opt.mountpoint === currentEntry.mountpoint)
              if (idx !== -1) initialMountIdx = idx
            }
            mountDropDown.set_selected(initialMountIdx)

            // Format checkbox
            const formatCheck = new Gtk.CheckButton({
              label: t("diskFormat"),
              valign: Gtk.Align.CENTER,
              active: currentEntry ? currentEntry.format : false,
            })

            // Filesystem dropdown
            const fsStringList = Gtk.StringList.new(FS_OPTIONS)
            const fsDropDown = NidaraDropDown({
              model: fsStringList,
              valign: Gtk.Align.CENTER,
            })
            const curFsIdx = currentEntry ? FS_OPTIONS.indexOf(currentEntry.filesystem) : 0
            fsDropDown.set_selected(curFsIdx >= 0 ? curFsIdx : 0)
            fsDropDown.set_sensitive(formatCheck.active)

            const updatePartitionState = () => {
              const selIdx = mountDropDown.get_selected()
              const chosenMount = MOUNT_OPTIONS[selIdx]?.mountpoint ?? ""
              const shouldFormat = formatCheck.active
              const chosenFs = FS_OPTIONS[fsDropDown.get_selected()] || "btrfs"

              fsDropDown.set_sensitive(shouldFormat)

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
              if (chosenMount === "/boot" || chosenMount === "/boot/efi" || chosenMount === "/efi") {
                formatCheck.active = p.fstype !== "vfat"
              } else if (chosenMount === "/") {
                formatCheck.active = true
              }
              updatePartitionState()
            })

            formatCheck.connect("toggled", updatePartitionState)
            fsDropDown.connect("notify::selected", updatePartitionState)

            ctrlBox.append(mountDropDown)
            ctrlBox.append(formatCheck)
            ctrlBox.append(fsDropDown)

            const row = NidaraRow(title, sub, ctrlBox)
            partListBox.append(row)
          }
        }

        partListHolder.append(partListBoxContainer)
      }

      buildPartitionsList()
      refreshBtn.connect("clicked", () => {
        buildPartitionsList()
        syncAnswer()
      })

      manualBox.append(partListHolder)
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

      // Initial sync
      syncAnswer()

      return rootBox
    },
  }
}
