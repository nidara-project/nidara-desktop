// disk-config-probe — is the layout we hand archinstall one it will accept?
//
//   ./scripts/bundle.sh --js scripts/dev/disk-config-probe.ts /tmp/disk-config-probe.js \
//     && gjs -m /tmp/disk-config-probe.js
//
// No window, no GTK, no disk: it calls `entireDiskConfig()` with disk sizes and
// `manualDiskConfig()` with rows of a table nobody filled in, so it is safe on
// any machine and says nothing about the one it runs on.
//
// ─── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
// `manual_partitioning` has no "the rest of the disk". Every partition is an
// absolute start and an absolute length, and archinstall REFUSES four kinds of
// wrong (`DiskLayoutConfiguration.parse_arg`): a first partition below 1 MiB,
// overlapping partitions, a start or length that is not MiB-aligned, and a last
// partition reaching into the backup GPT header.
//
// All four are arithmetic, all four depend on the size of a disk nobody has in
// front of them while writing the code, and all four are reported at the worst
// possible moment — after the user has answered every question, on the medium,
// with the summary already confirmed. So the sums are checked here, against the
// sizes that actually turn up: two real drives, the VM's disk, a 4Kn drive, and a
// capacity that is not a whole number of MiB.
//
// It also checks two things archinstall cannot check for us, because they are
// not errors to it:
//
//   · that nothing is LEFT OVER. A layout that quietly ends a gigabyte early is
//     perfectly valid and silently smaller than the disk somebody bought.
//   · that a btrfs root has subvolumes and NO mountpoint of its own. Both is
//     accepted and mounts the root twice; upstream writes this as
//     `mountpoint=Path('/') if not using_subvolumes else None`.
//   · that no subvolume lands on a path a PARTITION of the same layout claims.
//     archinstall validates geometry and nothing about mount points being
//     unique, so `@home` at /home beside a partition at /home is accepted, and
//     what follows is silent: the root sorts first, `@home` is mounted, the
//     partition is mounted on top of it, the install writes into the upper
//     layer, and the machine boots with the empty subvolume mounted and the
//     person's files under a shadowed mount. Nothing downstream catches it —
//     the install succeeds and the failure appears at the first login.
//
// ⚠️ **It has been shown to fail, in both halves.** Five deliberate defects in
// the entire-disk sums were introduced one at a time and each was caught by name:
// ESP starting at 0, a root one MiB too long, a length that is not MiB-aligned, a
// root carrying both a mountpoint and subvolumes, and `@snapshots` dropped back to
// upstream's four. Manual mode was put through twelve: swap keeping its mount
// point, the format tick inverted, nothing flagged as the ESP, the ESP rule
// reversed so `/boot` beats `/boot/efi`, `wipe: true`, the start rounded down to a
// MiB, the size rounded up, the sector size assumed to be 512, an unknown
// filesystem passed straight through, a `modify` taking its type from lsblk
// instead of the choice, partitions grouped by path instead of by disk, and
// unassigned rows sent along anyway.
//
// Three more went in with the subvolume checks, each caught by name: the full
// five emitted without filtering out a claimed path, a subvolumed root keeping
// its own `/` mountpoint, and `compress=zstd` dropped. The first of those was
// caught in a fixture that predates it — "two disks: system on the NVMe, /home
// on the spinning one" is a collision that was already in this table.
//
// ⚠️ **One of those twelve was not caught the first time**, and it is the reason
// the misaligned case below exists: rounding the start down to a MiB changed
// nothing, because every layout here began on a MiB boundary. The probe printed
// ALL INVARIANTS HOLD over a translation that moves partitions. A probe that has
// only ever printed "ok" has not been tested, it has been run — and a probe whose
// fixtures are all well-behaved is the same thing wearing a check.

import { entireDiskConfig, manualDiskConfig, espMount } from "../../ui/installer/lib/disk-config"
import { loaderRoot } from "../../ui/installer/lib/bootloader"
import { swapFstabEntry } from "../../ui/installer/lib/swap"
import { manualProblems } from "../../ui/installer/lib/manual-problems"
import { freeSpaceGaps } from "../../ui/installer/lib/free-space"
import { t } from "../../ui/installer/lib/i18n"
import type {
  EntireDiskAnswer,
  FilesystemType,
  ManualDiskAnswer,
  ManualPartitionMount,
} from "../../ui/installer/lib/answers"

const MIB = 1024 * 1024

