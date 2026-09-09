// BitLocker volume detection and warnings for manual disk partitioning (#448).
//
// An encrypted BitLocker volume cannot be shrunk from Linux (GParted refuses it
// and archinstall cannot resize it). The remedy must take place in Windows:
// suspend or disable BitLocker before resizing.
//
// libblkid (and thus lsblk) identifies BitLocker volumes by the filesystem type
// "BitLocker". The check is case-insensitive, following the precedent in
// ui/installer/lib/bootloader.ts:233.

import { t } from "./i18n"

/**
 * Checks whether an fstype string identifies a BitLocker encrypted volume.
 * Always compared case-insensitively.
 */
export function isBitlocker(fstype: string | null | undefined): boolean {
  return typeof fstype === "string" && fstype.toLowerCase() === "bitlocker"
}

export interface BlockDeviceItem {
  name?: string
  path?: string
  fstype?: string | null
  children?: BlockDeviceItem[]
}

export interface LsblkJson {
  blockdevices?: BlockDeviceItem[]
}

/**
 * Resolves the device path for a partition item, preferring `path` (e.g. /dev/sda2)
 * or prepending `/dev/` to `name` if `path` is absent (such as in `lsblk -o NAME,FSTYPE`).
 */
function resolveDevicePath(item: BlockDeviceItem): string {
  if (item.path && item.path.length > 0) return item.path
  if (item.name && item.name.length > 0) {
    return item.name.startsWith("/") ? item.name : `/dev/${item.name}`
  }
  return ""
}

/**
 * Finds all block devices or partitions matching BitLocker filesystem type.
 * Accepts:
 * - a raw JSON string from `lsblk -J`
 * - a parsed `LsblkJson` object with `blockdevices`
 * - a flat or tree list of `BlockDeviceItem[]` (such as `DetectedPartition[]`)
 */
export function findBitlockerDevices(input: string | LsblkJson | BlockDeviceItem[]): string[] {
  try {
    let items: BlockDeviceItem[]
    if (typeof input === "string") {
      const parsed = JSON.parse(input)
      items = parsed.blockdevices ?? []
    } else if (Array.isArray(input)) {
      items = input
    } else {
      items = input.blockdevices ?? []
    }

    const results: string[] = []
    const walk = (list: BlockDeviceItem[]) => {
      for (const item of list) {
        if (isBitlocker(item.fstype)) {
          const path = resolveDevicePath(item)
          if (path) results.push(path)
        }
        if (item.children) walk(item.children)
      }
    }

    walk(items)
    return results
  } catch (e) {
    console.error("[Installer] Failed to parse block devices for BitLocker:", e)
    return []
  }
}

/**
 * Generates warning strings for the given device paths in the current locale.
 */
export function bitlockerWarnings(devicePaths: string[]): string[] {
  return devicePaths.map(dev => t("diskWarnBitlocker").replace("%s", dev))
}
