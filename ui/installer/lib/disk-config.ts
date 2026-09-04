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
import type {
  EntireDiskAnswer,
  FilesystemType,
  ManualDiskAnswer,
  ManualPartitionMount,
} from "./answers"

const MIB = 1024 * 1024

/** `{value, unit}` — archinstall's `SectorSize`. */
interface SectorSize {
  value: number
  unit: "B"
}

/**
 * `{value, unit, sector_size}` — archinstall's `Size`.
 *
 * Two units are in play and both are its own (`Unit`): entire-disk mode writes
 * MiB because that is what `suggest_single_disk_layout` computes in and what its
 * alignment check is about, and manual mode writes bytes because that is what
 * `lsblk` reports about partitions that already exist and rounding them would
 * move them.
 */
interface ArchSize {
  value: number
  unit: "MiB" | "B"
  sector_size: SectorSize
}

interface Subvolume {
  name: string
  mountpoint: string
}

interface Partition {
  obj_id: string
  /**
   * `create` writes a partition that is not there yet; `existing` and `modify`
   * both name one that is, and the difference between them is the Format tick —
   * see `manualDiskConfig`.
   */
  status: "create" | "existing" | "modify"
  type: "primary"
  start: ArchSize
  size: ArchSize
  fs_type: string | null
  mountpoint: string | null
  mount_options: string[]
  /** Null for a partition being created; the device for one that already exists. */
  dev_path: string | null
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

// ─── MANUAL MODE ─────────────────────────────────────────────────────────────
//
// The other half of #310, and the one that deletes code rather than adding it:
// until now `steps/run.ts` ran `mkfs.*` and `mount` for every row of the manual
// table and archinstall was handed a finished `/mnt` (`pre_mounted_config`).
// Three of the four level-1 findings of the installer study lived in those forty
// lines, and none of them survives the move:
//
//   · H-02 — `swap` was a mount POINT like any other, so we ran `mkfs.ext4` over
//     the partition and then `mount /dev/… /mnt/swap`. archinstall knows swap is
//     not a place: `mkswap` on format, `swapon` on mount, and genfstab writes the
//     entry (`installer._mount_partition`, `device_handler.format`).
//   · H-04's sibling, the ESP path: what patches the bootloader afterwards now
//     reads the ESP's mount point from the same answer this file does, instead of
//     assuming /boot (lib/bootloader.ts).
//   · And the arm/dry-run split, which had three commands escaping it, stops
//     existing along with the commands.
//
// ⚠️ **`modify` is a DELETE and a re-create, not an in-place mkfs.** It is what
// upstream's own partitioning menu sets when you tick format on an existing
// partition (`partitioning_menu._prompt_formatting`), and `_setup_partition`
// then deletes the partition and adds it back at the start and length from this
// JSON before formatting it. Two consequences, both deliberate:
//
//   · The numbers must be EXACT, which is why `start` and `size` are carried in
//     bytes from `lsblk` and not recomputed from anything.
//   · parted re-adds it under `optimalAlignedConstraint`, so a legacy partition
//     that does not sit on a MiB boundary is REFUSED — before `disk.commit()`,
//     so nothing has been written — where we used to reformat it quietly. That is
//     upstream's behaviour for every archinstall user who ticks format, and this
//     is what adopting it means.
//
// A row without the tick is `existing`: archinstall skips it in both
// `partition()` and `_format_partitions()` and only mounts it.

/**
 * Which of the assigned mounts holds the EFI system partition, if any.
 *
 * The rule is one rule and it lives here because three places need the same
 * answer and disagreeing would be silent: the page that refuses a non-FAT ESP,
 * the layout below that has to flag it `boot`/`esp` for archinstall to find it,
 * and the bootloader patching that has to write into the partition archinstall
 * actually installed onto.
 *
 * With `/boot/efi` or `/efi` assigned, THAT is the ESP and `/boot` is an ordinary
 * boot partition which may legitimately not be FAT. Only when `/boot` is the sole
 * EFI-ish mount is `/boot` itself the ESP.
 */
export function espMount(mounts: readonly ManualPartitionMount[]): ManualPartitionMount | undefined {
  return mounts.find(m => m.mountpoint === "/boot/efi" || m.mountpoint === "/efi")
    ?? mounts.find(m => m.mountpoint === "/boot")
}

/**
 * What `lsblk` says is on a partition, in archinstall's vocabulary — for the rows
 * that are NOT being formatted, where the filesystem is a fact rather than a
 * choice.
 *
 * ⚠️ An unknown value is `null`, never a guess. `FilesystemType(<value>)` raises
 * on anything outside its own enum, and that exception lands as a configuration
 * archinstall refuses *after* every question has been answered. `null` is
 * allowed for an existing partition (only `modify` demands a type), it is what
 * upstream itself stores for a filesystem it does not model, and `mount` detects
 * the type by itself anyway.
 */
function existingFsType(fsType: string | null): string | null {
  switch (fsType) {
    case "btrfs": case "ext2": case "ext3": case "ext4":
    case "f2fs": case "ntfs": case "xfs":
      return fsType
    // lsblk cannot tell FAT12/16/32 apart under `FSTYPE`; the distinction is only
    // ever asked as `is_fat()`, which all three answer the same way.
    case "vfat":
      return "fat32"
    case "swap":
      return "linux-swap"
    default:
      return null
  }
}

/**
 * Build the `disk_config` for manual mode: the rows of the table, in archinstall's
 * schema, grouped by the disk each partition is on.
 */
export function manualDiskConfig(answer: ManualDiskAnswer): DiskConfig {
  const assigned = answer.mounts.filter(m => m.mountpoint !== "")
  const esp = espMount(assigned)

  const byDevice = new Map<string, Partition[]>()

  for (const m of assigned) {
    const sector_size: SectorSize = { value: m.logicalSectorSize, unit: "B" }
    const bytes = (value: number): ArchSize => ({ value, unit: "B", sector_size })

    // Swap is not a place, so it has no mount point — `_mount_partition` reaches
    // its `swapon` branch precisely by finding none and a `linux-swap` type.
    const isSwap = m.mountpoint === "swap"

    const partition: Partition = {
      obj_id: GLib.uuid_string_random(),
      status: m.format ? "modify" : "existing",
      type: "primary",
      start: bytes(m.start),
      size: bytes(m.size),
      fs_type: m.format
        ? (isSwap ? "linux-swap" : fsType(m.filesystem))
        : existingFsType(m.fsType),
      mountpoint: isSwap ? null : m.mountpoint,
      // Deliberately none, which is what the hand-rolled `mount` passed. The
      // subvolumes and `compress=zstd` of entire-disk mode are not here: a manual
      // root is the layout the person brought, and giving it ours would be a
      // product decision taken in a translation function.
      mount_options: [],
      dev_path: m.path,
      // What makes archinstall find the ESP at all (`get_efi_partition` filters on
      // this flag); on a real EFI partition it is also what the GPT already says.
      flags: esp && m.path === esp.path ? ["boot", "esp"] : [],
      btrfs: [],
    }

    const partitions = byDevice.get(m.device)
    if (partitions) partitions.push(partition)
    else byDevice.set(m.device, [partition])
  }

  return {
    config_type: "manual_partitioning",
    device_modifications: [...byDevice].map(([device, partitions]) => ({
      device,
      // ⚠️ Never. This is the mode whose whole promise is that everything not
      // named in the table is left alone, and `wipe` writes a fresh GPT over the
      // entire disk.
      wipe: false,
      partitions,
    })),
  }
}
