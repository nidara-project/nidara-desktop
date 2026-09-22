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
// point, the format tick inverted, nothing flagged as the ESP, `/boot/efi`
// recognised as an ESP again (#430), `wipe: true`, the start rounded down to a
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

import { ENTIRE_DISK_MIN_BYTES, MIN_ROOT_MIB, entireDiskConfig, entireDiskFits, manualDiskConfig, espMount } from "../../ui/installer/lib/disk-config"
import { assemblePlan } from "../../ui/installer/lib/plan"
import { loaderRoot } from "../../ui/installer/lib/bootloader"
import { swapFstabEntry, partitionAtStart } from "../../ui/installer/lib/swap"
import { releaseCommands, targetDisks, type BlockNode } from "../../ui/installer/lib/release-target"
import { ESP_MIN_BYTES, manualProblems } from "../../ui/installer/lib/manual-problems"
import { excludeLiveMedium, liveMediumDiskFrom } from "../../ui/installer/lib/live-medium"
import { formatSize } from "../../ui/installer/lib/format-size"
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
  // The two sides of the number the disk page STATES. Without both, the page
  // could promise a size the layout then refuses, or grey out one it would take.
  { name: "exactly ENTIRE_DISK_MIN_BYTES", size: ENTIRE_DISK_MIN_BYTES, sector: 512, fs: "btrfs" },
  { name: "one byte under ENTIRE_DISK_MIN_BYTES", size: ENTIRE_DISK_MIN_BYTES - 1, sector: 512, fs: "btrfs" },
]