const CASES: Array<{ name: string, size: number, sector: number, fs: FilesystemType }> = [
  { name: "500 GB NVMe", size: 500107862016, sector: 512, fs: "btrfs" },
  { name: "1 TB SATA SSD", size: 1000204886016, sector: 512, fs: "btrfs" },
  { name: "20 GiB VM disk", size: 20 * 1024 * MIB, sector: 512, fs: "btrfs" },
  { name: "20 GiB VM disk, ext4", size: 20 * 1024 * MIB, sector: 512, fs: "ext4" },
  { name: "4Kn 2 TB", size: 2000398934016, sector: 4096, fs: "btrfs" },
  { name: "not a whole number of MiB", size: 20 * 1024 * MIB + 777777, sector: 512, fs: "btrfs" },
  { name: "8.6 GiB, just above the floor", size: Math.round(8.6 * 1024 * MIB), sector: 512, fs: "btrfs" },
  { name: "8 GiB, below the floor", size: 8 * 1024 * MIB, sector: 512, fs: "btrfs" },
]

let failures = 0
function fail(name: string, msg: string): void {
  failures++
  print(`   ✗ ${name}: ${msg}`)
}

for (const c of CASES) {
  const answer = {
    mode: "entire_disk",
    filesystem: c.fs,
    disk: {
      name: "probe", path: "/dev/probe", size: c.size,
      model: null, rm: false, logicalSectorSize: c.sector,
    },
  } as EntireDiskAnswer

  let config: ReturnType<typeof entireDiskConfig>
  try {
    config = entireDiskConfig(answer)
  } catch (e: any) {
    // Refusing a disk that cannot hold the layout is an ANSWER, not a failure —
    // the last case is here to be refused, and it names the disk when it is.
    print(`\n${c.name} (${c.size} B)\n   refused: ${e?.message ?? e}`)
    continue
  }

  const parts = config.device_modifications[0].partitions
  const bytes = (s: { value: number }) => s.value * MIB
  const espEnd = bytes(parts[0].start) + bytes(parts[0].size)
  const rootEnd = bytes(parts[1].start) + bytes(parts[1].size)
  const gptEnd = c.size - MIB

  print(`\n${c.name} (${c.size} B, ${c.sector} B/sector, ${c.fs})`)
  for (const p of parts) {
    const where = p.mountpoint ?? (p.btrfs.length ? "(subvols)" : "(none)")
    print(`   ${where.padEnd(10)} start=${p.start.value} MiB  size=${p.size.value} MiB  fs=${p.fs_type}  flags=[${p.flags}]`)
  }

  // archinstall's four
  if (bytes(parts[0].start) < MIB) fail(c.name, "first partition starts below 1 MiB")
  if (bytes(parts[1].start) < espEnd) fail(c.name, "partitions overlap")
  for (const p of parts) {
    if (bytes(p.start) % MIB !== 0 || bytes(p.size) % MIB !== 0) fail(c.name, "start or length is not MiB-aligned")
    if (p.size.value <= 0) fail(c.name, "non-positive length")
  }
  if (rootEnd > gptEnd) fail(c.name, `overlaps the backup GPT header (end=${rootEnd} > gpt_end=${gptEnd})`)

  // and ours
  const wasted = gptEnd - rootEnd
  if (wasted >= MIB) fail(c.name, `${Math.floor(wasted / MIB)} MiB of the disk left unclaimed`)
  if (c.fs === "btrfs") {
    if (parts[1].mountpoint !== null) fail(c.name, "btrfs root carries a mountpoint AND subvolumes")
    if (parts[1].btrfs.length !== 5) fail(c.name, `expected 5 subvolumes, got ${parts[1].btrfs.length}`)
  } else {
    if (parts[1].mountpoint !== "/") fail(c.name, "a root without subvolumes must mount at /")
    if (parts[1].btrfs.length !== 0) fail(c.name, "subvolumes on a non-btrfs root")
  }
}


// ─── MANUAL MODE ─────────────────────────────────────────────────────────────
//
// A different set of ways to be wrong, because these partitions already exist and
// archinstall's arithmetic checks do not apply to them (`parse_arg` validates
// alignment, overlap and the GPT header only for partitions with status
// `create`). What it DOES refuse, and what it silently drops, is this:
//
//   · `modify` with no filesystem — `PartitionModification.__post_init__` raises
//     'FS type must not be empty on modifications with status type modify'.
//   · `existing` or `modify` with no `dev_path` — same place: 'If partition
//     marked as existing a path must be set'.
//   · an `fs_type` outside its enum — `FilesystemType(<value>)` raises, and it is
//     raised while parsing a configuration the user has already confirmed.
//
// And three that are not errors to archinstall at all, which is what makes them
// worth a probe:
//
//   · no partition carrying the `esp` flag ⇒ `get_efi_partition()` returns None ⇒
//     the install stops at 'Could not detect EFI system partition' *after*
//     pacstrap, or, with `boot` alone, writes the loader somewhere else.
//   · a swap row that keeps a mount point ⇒ mounted as a DIRECTORY, which is the
//     bug this move exists to delete (#423).
//   · `wipe: true` on a manual device ⇒ a fresh GPT over a disk whose whole
//     promise was that everything unnamed is left alone.

