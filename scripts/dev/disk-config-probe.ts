// disk-config-probe — is the layout we hand archinstall one it will accept?
//
//   ./scripts/bundle.sh --js scripts/dev/disk-config-probe.ts /tmp/disk-config-probe.js \
//     && gjs -m /tmp/disk-config-probe.js
//
// No window, no GTK, no disk: it calls `entireDiskConfig()` with disk sizes
// instead of with a disk, so it is safe on any machine and says nothing about the
// one it runs on.
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
//
// ⚠️ **It has been shown to fail.** Five deliberate defects were introduced one
// at a time and each was caught, by name: ESP starting at 0, a root one MiB too
// long, a length that is not MiB-aligned, a root carrying both a mountpoint and
// subvolumes, and `@snapshots` dropped back to upstream's four. A probe that has
// only ever printed "ok" has not been tested, it has been run.

import { entireDiskConfig } from "../../ui/installer/lib/disk-config"
import type { EntireDiskAnswer, FilesystemType } from "../../ui/installer/lib/answers"

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

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)