// ⚠️ The disk page greys a disk out with `entireDiskFits` and the run page builds
// it with `entireDiskConfig`. If the two ever disagree, a disk is either offered
// and then refused after the summary (the bug this pair was written for), or
// refused on the page and perfectly installable. So what is asserted is that they
// AGREE on every case, plus the one boundary the page's text names.
const EXPECT_FITS: Record<string, boolean> = {
  "8.6 GiB, just above the floor": true,
  "8 GiB, below the floor": false,
  "exactly ENTIRE_DISK_MIN_BYTES": true,
  "one byte under ENTIRE_DISK_MIN_BYTES": false,
}

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

  const fits = entireDiskFits(answer.disk!)
  if (c.name in EXPECT_FITS && fits !== EXPECT_FITS[c.name]) {
    fail(c.name, `entireDiskFits says ${fits}, expected ${EXPECT_FITS[c.name]}`)
  }

  let config: ReturnType<typeof entireDiskConfig>
  try {
    config = entireDiskConfig(answer)
    if (!fits) fail(c.name, "the page would grey this disk out, and the layout accepts it")
  } catch (e: any) {
    if (fits) fail(c.name, `the page offers this disk, and the layout refuses it: ${e?.message ?? e}`)
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

// ─── ENTIRE-DISK ENCRYPTION (#310) ───────────────────────────────────────────
{
  const encAnswer: EntireDiskAnswer = {
    mode: "entire_disk",
    filesystem: "btrfs",
    disk: {
      name: "probe-enc",
      path: "/dev/probe-enc",
      size: 50 * 1024 * MIB,
      model: null,
      rm: false,
      logicalSectorSize: 512,
    },
    encryption: {
      enabled: true,
      passphrase: "test-luks-passphrase",
    },
  }

  const encConfig = entireDiskConfig(encAnswer)
  const parts = encConfig.device_modifications[0].partitions
  const espPart = parts[0]
  const rootPart = parts[1]

  if (!encConfig.disk_encryption) {
    fail("encryption-enabled", "disk_encryption block is missing")
  } else {
    if (encConfig.disk_encryption.encryption_type !== "luks") {
      fail("encryption-type", `expected "luks", got ${encConfig.disk_encryption.encryption_type}`)
    }
    if (!encConfig.disk_encryption.partitions.includes(rootPart.obj_id)) {
      fail("encryption-root", "root partition obj_id is not in encrypted partitions list")
    }
    if (encConfig.disk_encryption.partitions.includes(espPart.obj_id)) {
      fail("encryption-esp", "ESP partition must NEVER be in encrypted partitions list")
    }
    if (encConfig.disk_encryption.partitions.length !== 1) {
      fail("encryption-partitions-count", `expected exactly 1 encrypted partition, got ${encConfig.disk_encryption.partitions.length}`)
    }
    if (!Array.isArray(encConfig.disk_encryption.lvm_volumes) || encConfig.disk_encryption.lvm_volumes.length !== 0) {
      fail("encryption-lvm-empty", "lvm_volumes must be empty array")
    }
  }

  const noEncAnswer: EntireDiskAnswer = {
    mode: "entire_disk",
    filesystem: "btrfs",
    disk: {
      name: "probe-no-enc",
      path: "/dev/probe-no-enc",
      size: 50 * 1024 * MIB,
      model: null,
      rm: false,
      logicalSectorSize: 512,
    },
    encryption: {
      enabled: false,
      passphrase: "",
    },
  }

  const noEncConfig = entireDiskConfig(noEncAnswer)
  if (noEncConfig.disk_encryption) {
    fail("encryption-disabled", "disk_encryption block must be omitted when disabled")
  }

  // Plan assembly check with credentials
  const dummyBase = {
    config: {
      hostname: "nidara",
      locale_config: { kb_layout: "us", sys_enc: "UTF-8", sys_lang: "en_US" },
      custom_commands: [],
      profile_config: {},
      packages: [],
    } as any,
    raw: "{}",
  }

  const planEnc = assemblePlan(
    {
      account: { fullName: "User", username: "user", hostname: "nidara", password: "userpw" },
      disk: encAnswer,
    } as any,
    dummyBase,
  )

  if (planEnc.creds.encryption_password !== "test-luks-passphrase") {
    fail("plan-encryption-creds", `expected "test-luks-passphrase", got ${planEnc.creds.encryption_password}`)
  }
  if (!planEnc.config.disk_config.disk_encryption) {
    fail("plan-encryption-config", "disk_encryption missing from plan config")
  }

  const planNoEnc = assemblePlan(
    {
      account: { fullName: "User", username: "user", hostname: "nidara", password: "userpw" },
      disk: noEncAnswer,
    } as any,
    dummyBase,
  )

  if (planNoEnc.creds.encryption_password !== undefined) {
    fail("plan-no-encryption-creds", "encryption_password must be undefined when disabled")
  }
  if (planNoEnc.config.disk_config.disk_encryption !== undefined) {
    fail("plan-no-encryption-config", "disk_encryption must be undefined when disabled")
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
      { path: "", create: true, mountpoint: "/boot", format: true, filesystem: "vfat", start: 1 * MIB, size: 1024 * MIB },
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
    // Was "the Debian spelling: /boot/efi is the ESP, /boot is ext4". It passed
    // — the layout was built exactly as asked and the machine did not boot
    // (#430), because the loader entry and the kernel ended up on different
    // partitions. The spelling is gone from the page; the half of it worth
    // keeping is the ordinary layout underneath, where `/boot` is the ESP and
    // there is no second boot partition to disagree with it.
    name: "an ESP at /boot beside a kept /home — the ordinary reuse",
    esp: "/dev/sda1",
    devices: 1,
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: true, filesystem: "vfat", start: 1 * MIB, size: 512 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "ext4", start: 513 * MIB, size: 100 * 1024 * MIB },
      { path: "/dev/sda3", mountpoint: "/home", format: false, fsType: "ext4", start: 101 * 1024 * MIB, size: 300 * 1024 * MIB },
    ],
  },
  {
    name: "swap, home kept, root formatted",
    esp: "/dev/nvme0n1p1",
    devices: 1,
    mounts: [
      { path: "/dev/nvme0n1p1", device: "/dev/nvme0n1", mountpoint: "/boot", format: true, filesystem: "vfat", start: 1 * MIB, size: 512 * MIB },
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
    name: "manual, ESP at /boot — the only spelling there is",
    want: "/mnt/boot",
    answer: { mode: "manual", mounts: [row({ path: "/dev/vda1", mountpoint: "/boot", format: false, fsType: "vfat" }),
                                       row({ path: "/dev/vda2", mountpoint: "/", format: true })] },
  },
  {
    // The two cases that used to live here asserted `/mnt/boot/efi` and
    // `/mnt/efi`, and they were right about where the loader went — which is
    // exactly why the machine did not boot (#430). Now the spellings are gone
    // from the page, and a row still carrying one must not drag the loader
    // edits off to a partition archinstall never installed onto.
    name: "manual, a leftover /boot/efi row does not move the loader",
    want: "/mnt/boot",
    answer: { mode: "manual", mounts: [row({ path: "/dev/vda1", mountpoint: "/boot/efi", format: false, fsType: "vfat" }),
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


// ─── WHICH NODE A CREATED SWAP GOT ────────────────────────────────────────────
//
// A swap row made from a gap has no path in the answer — archinstall creates the
// partition — so `writeSwapFstabEntries` finds it by where it starts. The fixture
// is `lsblk -nr -o PATH,START,TYPE /dev/vda` from the 2026-09-13 manual-mode VM,
// where vda4 was created in the gap at 16897 MiB. The disk's own line has an
// empty START (two fields, not three) and must not match anything; an offset
// that no partition starts at must return "" rather than the nearest one.

const LSBLK_VDA = "/dev/vda  disk\n/dev/vda1 2048 part\n/dev/vda2 1050624 part\n/dev/vda3 38799360 part\n/dev/vda4 34605056 part\n"
const MiB = 1024 * 1024
const START_CASES = [
  { name: "created swap in the gap", start: 16897 * MiB, want: "/dev/vda4" },
  { name: "first partition", start: 1 * MiB, want: "/dev/vda1" },
  { name: "offset nothing starts at", start: 16896 * MiB, want: "" },
  { name: "offset zero (the disk line)", start: 0, want: "" },
]

print("")
for (const c of START_CASES) {
  const got = partitionAtStart(LSBLK_VDA, c.start)
  print(`   ${JSON.stringify(got).padEnd(14)} ${c.name}`)
  if (got !== c.want) fail(c.name, `partitionAtStart returned ${JSON.stringify(got)}, expected ${JSON.stringify(c.want)}`)
}


// ─── WHAT A RETRY HAS TO RELEASE FIRST ───────────────────────────────────────
//
// A second attempt in the same live session died on `umount -R [SWAP]` before
// writing anything: the first had left its swap on, and archinstall hands every
// lsblk mountpoint to umount (lib/release-target.ts). The trees below are the
// shape of `lsblk -J -o NAME,PATH,TYPE,MOUNTPOINTS` — the "retry" one is what the
// 2026-09-13 manual-mode VM held after its first install (btrfs subvolumes are
// several mountpoints on ONE node, which is how lsblk reports them).
//
// Checked as ORDER RULES rather than one exact list, because the rules are what
// the kernel enforces: swaps before anything else, a mount before its parent,
// crypt mappings only after every mount — and nothing on a disk the layout does
// not name.

const MANUAL_LEFTOVER: BlockNode[] = [
  { name: "vda", path: "/dev/vda", type: "disk", mountpoints: [null], children: [
    { name: "vda1", path: "/dev/vda1", type: "part", mountpoints: ["/mnt/boot"] },
    { name: "vda2", path: "/dev/vda2", type: "part", mountpoints: ["/mnt/var/log", "/mnt/var/cache/pacman/pkg", "/mnt/.snapshots", "/mnt"] },
    { name: "vda3", path: "/dev/vda3", type: "part", mountpoints: ["/mnt/home"] },
    { name: "vda4", path: "/dev/vda4", type: "part", mountpoints: ["[SWAP]"] },
  ] },
  // Not a target: somebody's USB stick, mounted to copy files from, with a swap on it.
  { name: "sdb", path: "/dev/sdb", type: "disk", mountpoints: [null], children: [
    { name: "sdb1", path: "/dev/sdb1", type: "part", mountpoints: ["/run/media/live/STICK"] },
    { name: "sdb2", path: "/dev/sdb2", type: "part", mountpoints: ["[SWAP]"] },
  ] },
]
const ENCRYPTED_LEFTOVER: BlockNode[] = [
  { name: "nvme0n1", path: "/dev/nvme0n1", type: "disk", mountpoints: [null], children: [
    { name: "nvme0n1p1", path: "/dev/nvme0n1p1", type: "part", mountpoints: ["/mnt/boot"] },
    { name: "nvme0n1p2", path: "/dev/nvme0n1p2", type: "part", mountpoints: [null], children: [
      { name: "root", path: "/dev/mapper/root", type: "crypt", mountpoints: ["/mnt/home", "/mnt"] },
    ] },
  ] },
]
const FRESH: BlockNode[] = [
  { name: "vda", path: "/dev/vda", type: "disk", mountpoints: [null], children: [
    { name: "vda1", path: "/dev/vda1", type: "part", mountpoints: [null] },
  ] },
]

const RELEASE_CASES = [
  { name: "first attempt: nothing held, nothing to do", tree: FRESH, targets: ["/dev/vda"],
    swaps: [], mounts: [], crypts: [] },
  { name: "retry after a manual install (swap left on, /mnt left mounted)", tree: MANUAL_LEFTOVER, targets: ["/dev/vda"],
    swaps: ["/dev/vda4"], mounts: ["/mnt/boot", "/mnt/var/log", "/mnt/var/cache/pacman/pkg", "/mnt/.snapshots", "/mnt", "/mnt/home"], crypts: [] },
  { name: "retry after an encrypted install (mapping still open)", tree: ENCRYPTED_LEFTOVER, targets: ["/dev/nvme0n1"],
    swaps: [], mounts: ["/mnt/boot", "/mnt/home", "/mnt"], crypts: ["root"] },
  { name: "a disk the layout does not name is left alone", tree: MANUAL_LEFTOVER, targets: ["/dev/nvme0n1"],
    swaps: [], mounts: [], crypts: [] },
]

print("")
for (const c of RELEASE_CASES) {
  const cmds = releaseCommands(c.tree, c.targets)
  print(`   ${String(cmds.length).padStart(2)} command(s)  ${c.name}`)
  const kind = (k: string) => cmds.map((cmd, i) => ({ cmd, i })).filter(x => x.cmd[0] === k)
  const swapoffs = kind("swapoff"), umounts = kind("umount"), closes = kind("cryptsetup")
  const same = (got: string[], want: string[]) => got.length === want.length && want.every(w => got.includes(w))

  if (cmds.length !== swapoffs.length + umounts.length + closes.length) fail(c.name, `unexpected command in ${JSON.stringify(cmds)}`)
  if (!same(swapoffs.map(x => x.cmd[1]), c.swaps)) fail(c.name, `swapoff ${JSON.stringify(swapoffs.map(x => x.cmd[1]))}, expected ${JSON.stringify(c.swaps)}`)
  if (!same(umounts.map(x => x.cmd[1]), c.mounts)) fail(c.name, `umount ${JSON.stringify(umounts.map(x => x.cmd[1]))}, expected ${JSON.stringify(c.mounts)}`)
  if (!same(closes.map(x => x.cmd[2]), c.crypts)) fail(c.name, `cryptsetup close ${JSON.stringify(closes.map(x => x.cmd[2]))}, expected ${JSON.stringify(c.crypts)}`)

  // Swaps first: one can sit on the crypt mapping that has to close last.
  if (swapoffs.some(s => umounts.some(u => u.i < s.i) || closes.some(x => x.i < s.i))) fail(c.name, "a swapoff comes after an umount or a close")
  // A mount before its parent, or the parent's umount fails as busy.
  for (const child of umounts) for (const parent of umounts) {
    const p = parent.cmd[1], ch = child.cmd[1]
    if (p !== ch && ch.startsWith(p === "/" ? "/" : p + "/") && parent.i < child.i) fail(c.name, `umount ${p} runs before ${ch}, which is inside it`)
  }
  // A mapping closes only once nothing on it is mounted.
  if (closes.some(x => umounts.some(u => u.i > x.i))) fail(c.name, "cryptsetup close comes before an umount")
}

// Which disks those are, per mode: the chosen disk, or every disk a manual row is on.
const TARGET_CASES = [
  { name: "entire disk", answers: { disk: { mode: "entire_disk", disk: { path: "/dev/nvme0n1" } } }, want: ["/dev/nvme0n1"] },
  { name: "manual, two disks, three rows", answers: { disk: { mode: "manual", mounts: [
    { device: "/dev/sda" }, { device: "/dev/sdb" }, { device: "/dev/sda" },
  ] } }, want: ["/dev/sda", "/dev/sdb"] },
  { name: "nothing chosen", answers: { disk: null }, want: [] },
]
for (const c of TARGET_CASES) {
  const got = targetDisks(c.answers as any)
  print(`   ${JSON.stringify(got).padEnd(28)} ${c.name}`)
  if (JSON.stringify(got) !== JSON.stringify(c.want)) fail(c.name, `targetDisks returned ${JSON.stringify(got)}, expected ${JSON.stringify(c.want)}`)
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
    // The dropdown offers vfat on every row. A FAT root took the layout, took the
    // repartitioning, and died on the first symbolic link pacstrap wrote.
    name: "a root set to vfat — pacstrap cannot write a Linux system onto FAT",
    uefi: true, want: ["diskErrFsNotLinux"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "vfat" },
    ],
  },
  {
    // The quieter half: this one INSTALLS. The home it produces has no owner and
    // no permissions, which is a machine somebody has to be told to reinstall.
    name: "/home set to vfat — it installs, and the home has no owner",
    uefi: true, want: ["diskErrFsNotLinux"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
      { path: "/dev/sda3", mountpoint: "/home", format: true, filesystem: "vfat" },
    ],
  },
  {
    // A KEPT partition reports what it has, and NTFS is as unusable as FAT for a
    // Linux home — this is the dual-boot layout where somebody points /home at
    // their Windows data partition.
    name: "a kept NTFS /home — the filesystem is a fact, and it is still not one Linux can live on",
    uefi: true, want: ["diskErrFsNotLinux"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
      { path: "/dev/sda3", mountpoint: "/home", format: false, fsType: "ntfs" },
    ],
  },
  {
    name: "a kept /home with no filesystem at all — there is nothing to mount",
    uefi: true, want: ["diskErrKeptNoFs"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
      { path: "/dev/sda3", mountpoint: "/home", format: false, fsType: null },
    ],
  },
  {
    // The control for the rule above: ext2/ext3 are not in the Format dropdown,
    // but a partition that already carries one is a perfectly good /home and must
    // NOT be refused.
    name: "a kept ext3 /home — not offered for formatting, still mountable",
    uefi: true, want: [],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat" },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
      { path: "/dev/sda3", mountpoint: "/home", format: false, fsType: "ext3" },
    ],
  },
  {
    // …and the ESP itself must stay exempt from it: FAT is exactly what it has to
    // be, so the two rules must not refuse each other's valid layout.
    name: "the ESP is FAT and that is correct — the Linux-filesystem rule must not fire on it",
    uefi: true, want: [],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: true, filesystem: "vfat" },
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
    // The one #446 is about: reusing the ESP Windows made is exactly what somebody
    // does to get both systems in one menu, and it is ~100 MiB. It used to be
    // accepted, repartition the disk, and die partway through pacstrap.
    name: "a factory Windows ESP, 100 MiB — the kernel does not fit",
    uefi: true, want: ["diskErrEfiTooSmall"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", size: 100 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    name: "exactly the floor — a boundary is a rule, and it is not refused",
    uefi: true, want: [],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", size: ESP_MIN_BYTES },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    // The other side of the same boundary. Without it, `<=` and `<` are the same
    // probe result and the rule could be off by the whole partition.
    name: "one byte under the floor",
    uefi: true, want: ["diskErrEfiTooSmall"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", size: ESP_MIN_BYTES - 1 },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
    ],
  },
  {
    // The root had no floor at all in this mode: a 2 GiB `/` passed every rule
    // and ran out of space inside pacstrap, after the table was rewritten.
    name: "a 2 GiB root — the system does not fit",
    uefi: true, want: ["diskErrRootTooSmall"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", size: ESP_MIN_BYTES },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", size: 2 * 1024 * MIB },
    ],
  },
  {
    name: "a root of exactly MIN_ROOT_MIB is installable",
    uefi: true, want: [],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", size: ESP_MIN_BYTES },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", size: MIN_ROOT_MIB * MIB },
    ],
  },
  {
    name: "a root one byte under MIN_ROOT_MIB",
    uefi: true, want: ["diskErrRootTooSmall"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", size: ESP_MIN_BYTES },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs", size: MIN_ROOT_MIB * MIB - 1 },
    ],
  },
  {
    name: "512 MiB — what every installer makes, and what we make ourselves",
    uefi: true, want: [],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot", format: false, fsType: "vfat", size: 512 * MIB },
      { path: "/dev/sda2", mountpoint: "/", format: true, filesystem: "btrfs" },
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
    // #430: `/boot/efi` and `/efi` were two of the three spellings this page
    // offered, and two thirds of the answers it accepted produced a machine
    // that installed cleanly and stopped at `Error loading /vmlinuz-linux`.
    // They are not refused with a message of their own because the page cannot
    // produce them any more — what this pins is that removing them from the
    // dropdown did not leave `ESP_MOUNTS` behind still recognising them, which
    // would be the same bug with none of the evidence.
    name: "a partition at /boot/efi is not an ESP — the spelling is gone (#430)",
    uefi: true, want: ["diskErrNoBoot"],
    mounts: [
      { path: "/dev/sda1", mountpoint: "/boot/efi", format: true, filesystem: "vfat", size: 512 * MIB },
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
// ─── THE DISK WE ARE RUNNING FROM ────────────────────────────────────────────
//
// `listDisks()` used to filter `loop` and `zram` and nothing else, so the USB
// stick the session booted from was offered as a target like any other disk.
//
// ⚠️ This is the one rule in this file that NO VM PASS could have found: the
// harness boots the ISO as a CD-ROM, which lsblk calls `rom` and the type filter
// already drops. On a real machine the same image is dd'd onto a stick and comes
// back as `disk`. The instrument cannot produce the case, so the case is here.

const LIVE_CASES: { name: string; json: string; want: string }[] = [
  {
    name: "a USB stick carrying the medium — the disk it is on, not the partition",
    want: "/dev/sdb",
    json: JSON.stringify({ blockdevices: [
      { path: "/dev/sda", type: "disk", mountpoints: [null], children: [
        { path: "/dev/sda1", type: "part", mountpoints: [null] }] },
      { path: "/dev/sdb", type: "disk", mountpoints: [null], children: [
        { path: "/dev/sdb1", type: "part", mountpoints: ["/run/archiso/bootmnt"] }] },
    ] }),
  },
  {
    name: "the cow space counts too — any /run/archiso mount names the medium",
    want: "/dev/sdb",
    json: JSON.stringify({ blockdevices: [
      { path: "/dev/sdb", type: "disk", mountpoints: [null], children: [
        { path: "/dev/sdb2", type: "part", mountpoints: ["/run/archiso/cowspace"] }] },
    ] }),
  },
  {
    // util-linux < 2.37 reports `mountpoint`, newer ones `mountpoints`. Reading
    // only one of the two returns "" on a medium the code is standing on.
    name: "the older lsblk column name",
    want: "/dev/sdb",
    json: JSON.stringify({ blockdevices: [
      { path: "/dev/sdb", type: "disk", mountpoint: null, children: [
        { path: "/dev/sdb1", type: "part", mountpoint: "/run/archiso/bootmnt" }] },
    ] }),
  },
  {
    name: "a machine that is not booted from our medium — nothing is excluded",
    want: "",
    json: JSON.stringify({ blockdevices: [
      { path: "/dev/nvme0n1", type: "disk", mountpoints: [null], children: [
        { path: "/dev/nvme0n1p1", type: "part", mountpoints: ["/boot"] },
        { path: "/dev/nvme0n1p2", type: "part", mountpoints: ["/"] }] },
    ] }),
  },
  {
    // The control against a prefix match that is too eager: a target disk mounted
    // somewhere else is a target, and excluding it would leave a page with no
    // disks on it at all.
    name: "a disk mounted at /mnt is a target, not the medium",
    want: "",
    json: JSON.stringify({ blockdevices: [
      { path: "/dev/sda", type: "disk", mountpoints: [null], children: [
        { path: "/dev/sda1", type: "part", mountpoints: ["/mnt"] }] },
    ] }),
  },
  {
    name: "lsblk output that is not JSON at all — the page is left as it was",
    want: "",
    json: "not json",
  },
]

print("")
print("── the medium's own disk is not a target")
for (const c of LIVE_CASES) {
  const got = liveMediumDiskFrom(c.json)
  print(`   ${(got || "(none)").padEnd(14)} ${c.name}`)
  if (got !== c.want) fail(c.name, `expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got)}`)
}

{
  const disks = [{ path: "/dev/sda" }, { path: "/dev/sdb" }]
  const kept = excludeLiveMedium(disks, "/dev/sdb")
  if (kept.length !== 1 || kept[0].path !== "/dev/sda") {
    fail("the medium is excluded from the offered disks", JSON.stringify(kept))
  } else {
    print("   ok             the medium is excluded from the offered disks")
  }
  // …and an empty answer removes NOTHING, or a failed detection would hide every
  // disk on the machine.
  if (excludeLiveMedium(disks, "").length !== 2) {
    fail("no medium detected leaves the list alone", "disks were dropped anyway")
  } else {
    print("   ok             no medium detected leaves the list alone")
  }
}

for (const c of REFUSAL_CASES) {
  const got = manualProblems(c.mounts.map(row), c.uefi)
  // `diskErrDuplicateMount` ends in the offending mount points, so the expected
  // message is a prefix rather than the whole string.
  const want = c.want.map(k => t(k as any))
  const matched = want.filter(w => got.some(g => g.message.startsWith(w)))
  const unexpected = got.filter(g => !want.some(w => g.message.startsWith(w)))

  print(`   ${got.length === 0 ? "installable" : `${got.length} refusal(s)`.padEnd(11)}  ${c.name}`)

  if (matched.length !== want.length) {
    fail(c.name, `expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got.map(g => g.message))}`)
  }
  if (unexpected.length > 0) {
    fail(c.name, `refused for reasons this case did not expect: ${JSON.stringify(unexpected.map(g => g.message))}`)
  }
}

// ⚠️ The refusal SAYS the minimum — "at least 300 MiB" — so that sentence is a
// second copy of `ESP_MIN_BYTES`, in twelve languages. Raise the constant and the
// English goes on confidently stating the old number, which is worse than saying
// nothing: the person resizes to the size the message asked for and is refused
// again. What gets checked is the locale the probe RUNS in — English in CI, and
// on a maintainer's machine whichever theirs is, which is a second pair of eyes
// for free. All twelve translations spell the number the same way (`300 MiB`),
// so any of them catches the drift; a translation that localised it would fail
// here, and that is the right place to find out.
{
  const stated = formatSize(ESP_MIN_BYTES)
  if (!t("diskErrEfiTooSmall").includes(stated)) {
    fail("the refusal states the minimum it enforces",
      `ESP_MIN_BYTES is ${stated} and the English message does not say so: "${t("diskErrEfiTooSmall")}"`)
  } else {
    print(`   ok           the refusal states its own minimum (${stated})`)
  }
}

// Same drift, for the two numbers added with the disk page's size check: the
// manual refusal says "8 GiB" in words, and the disk row says the minimum through
// `%s`, which cannot drift — but a translation that dropped the `%s` would print
// "needs at least" and nothing after it.
{
  const stated = formatSize(MIN_ROOT_MIB * MIB)
  if (!t("diskErrRootTooSmall").includes(stated)) {
    fail("the root refusal states the minimum it enforces",
      `MIN_ROOT_MIB is ${stated} and the message does not say so: "${t("diskErrRootTooSmall")}"`)
  } else {
    print(`   ok           the root refusal states its own minimum (${stated})`)
  }
  if (!t("diskTooSmall").includes("%s")) {
    fail("the disk row states the minimum", `"diskTooSmall" has no %s: "${t("diskTooSmall")}"`)
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