interface ManualCase {
  name: string
  mounts: Array<Partial<ManualPartitionMount> & {
    /** Empty for a row that is a GAP: no device node exists for it yet (#447). */
    path: string
    mountpoint: string
    format: boolean
  }>
  /** Which path must end up flagged as the ESP; null when the case has no UEFI half. */
  esp: string | null
  devices: number
}

const row = (m: ManualCase["mounts"][number]): ManualPartitionMount => ({
  name: m.path.replace("/dev/", ""),
  path: m.path,
  device: m.device ?? "/dev/sda",
  start: m.start ?? 2048 * 512,
  size: m.size ?? 100 * 1024 * MIB,
  logicalSectorSize: m.logicalSectorSize ?? 512,
  fsType: m.fsType ?? null,
  label: null,
  mountpoint: m.mountpoint,
  filesystem: m.filesystem ?? "btrfs",
  format: m.format,
  ...(m.create ? { create: true } : {}),
})

// The layout a btrfs root is supposed to get, written out HERE rather than
// imported from `disk-config.ts`: a table that recomputes the answer from the
// thing it is checking agrees with itself no matter what it says.
const SUBVOL_MOUNTS: Array<[string, string]> = [
  ["@", "/"],
  ["@home", "/home"],
  ["@log", "/var/log"],
  ["@pkg", "/var/cache/pacman/pkg"],
  ["@snapshots", "/.snapshots"],
]

const MANUAL_CASES: ManualCase[] = [
  {
    name: "reuse a Linux layout: ESP kept, root reformatted",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", start: 513 * MIB, size: 200 * 1024 * MIB },
    ],
  },
  {
    name: "a btrfs root brought by hand gets the layout, and /home is inside it",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", start: 1 * MIB, size: 1024 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", start: 1025 * MIB, size: 200 * 1024 * MIB },
    ],
  },
  {
    // The collision. A separate /home and `@home` both want the same path, and
    // archinstall would mount one over the other without a word.
    name: "a separate /home takes the path, so @home is not emitted",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", start: 1 * MIB, size: 1024 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", start: 1025 * MIB, size: 100 * 1024 * MIB },
      { path: "/dev/sda3", mountpoint: "/home", format: true, filesystem: "ext4", start: 102401 * MIB, size: 100 * 1024 * MIB },
    ],
  },
  {
    // #447: the gap is claimed whole and archinstall is told to CREATE it. The
    // ESP is a real kept partition, so this is the shape of "I shrank Windows".
    name: "free space claimed as the root, beside a kept ESP",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", start: 1 * MIB, size: 1024 * MIB },
      { path: "", create: true, mountpoint: "/", format: true, filesystem: "btrfs", start: 300 * 1024 * MIB, size: 200 * 1024 * MIB },
    ],
  },
  {
    // The case that made `espMount` comparison move from path to IDENTITY. Two
    // created rows both have `path: ""`, so `m.path === esp.path` was true for
    // BOTH and the layout went out with two partitions flagged `esp`.
    name: "two created rows, and only the EFI one is flagged",
    esp: "",
    devices: 1,
    mounts: [
      { path: "", create: true, mountpoint: "/boot/efi", format: true, filesystem: "vfat", start: 1 * MIB, size: 1024 * MIB },
      { path: "", create: true, mountpoint: "/", format: true, filesystem: "ext4", start: 1025 * MIB, size: 200 * 1024 * MIB },
    ],
  },
  {
    name: "an ext4 root gets no subvolumes and mounts at / itself",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", start: 1 * MIB, size: 1024 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "ext4", start: 1025 * MIB, size: 200 * 1024 * MIB },
    ],
  },
  {
    name: "the Debian spelling: /boot/efi is the ESP, /boot is ext4",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot/efi", format: false, fsType: "vfat", start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/sda2", mountpoint: "/boot", format: true, filesystem: "ext4", start: 513 * MIB, size: 1024 * MIB },
      { path: "/dev/sda3", mountpoint: "/", format: true, filesystem: "ext4", start: 1537 * MIB, size: 100 * 1024 * MIB },
    ],
  },
  {
    name: "swap, home kept, root formatted",
    esp: "/dev/nvme0n1p1",
    devices: 1,
    mounts: [
      { path: "/dev/nvme0n1p1", device: "/dev/nvme0n1", mountpoint: "/efi", format: true, filesystem: "vfat", start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/nvme0n1p2", device: "/dev/nvme0n1", mountpoint: "/", format: true, filesystem: "ext4", start: 513 * MIB, size: 60 * 1024 * MIB },
      { path: "/dev/nvme0n1p3", device: "/dev/nvme0n1", mountpoint: "swap", format: true, start: 61 * 1024 * MIB, size: 8 * 1024 * MIB },
      { path: "/dev/nvme0n1p4", device: "/dev/nvme0n1", mountpoint: "/home", format: false, fsType: "ext4", start: 69 * 1024 * MIB, size: 400 * 1024 * MIB },
    ],
  },
  {
    name: "a swap partition that is already swap, kept",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: true, filesystem: "vfat", start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", start: 513 * MIB, size: 50 * 1024 * MIB },
      { path: "/dev/sda3", mountpoint: "swap", format: false, fsType: "swap", start: 51 * 1024 * MIB, size: 4 * 1024 * MIB },
    ],
  },
  {
    name: "two disks: system on the NVMe, /home on the spinning one",
    esp: "/dev/nvme0n1p1",
    devices: 2,
    mounts: [
      { path: "/dev/nvme0n1p1", device: "/dev/nvme0n1", mountpoint: "/boot", format: true, filesystem: "vfat", start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/nvme0n1p2", device: "/dev/nvme0n1", mountpoint: "/", format: true, filesystem: "btrfs", start: 513 * MIB, size: 400 * 1024 * MIB },
      { path: "/dev/sdb1", device: "/dev/sdb", mountpoint: "/home", format: false, fsType: "xfs", start: 1 * MIB, size: 2000 * 1024 * MIB },
    ],
  },
  {
    name: "4Kn drive, and a filesystem we do not model",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: true, filesystem: "vfat", logicalSectorSize: 4096, start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", logicalSectorSize: 4096, start: 513 * MIB, size: 300 * 1024 * MIB },
      { path: "/dev/sda3", mountpoint: "/home", format: false, fsType: "reiserfs", logicalSectorSize: 4096, start: 301 * 1024 * MIB, size: 100 * 1024 * MIB },
    ],
  },
  {
    // ⚠️ THIS CASE IS THE POINT OF THE GEOMETRY CHECK, and without it that check
    // was decoration: every other layout here starts on a MiB boundary, so a
    // translation that rounded the numbers "to be safe" produced identical output
    // and the probe said ALL INVARIANTS HOLD. Measured on a real drive — an
    // MBR-era table whose first partition starts at sector 34 and whose length is
    // not a whole number of MiB. A modify is a delete and a create at exactly
    // these numbers, so rounding one down moves the partition.
    name: "a legacy table that is not MiB-aligned",
    esp: "/dev/sdc2",
    devices: 1,
    mounts: [
      { path: "/dev/sdc1", device: "/dev/sdc", mountpoint: "/home", format: false, fsType: "ntfs", start: 34 * 512, size: 16759808 },
      { path: "/dev/sdc2", device: "/dev/sdc", mountpoint: "/boot", format: false, fsType: "vfat", start: 32768 * 512, size: 268434944 },
      { path: "/dev/sdc3", device: "/dev/sdc", mountpoint: "/", format: true, filesystem: "ext4", start: 557056 * 512, size: 107374182399 },
    ],
  },
  {
    name: "an unassigned partition is not part of the install",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: true, filesystem: "vfat", start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", start: 513 * MIB, size: 50 * 1024 * MIB },
      { path: "/dev/sda3", mountpoint: "", format: true, filesystem: "btrfs", start: 51 * 1024 * MIB, size: 50 * 1024 * MIB },
    ],
  },
]

