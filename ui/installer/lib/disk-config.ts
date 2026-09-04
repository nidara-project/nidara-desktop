// The disk layout, written in archinstall's own schema instead of in sgdisk.
//
// ─── WHAT CHANGED, AND WHAT DID NOT ──────────────────────────────────────────
// Until now `steps/run.ts` ran `sgdisk`, `mkfs.*`, `btrfs subvolume create` and
// `mount` with its own hands, and archinstall was handed a `/mnt` already made
// (`pre_mounted_config`). That was never a decision anybody wrote down — it
// arrived inside PR #281, whose message is about sidebar metrics — and it is
// where three of the four level-1 findings of the installer review live: the ESP
// formatted as btrfs, swap mounted as a directory, an ESP path desync that makes
// our bootloader patching a silent no-op. Under `manual_partitioning` those stop
// existing along with the code that produced them (nidara-desktop#310).
//
// ⚠️ **The layout is unchanged.** Not "close enough" — the same numbers:
//
//   sgdisk -n 1:1M:+512M -t 1:ef00   →  start 1 MiB, size 512 MiB, flags boot+esp
//   mkfs.vfat -F32 ; mount /mnt/boot →  fs_type "fat32", mountpoint "/boot"
//   sgdisk -n 2:0:0                  →  start 513 MiB, the rest of the disk
//   @ @home @log @pkg @snapshots     →  the same five, same mountpoints
//   mount -o compress=zstd           →  mount_options ["compress=zstd"]
//
// That is the whole reason option A was affordable: `manual_partitioning` takes
// the sizes and the subvolume list from the JSON with no restriction of its own
// (`lib/models/device.py`, `DiskLayoutConfiguration.parse_arg`). What upstream's
// `default_layout` would have cost us — a 1 GiB ESP and four subvolumes, no
// `@snapshots` — it does not ask for here.
//
// ─── WHY THE ARITHMETIC IS COPIED AND NOT INVENTED ───────────────────────────
// archinstall's schema has no "the rest of the disk": every partition is an
// absolute start and an absolute length, and `parse_arg` VALIDATES them — the
// first must start at ≥ 1 MiB, none may overlap, every start and length must be
// MiB-aligned, and the last must not reach into the backup GPT header. Four ways
// to be refused after the user has already answered every question.
//
// So the sums below are `suggest_single_disk_layout`'s, transcribed
// (`lib/disk/disk_menu.py`):
//
//   available  = total.gpt_end().align()       // minus 1 MiB, then floor to MiB
//   root_start = esp.start + esp.length
//   root_size  = available - root_start
//
// ⚠️ And with subvolumes the ROOT partition carries `mountpoint: null`. The
// mountpoints live on the subvolumes; giving it one as well mounts the root
// twice, at the same path, from the same device. Upstream writes it as
// `mountpoint=Path('/') if not using_subvolumes else None` and it is easy to
// read past.

import GLib from "gi://GLib"
import type { EntireDiskAnswer, FilesystemType } from "./answers"

const MIB = 1024 * 1024

/** `{value, unit}` — archinstall's `SectorSize`. */
interface SectorSize {
  value: number
  unit: "B"
}

/** `{value, unit, sector_size}` — archinstall's `Size`. */
interface ArchSize {
  value: number
  unit: "MiB"
  sector_size: SectorSize
}

interface Subvolume {
  name: string
  mountpoint: string
}

interface Partition {
  obj_id: string
  status: "create"
  type: "primary"
  start: ArchSize
  size: ArchSize
  fs_type: string | null
  mountpoint: string | null
  mount_options: string[]
  dev_path: null
  flags: string[]
  btrfs: Subvolume[]
}

interface DeviceModification {
  device: string
  wipe: boolean
  partitions: Partition[]
}

export interface DiskConfig {
  config_type: "manual_partitioning"
  device_modifications: DeviceModification[]
}

