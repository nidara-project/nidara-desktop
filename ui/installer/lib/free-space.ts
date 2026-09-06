// free-space.ts — the gaps between partitions, which `lsblk` does not report.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The manual table is built from `lsblk` filtered to `type === "part"`.
// Unpartitioned space is not a partition, so somebody who deliberately made room
// for us — shrank a Windows volume, deleted an old partition, bought a disk and
// left it empty — opened manual mode and saw nothing to install into (#447). The
// space was on the disk and invisible in the UI, and the one escape hatch, the
// GParted button, is inert on the shipped medium because `gparted` is in none of
// the lines of nidara-iso's `packages.x86_64`.
//
// Prior art says a row is the answer. Calamares puts unallocated space in the
// table as its own row (`PartitionModel.cpp`, `tr("Free Space", "@title")`) with
// its size and every other cell empty, and enables `Create` only on such a row;
// Ubiquity and YaST do the same with a flat list and a `free space` /
// `Unpartitioned` row. Anaconda is the outlier — a global figure plus a `+`
// button — and it can afford that because its whole page is built around adding
// mount points rather than around the disk as it is.
//
// ─── WHY IT IS COMPUTED AND NOT ASKED ────────────────────────────────────────
// `sfdisk --json` and `parted print free` both report gaps directly, and both
// open the block device, which needs root. The installer's window runs as the
// live user — only the final step goes through `sudo -n` — so asking either of
// them would put a privilege prompt behind a page that is still being filled in,
// and would behave differently in preview than on the medium. `lsblk` already
// gives every number this needs, without privileges, from the same call the
// table is built from.
//
// ⚠️ What it therefore does NOT know: a GPT's real first and last usable LBA.
// That is deliberate rather than overlooked — see `MIN_GAP` below, which makes
// the question stop mattering instead of guessing an answer to it.

/** A gap on a disk that is big enough to be worth offering. */
export interface FreeGap {
  /** The disk it is on — `/dev/sda`, matching `ManualPartitionMount.device`. */
  device: string
  /** Byte offset of the aligned start. */
  start: number
  /** Aligned length in bytes. */
  size: number
  /** Carried through so the plan can build archinstall's `Size` objects. */
  logicalSectorSize: number
}

/** What a partition has to look like for this file. */
export interface PlacedPartition {
  device: string
  start: number
  size: number
}

const MIB = 1024 * 1024

/**
 * Partition tables are aligned to 1 MiB by every tool that has shipped this
 * decade, and so is everything we ask archinstall to create. Rounding the start
 * UP and the end DOWN to that boundary means a gap we offer can always be taken
 * whole, with no "your partition was moved 8 sectors" surprise afterwards.
 */
const ALIGN = MIB

/**
 * The last MiB of a GPT disk holds the backup header and partition array. We
 * never offer it. A megabyte at the head is skipped for the same reason (the
 * primary header plus the conventional alignment gap), and both are one constant
 * because both are "the edge of the disk is not yours".
 */
const EDGE_RESERVE = MIB

/**
 * A gap smaller than this is not shown.
 *
 * This is the number that lets the file get away with not knowing a GPT's exact
 * usable range. The uncertainty is at most a few dozen sectors at each end; the
 * floor is three orders of magnitude above it, so no plausible reading of the
 * edges turns a real gap into a hidden one or an alignment remainder into an
 * offer.
 *
 * 64 MiB is also below anything a Linux layout actually uses — our own ESP is
 * 512 MiB — so the floor never hides a gap somebody meant to use, while it does
 * hide the 1–2 MiB slivers that sit between aligned partitions on most disks. A
 * table listing those would be noise pretending to be an offer.
 */
const MIN_GAP = 64 * MIB

const alignUp = (n: number) => Math.ceil(n / ALIGN) * ALIGN
const alignDown = (n: number) => Math.floor(n / ALIGN) * ALIGN

/**
 * The usable gaps on one disk, in disk order.
 *
 * `partitions` may be in any order and may include partitions of other disks —
 * they are filtered by `device`, because the caller holds one flat list for the
 * whole machine.
 */
export function freeSpaceGaps(
  disk: { path: string; size: number; logicalSectorSize: number },
  partitions: readonly PlacedPartition[],
): FreeGap[] {
  const mine = partitions
    .filter(p => p.device === disk.path && p.size > 0)
    .slice()
    .sort((a, b) => a.start - b.start)

  const gaps: FreeGap[] = []
  const lastUsable = disk.size - EDGE_RESERVE
  let cursor = EDGE_RESERVE

  const offer = (from: number, to: number) => {
    const start = alignUp(from)
    const end = alignDown(to)
    if (end - start >= MIN_GAP) {
      gaps.push({ device: disk.path, start, size: end - start, logicalSectorSize: disk.logicalSectorSize })
    }
  }

  for (const p of mine) {
    // ⚠️ `max`, not the raw start: partitions can overlap in a corrupt table, and
    // a cursor that walked backwards would invent a gap on top of a partition —
    // which on this page is an offer to install over somebody's data.
    if (p.start > cursor) offer(cursor, Math.min(p.start, lastUsable))
    cursor = Math.max(cursor, p.start + p.size)
  }
  if (cursor < lastUsable) offer(cursor, lastUsable)

  return gaps
}