// archinstall's own vocabulary, transcribed. A value outside it raises while the
// configuration is being parsed, which is after every question has been answered.
const ARCH_FS = new Set([
  "btrfs", "ext2", "ext3", "ext4", "f2fs", "fat12", "fat16", "fat32",
  "ntfs", "xfs", "linux-swap", "crypto_LUKS",
])

for (const c of MANUAL_CASES) {
  const answer: ManualDiskAnswer = { mode: "manual", mounts: c.mounts.map(row) }
  const assigned = answer.mounts.filter(m => m.mountpoint !== "")
  const config = manualDiskConfig(answer)

  print(`
${c.name}`)
  for (const mod of config.device_modifications) {
    print(`   ${mod.device}  wipe=${mod.wipe}`)
    for (const p of mod.partitions) {
      const where = p.mountpoint ?? "(no mountpoint)"
      print(`      ${String(p.dev_path).padEnd(16)} ${p.status.padEnd(8)} ${where.padEnd(14)}`
        + ` fs=${p.fs_type}  start=${p.start.value} ${p.start.unit}  size=${p.size.value} ${p.size.unit}`
        + `  flags=[${p.flags}]`)
    }
  }

  if (config.config_type !== "manual_partitioning") fail(c.name, `config_type is ${config.config_type}`)
  if (config.device_modifications.length !== c.devices) {
    fail(c.name, `expected ${c.devices} device(s), got ${config.device_modifications.length}`)
  }

  const all = config.device_modifications.flatMap(m => m.partitions)
  if (all.length !== assigned.length) {
    fail(c.name, `${assigned.length} assigned rows produced ${all.length} partitions`)
  }
  for (const mod of config.device_modifications) {
    if (mod.wipe) fail(c.name, `${mod.device} would be wiped`)
    for (const p of mod.partitions) {
      // A CREATED partition has no `dev_path` to match on — it does not exist
      // yet — so it is matched on the geometry it was asked for, which is also
      // the thing most worth checking about it.
      const source = p.dev_path === null
        ? assigned.find(m => m.create && m.start === p.start.value && m.size === p.size.value)
        : assigned.find(m => m.path === p.dev_path)
      const who = p.dev_path ?? `create@${p.start.value}`
      if (!source) { fail(c.name, `${who} is not one of the assigned rows`); continue }
      if (source.device !== mod.device) fail(c.name, `${who} filed under ${mod.device}`)

      // The three archinstall refuses outright. `dev_path` is REQUIRED to be null
      // on a create and REQUIRED to be set otherwise: entire-disk mode has always
      // sent null for the partitions it lays out, and a create carrying a path
      // would be naming a node that does not exist.
      if (!source.create && !p.dev_path) fail(c.name, "an existing partition with no dev_path")
      if (source.create && p.dev_path !== null) fail(c.name, `${who}: a create carries dev_path ${p.dev_path}`)
      if (p.status === "modify" && !p.fs_type) fail(c.name, `${p.dev_path}: modify with no fs_type`)
      if (p.fs_type !== null && !ARCH_FS.has(p.fs_type)) {
        fail(c.name, `${p.dev_path}: fs_type '${p.fs_type}' is not one archinstall knows`)
      }

      // The tick, and only the tick, decides delete-and-recreate vs leave alone.
      const wanted = source.create ? "create" : source.format ? "modify" : "existing"
      if (p.status !== wanted) fail(c.name, `${who}: status ${p.status}, expected ${wanted}`)

      // Geometry is transcribed, not recomputed: a modify is a delete followed by
      // a create at exactly these numbers.
      if (p.start.unit !== "B" || p.size.unit !== "B") fail(c.name, `${p.dev_path}: geometry is not in bytes`)
      if (p.start.value !== source.start) fail(c.name, `${p.dev_path}: start ${p.start.value} ≠ ${source.start}`)
      if (p.size.value !== source.size) fail(c.name, `${p.dev_path}: size ${p.size.value} ≠ ${source.size}`)
      if (p.start.sector_size.value !== source.logicalSectorSize) {
        fail(c.name, `${p.dev_path}: sector size ${p.start.sector_size.value} ≠ ${source.logicalSectorSize}`)
      }

      // Swap is not a place.
      if (source.mountpoint === "swap") {
        if (p.mountpoint !== null) fail(c.name, `${p.dev_path}: swap carries mountpoint ${p.mountpoint}`)
        if (source.format && p.fs_type !== "linux-swap") fail(c.name, `${p.dev_path}: swap formatted as ${p.fs_type}`)
      } else if (isSubvolRoot(source)) {
        if (p.mountpoint !== null) {
          fail(c.name, `${p.dev_path}: a subvolumed root carries mountpoint ${p.mountpoint}`)
        }
      } else if (p.mountpoint !== source.mountpoint) {
        fail(c.name, `${p.dev_path}: mountpoint ${p.mountpoint} ≠ ${source.mountpoint}`)
      }
    }
  }

  // Exactly one ESP, and the one the page validated and the bootloader will patch.
  //
  // ⚠️ Identified by its SOURCE ROW, not by `dev_path`. A created partition has
  // none, so two claimed gaps both answered `""` to a path comparison and the
  // layout went out with two ESPs — which is the defect this rewrite exists to
  // be able to see (#447).
  const sourceOf = (p: Partition) => p.dev_path === null
    ? assigned.find(m => m.create && m.start === p.start.value && m.size === p.size.value)
    : assigned.find(m => m.path === p.dev_path)
  const espSource = espMount(assigned)
  const flagged = all.filter(p => p.flags.includes("esp"))
  if (flagged.length !== 1) fail(c.name, `${flagged.length} partitions flagged as the ESP`)
  else {
    const got = sourceOf(flagged[0])
    if (!got) fail(c.name, "the flagged ESP matches no assigned row")
    else if (got.path !== c.esp) fail(c.name, `ESP is '${got.path}', expected '${c.esp}'`)
    if (got && espSource !== got) fail(c.name, "espMount picks a different partition than the layout flags")
    if (!flagged[0].flags.includes("boot")) fail(c.name, "the ESP is not flagged bootable")
  }
  const claimed = new Set(assigned.map(m => m.mountpoint))
  for (const p of all) {
    if (sourceOf(p) !== espSource && p.flags.length > 0) fail(c.name, `${p.dev_path ?? "create"} carries flags [${p.flags}]`)

    const source = assigned.find(m => m.path === p.dev_path)
    if (!source) continue

    if (!isSubvolRoot(source)) {
      if (p.btrfs.length > 0) fail(c.name, `${p.dev_path}: subvolumes on something that is not a formatted btrfs root`)
      if (p.mount_options.length > 0) fail(c.name, `${p.dev_path}: mount_options [${p.mount_options}] on a plain partition`)
      continue
    }

    // The layout, minus every mount point a row of the table already claims.
    // `@` survives that filter by name: `/` is this row.
    const want = SUBVOL_MOUNTS
      .filter(([name, mp]) => name === "@" || !claimed.has(mp))
      .map(([name]) => name)
    const got = p.btrfs.map(sv => sv.name)
    if (got.join(",") !== want.join(",")) {
      fail(c.name, `${p.dev_path}: subvolumes [${got}], expected [${want}]`)
    }
    for (const sv of p.btrfs) {
      const mp = SUBVOL_MOUNTS.find(([name]) => name === sv.name)?.[1]
      if (sv.mountpoint !== mp) fail(c.name, `${p.dev_path}: ${sv.name} mounts at ${sv.mountpoint}, expected ${mp}`)
      if (sv.name !== "@" && claimed.has(sv.mountpoint)) {
        fail(c.name, `${p.dev_path}: ${sv.name} would be mounted over by a partition at ${sv.mountpoint}`)
      }
    }
    if (!p.mount_options.includes("compress=zstd")) {
      fail(c.name, `${p.dev_path}: a btrfs root without compress=zstd`)
    }
  }
}