/**
 * The five subvolumes, and the one that is ours.
 *
 * Upstream's default set is the first four; `@snapshots` is Nidara's, and it is
 * the reason this bundle emits its own layout instead of asking archinstall for
 * a suggested one.
 */
const SUBVOLUMES: Subvolume[] = [
  { name: "@", mountpoint: "/" },
  { name: "@home", mountpoint: "/home" },
  { name: "@log", mountpoint: "/var/log" },
  { name: "@pkg", mountpoint: "/var/cache/pacman/pkg" },
  { name: "@snapshots", mountpoint: "/.snapshots" },
]

/** Our filesystem names are already archinstall's, except that ext4 is spelled the same. */
function fsType(fs: FilesystemType): string {
  return fs === "vfat" ? "fat32" : fs
}

const ESP_START_MIB = 1
const ESP_SIZE_MIB = 512

/**
 * The smallest disk this layout can be written onto, past which the numbers stop
 * meaning anything: 512 MiB of ESP plus a root partition with room for the base
 * system and the desktop. It exists to fail HERE, naming the disk, rather than
 * as an archinstall traceback after the summary page has been confirmed.
 */
const MIN_ROOT_MIB = 8 * 1024

/**
 * Build the `disk_config` for entire-disk mode.
 *
 * @throws if the chosen disk cannot hold the layout — the caller reports it as a
 *         failure to assemble the plan, before anything is armed.
 */
export function entireDiskConfig(answer: EntireDiskAnswer): DiskConfig {
  const disk = answer.disk
  const sector_size: SectorSize = { value: disk.logicalSectorSize, unit: "B" }
  const mib = (value: number): ArchSize => ({ value, unit: "MiB", sector_size })

  // `total.gpt_end().align()`: one MiB is reserved for the backup GPT header at
  // the end of the device, and what remains is floored to a MiB boundary because
  // an unaligned length is refused.
  const availableMib = Math.floor((disk.size - MIB) / MIB)
  const rootStartMib = ESP_START_MIB + ESP_SIZE_MIB
  const rootSizeMib = availableMib - rootStartMib

  if (rootSizeMib < MIN_ROOT_MIB) {
    throw new Error(
      `${disk.path} is too small for Nidara: ${Math.max(0, rootSizeMib)} MiB would be left for the `
      + `system after a ${ESP_SIZE_MIB} MiB EFI partition, and at least ${MIN_ROOT_MIB} MiB is needed.`,
    )
  }

  const useSubvolumes = answer.filesystem === "btrfs"

  const esp: Partition = {
    obj_id: GLib.uuid_string_random(),
    status: "create",
    type: "primary",
    start: mib(ESP_START_MIB),
    size: mib(ESP_SIZE_MIB),
    fs_type: "fat32",
    mountpoint: "/boot",
    mount_options: [],
    dev_path: null,
    // `boot` and `esp` are the two parted flags that make firmware find it; they
    // are what `sgdisk -t 1:ef00` was saying in the other vocabulary.
    flags: ["boot", "esp"],
    btrfs: [],
  }

  const root: Partition = {
    obj_id: GLib.uuid_string_random(),
    status: "create",
    type: "primary",
    start: mib(rootStartMib),
    size: mib(rootSizeMib),
    fs_type: fsType(answer.filesystem),
    // ⚠️ null when there are subvolumes — see the header.
    mountpoint: useSubvolumes ? null : "/",
    // Applied to every subvolume mount, which is what the hand-rolled version
    // did by repeating `-o compress=zstd` on each `mount`.
    mount_options: useSubvolumes ? ["compress=zstd"] : [],
    dev_path: null,
    flags: [],
    btrfs: useSubvolumes ? SUBVOLUMES : [],
  }

  return {
    config_type: "manual_partitioning",
    device_modifications: [
      {
        device: disk.path,
        // The `sgdisk --zap-all` this replaces: archinstall wipes the device,
        // writes a fresh GPT, and runs `wipefs --all` on each partition it then
        // creates (`device_handler.partition`).
        wipe: true,
        partitions: [esp, root],
      },
    ],
  }
}
