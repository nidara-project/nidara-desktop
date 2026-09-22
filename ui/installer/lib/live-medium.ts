// The disk this live session is running FROM, which must never be a target.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `listDisks()` filters `loop` and `zram` and nothing else, so the USB stick the
// person booted from is offered like any other disk: same card, same size, the
// word "removable" and nothing to say what it is. Erasing it during the install
// that is reading from it does not fail politely — archinstall repartitions the
// device under a mounted squashfs and the session it is running in comes apart.
//
// ⚠️ **No VM pass could ever have caught this, and that is the point worth
// keeping.** Every install in this harness boots the ISO as a CD-ROM, and lsblk
// reports that as `type: "rom"` — which `listDisks()` already drops, because it
// only keeps `type: "disk"`. On real hardware the same ISO is dd'd onto a USB
// stick and comes back as `type: "disk"`, i.e. exactly the case the instrument
// cannot produce. See the skill's note on instruments sharing the blind spot.
//
// ─── HOW IT IS FOUND ─────────────────────────────────────────────────────────
// Not by guessing at removability: an internal disk can be `rm: 0` and hold the
// medium (a USB in a port the firmware reports as fixed), and a perfectly good
// target can be `rm: 1`. The medium is the device the archiso mounts sit on, and
// archiso mounts them at a path nobody else uses: `/run/archiso/bootmnt` for the
// ISO filesystem, plus `/run/archiso/*` for its cow space.
//
// So the question asked here is "which DISK carries a partition mounted under
// /run/archiso", and the answer is the top-level node of that branch — the same
// parent-carried-down walk `listPartitions()` does, and for the same reason: a
// partition's disk is the node it hangs from, never its name with the digits
// stripped (`nvme0n1p2`).

import { exec } from "../../lib/process"

interface LsblkNode {
  path?: string
  mountpoint?: string | null
  mountpoints?: (string | null)[]
  type?: string
  children?: LsblkNode[]
}

const ARCHISO_PREFIX = "/run/archiso"

function mountsOf(node: LsblkNode): string[] {
  // lsblk has reported BOTH shapes in living memory: `mountpoint` (one, possibly
  // null) on older columns and `mountpoints` (an array) since util-linux 2.37.
  // Reading only one of them is how this returns "" on a medium it is standing on.
  const list = Array.isArray(node.mountpoints) ? node.mountpoints : []
  return [...list, node.mountpoint ?? null].filter((m): m is string => typeof m === "string" && m !== "")
}

/**
 * The disk holding the running live medium, from an `lsblk -J` tree — or `""`
 * when nothing in the tree is mounted under `/run/archiso`, which is every
 * machine that is not booted from our ISO (a dev host, the probe runner).
 *
 * Pure, so the probe can put a USB-shaped tree through it on a machine that has
 * no USB and no medium.
 */
export function liveMediumDiskFrom(lsblkJson: string): string {
  let parsed: { blockdevices?: LsblkNode[] }
  try {
    parsed = JSON.parse(lsblkJson)
  } catch (e) {
    console.error("[Installer] Could not parse lsblk output while looking for the live medium:", e)
    return ""
  }

  const carries = (node: LsblkNode): boolean =>
    mountsOf(node).some(m => m === ARCHISO_PREFIX || m.startsWith(`${ARCHISO_PREFIX}/`))
      || (node.children ?? []).some(carries)

  for (const top of parsed.blockdevices ?? []) {
    // ⚠️ The TOP-LEVEL node, not the partition. What has to be kept out of the
    // list is the whole disk: erasing `/dev/sdb` is what takes the medium away,
    // and it is offered as `/dev/sdb` whichever of its partitions is mounted.
    if (carries(top) && top.path) return top.path
  }
  return ""
}

let _cached: string | null = null

/**
 * The disk holding the running live medium, asked of this machine.
 *
 * Returns `""` on any failure, and that is deliberate: this function can only
 * ever REMOVE a disk from the list, so a broken lsblk must leave the page
 * exactly as it was rather than hide every disk on the machine.
 */
export function liveMediumDisk(): string {
  // Cached for the life of the process: the medium a session booted from cannot
  // change while it is running, and this is asked again on every rebuild of the
  // manual table — which happens on every assignment, every refresh and every
  // change of language.
  if (_cached !== null) return _cached
  try {
    _cached = liveMediumDiskFrom(exec(["lsblk", "-J", "-o", "PATH,MOUNTPOINTS,TYPE"]))
  } catch (e) {
    console.error("[Installer] Could not ask lsblk which disk the medium is on:", e)
    _cached = ""
  }
  return _cached
}

/**
 * The disks that may be installed onto: everything except the one the medium is
 * on.
 *
 * It is a function rather than a `.filter()` at the call site so the probe can
 * check the EXCLUSION and not just the detection — the bug was never in finding
 * the medium, it was in offering it. An empty `live` (a machine that is not
 * booted from our ISO) removes nothing.
 */
export function excludeLiveMedium<T extends { path: string }>(disks: T[], live: string): T[] {
  return live ? disks.filter(d => d.path !== live) : disks
}