/** A row that produces subvolumes: the root, formatted, as btrfs. */
function isSubvolRoot(m: ManualPartitionMount): boolean {
  return m.mountpoint === "/" && m.format && m.filesystem === "btrfs"
}


// ─── THE GAPS BETWEEN PARTITIONS (#447) ──────────────────────────────────────
//
// `freeSpaceGaps` is what decides whether somebody who made room for us can see
// it. It is pure arithmetic over numbers `lsblk` already reports, so it is
// checked here rather than by looking at a table on a machine that happens to
// have a gap — this developer's does not, and a feature nobody can reproduce is
// a feature nobody maintains.
//
// The floor is the interesting part: it is what lets the function get away with
// not knowing a GPT's exact usable range. Case 2 is the one that matters most in
// practice — every real disk has 1 MiB slivers between aligned partitions, and a
// table that grew a "Free space — 1.0 MiB" row for each of them would be noise
// dressed as an offer.
const GIB = 1024 * MIB
const DISK = { path: "/dev/sda", size: 500 * GIB, logicalSectorSize: 512 }

const gapCases: Array<{ name: string; parts: Array<[number, number]>; want: Array<[number, number]> }> = [
  {
    name: "a disk with room at the end — somebody shrank Windows",
    parts: [[1 * MIB, 100 * GIB]],
    want: [[100 * GIB + MIB, 500 * GIB - MIB - (100 * GIB + MIB)]],
  },
  {
    name: "1 MiB alignment slivers are not offers",
    parts: [[1 * MIB, 100 * GIB], [100 * GIB + 2 * MIB, 100 * GIB]],
    want: [[200 * GIB + 2 * MIB, 500 * GIB - MIB - (200 * GIB + 2 * MIB)]],
  },
  {
    name: "a gap in the MIDDLE, between two partitions",
    parts: [[1 * MIB, 50 * GIB], [200 * GIB, 300 * GIB - MIB]],
    want: [[50 * GIB + MIB, 200 * GIB - (50 * GIB + MIB)]],
  },
  {
    name: "an empty disk is one gap, edges reserved",
    parts: [],
    want: [[MIB, 500 * GIB - 2 * MIB]],
  },
  {
    name: "a full disk offers nothing",
    parts: [[1 * MIB, 500 * GIB - 2 * MIB]],
    want: [],
  },
  {
    // A corrupt table must not make the cursor walk backwards: an invented gap
    // ON TOP of a partition is an offer to install over somebody's data.
    name: "overlapping partitions invent no gap",
    parts: [[1 * MIB, 300 * GIB], [100 * GIB, 300 * GIB]],
    want: [[400 * GIB, 500 * GIB - MIB - 400 * GIB]],
  },
  {
    name: "partitions of another disk are ignored",
    parts: [],
    other: true,
    want: [[MIB, 500 * GIB - 2 * MIB]],
  } as any,
]

print("\n─── free space (#447) ───")
for (const g of gapCases) {
  const parts = g.parts.map(([start, size]) => ({ device: DISK.path, start, size }))
  if ((g as any).other) parts.push({ device: "/dev/sdb", start: 1 * MIB, size: 400 * GIB })
  const got = freeSpaceGaps(DISK, parts).map(x => [x.start, x.size] as [number, number])
  const same = got.length === g.want.length
    && got.every((x, i) => x[0] === g.want[i][0] && x[1] === g.want[i][1])
  if (!same) {
    fail(g.name, `gaps ${JSON.stringify(got)} ≠ ${JSON.stringify(g.want)}`)
  } else {
    print(`   ${String(got.length).padStart(2)} gap(s)  ${g.name}`)
  }
}

// ─── WHERE THE BOOTLOADER PATCHING WRITES ────────────────────────────────────
//
// `lib/bootloader.ts` edits the entry titles, the kernel cmdline and the loader
// timeout AFTER archinstall exits, and until 2026-09-04 every one of its paths
// was the literal `/mnt/boot`. Manual mode offers three places for the ESP, so on
// two of them those edits landed in a plain directory on the root filesystem
// while the bootloader went to the ESP — no error, no missing file (installer
// study H-03, tech-debt #102).
//
// ⚠️ It is checked HERE because the VM cannot cover it: a run with the ESP at
// /boot exercises the fix only where the old and new answers coincide, and the
// layouts where they differ are the ones #430 is about — they install and then do
// not boot, for an unrelated reason, so an end-to-end pass over them proves
// nothing about this.

const LOADER_CASES: Array<{ name: string, answer: any, want: string }> = [
  {
    name: "entire disk — the ESP is ours and we put it at /boot",
    want: "/mnt/boot",
    answer: {
      mode: "entire_disk", filesystem: "btrfs",
      disk: { name: "d", path: "/dev/vda", size: 25 * 1024 * MIB, model: null, rm: false, logicalSectorSize: 512 },
    },
  },
  {
    name: "manual, ESP at /boot — old and new answers coincide",
    want: "/mnt/boot",
    answer: { mode: "manual", mounts: [row({ path: "/dev/vda1", mountpoint: "/boot", format: false, fsType: "vfat" }),
                                       row({ path: "/dev/vda2", mountpoint: "/", format: true })] },
  },
  {
    name: "manual, ESP at /boot/efi — the Debian spelling, and the one that bit",
    want: "/mnt/boot/efi",
    answer: { mode: "manual", mounts: [row({ path: "/dev/vda1", mountpoint: "/boot/efi", format: false, fsType: "vfat" }),
                                       row({ path: "/dev/vda2", mountpoint: "/boot", format: true, filesystem: "ext4" }),
                                       row({ path: "/dev/vda3", mountpoint: "/", format: true })] },
  },
  {
    name: "manual, ESP at /efi",
    want: "/mnt/efi",
    answer: { mode: "manual", mounts: [row({ path: "/dev/vda1", mountpoint: "/efi", format: false, fsType: "vfat" }),
                                       row({ path: "/dev/vda2", mountpoint: "/", format: true })] },
  },
  {
    name: "manual with no EFI mount at all — falls back, never to undefined",
    want: "/mnt/boot",
    answer: { mode: "manual", mounts: [row({ path: "/dev/vda2", mountpoint: "/", format: true })] },
  },
]

print("")
for (const c of LOADER_CASES) {
  const got = loaderRoot({ disk: c.answer } as any)
  print(`   ${got.padEnd(16)} ${c.name}`)
  if (got !== c.want) fail(c.name, `loaderRoot returned ${got}, expected ${c.want}`)
}


// ─── THE SWAP LINE THE INSTALLED SYSTEM GETS ─────────────────────────────────
//
// `genfstab -pU -f /mnt` skips swap PARTITIONS — its prefix filter is written for
// swap files, and `/dev/vda3` never starts with /mnt — so the entry is ours to
// write (lib/swap.ts). It is checked here because the field ORDER is the whole
// risk: fstab is positional, and `none swap` the wrong way round is a line the
// machine reads at every boot and cannot make sense of. The padding is genfstab's
// so that the file stays one file rather than two styles.

const FSTAB_CASES = [
  { dev: "/dev/vda3", uuid: "b1c5e0a6-9f3d-4c2e-9a77-2f0e1d3b4c5d" },
  { dev: "/dev/nvme0n1p3", uuid: "0e5f2a11-77bd-4b0e-9c8a-1122334455ff" },
]

print("")
for (const c of FSTAB_CASES) {
  const entry = swapFstabEntry(c.dev, c.uuid)
  const lines = entry.split("\n")
  print(`   ${JSON.stringify(entry)}`)

  if (lines[0] !== `# ${c.dev}`) fail(c.dev, `comment line is ${JSON.stringify(lines[0])}`)
  const fields = lines[1].trim().split(/\s+/)
  const want = [`UUID=${c.uuid}`, "none", "swap", "defaults", "0", "0"]
  if (fields.length !== want.length || fields.some((f, i) => f !== want[i])) {
    fail(c.dev, `fields are ${JSON.stringify(fields)}, expected ${JSON.stringify(want)}`)
  }
  // A blank line after the entry, like every block genfstab writes — so the next
  // one appended does not land on the same line as this one.
  if (!entry.endsWith("\n\n")) fail(c.dev, "entry does not end with a blank line")
}


// ─── WHAT THE PAGE MUST REFUSE ───────────────────────────────────────────────
//
// Everything above checks the JSON we emit. This checks the layouts we must
// never emit at all — `manualProblems()`, which is both the list printed under
// the table and the whole of `ready()` for manual mode, so a rule missing here is
// a Continue button that lights up on a layout that cannot work.
//
// ⚠️ It is the half that had no instrument. Each of these rules was added after
// an install had already finished and produced a machine that does not boot
// (#414/#421, #423) or does not install (#437) — found by installing, one at a
// time, which is the most expensive way there is to discover a missing `if`.
//
// ⚠️ A refusal probe needs BOTH columns or it is worthless: a `manualProblems`
// that returned every message for every layout would pass a table of expected
// failures. So VALID layouts are cases here too, and they assert an EMPTY list.

interface RefusalCase {
  name: string
  uefi: boolean
  mounts: ManualCase["mounts"]
  /** i18n keys, as a set — order is the page's business, not the rule's. */
  want: string[]
}

const REFUSAL_CASES: RefusalCase[] = [
  {
    name: "a layout that is fine — the control that stops this table passing vacuously",
    uefi: true, want: [],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    name: "the root is kept — pacstrap onto another distribution's /usr (#437)",
    uefi: true, want: ["diskErrRootNotFormatted"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: false, fsType: "ext4" },
    ],
  },
  {
    name: "the root is kept and has no filesystem at all — one refusal covers both",
    uefi: true, want: ["diskErrRootNotFormatted"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: false, fsType: null },
    ],
  },
  {
    name: "no root at all",
    uefi: true, want: ["diskErrNoRoot", "diskErrNoBoot"],
    mounts: [
      { path: "/dev/sda2", mountpoint: "/home", format: true, filesystem: "ext4" },
    ],
  },
  {
    name: "no EFI partition, on a UEFI machine",
    uefi: true, want: ["diskErrNoBoot"],
    mounts: [
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    name: "the same rows on a BIOS machine — the ESP rule does not apply",
    uefi: false, want: [],
    mounts: [
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    name: "the ESP is kept and is not FAT (#414)",
    uefi: true, want: ["diskErrEfiNotFat"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "ext4" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    name: "the ESP is about to be formatted as btrfs (#421)",
    uefi: true, want: ["diskErrEfiNotFat"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: true, filesystem: "btrfs" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    name: "a swap row kept that is not swap yet (#423)",
    uefi: true, want: ["diskErrSwapNotSwap"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
      { path: "/dev/sda3", mountpoint: "swap", format: false, fsType: "ext4" },
    ],
  },
  {
    name: "two partitions claiming /home — one would mount over the other",
    uefi: true, want: ["diskErrDuplicateMount"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
      { path: "/dev/sda3", mountpoint: "/home", format: true, filesystem: "ext4" },
      { path: "/dev/sda4", mountpoint: "/home", format: true, filesystem: "ext4" },
    ],
  },
  {
    name: "two swap partitions — a normal layout, and swapon takes as many as it is given",
    uefi: true, want: [],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
      { path: "/dev/sda3", mountpoint: "swap", format: false, fsType: "swap" },
      { path: "/dev/sda4", mountpoint: "swap", format: true },
    ],
  },
]

print("")
for (const c of REFUSAL_CASES) {
  const got = manualProblems(c.mounts.map(row), c.uefi)
  // `diskErrDuplicateMount` ends in the offending mount points, so the expected
  // message is a prefix rather than the whole string.
  const want = c.want.map(k => t(k as any))
  const matched = want.filter(w => got.some(g => g.startsWith(w)))
  const unexpected = got.filter(g => !want.some(w => g.startsWith(w)))

  print(`   ${got.length === 0 ? "installable" : `${got.length} refusal(s)`.padEnd(11)}  ${c.name}`)

  if (matched.length !== want.length) {
    fail(c.name, `expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`)
  }
  if (unexpected.length > 0) {
    fail(c.name, `refused for reasons this case did not expect: ${JSON.stringify(unexpected)}`)
  }
}

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)

// ⚠️ It has to EXIT non-zero, and until 2026-09-05 it did not — it printed the
// count and returned 0. That was survivable while a person ran it and read the
// output; wired into CI as it stood, the job would have gone green over
// "12 FAILURE(S)" and been a gate that can only pass. The check that catches a
// vacuous probe is the one that runs the probe against a deliberate defect and
// insists on a non-zero status, which is what the workflow step does.
imports.system.exit(failures === 0 ? 0 : 1)
