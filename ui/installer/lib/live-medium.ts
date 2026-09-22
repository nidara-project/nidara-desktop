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
// ─── HOW IT IS FOUND, AND WHY IT TAKES TWO ANSWERS ───────────────────────────
// Not by guessing at removability: an internal disk can be `rm: 0` and hold the
// medium (a USB in a port the firmware reports as fixed), and a perfectly good
// target can be `rm: 1`.
//
// The obvious answer is "the disk carrying a mount under /run/archiso", and it is
// half the answer. 🔑 **Measured 2026-09-22, booting the ISO as a usb-storage
// device rather than a CD:** archiso had already copied the image to RAM
// (`/run/archiso/copytoram`, a tmpfs) and UNMOUNTED the stick, so `/dev/sda` —
// 2.4 G, `type: "disk"`, iso9660 — was mounted nowhere at all. A mount-based
// check returns "" on exactly the machine it exists to protect.
//
// So the second answer, and the one that survives copytoram: the kernel command
// line names the medium. Every entry in the ISO's own loader config carries
// `archisosearchuuid=%ARCHISO_UUID%` (and archiso also accepts `archisolabel=`),
// and that UUID is the iso9660 volume id `blkid` reports on the stick AND on its
// first partition — measured in the same run:
//
//     /proc/cmdline  … archisosearchuuid=2026-09-21-12-53-47-00 …
//     /dev/sda       UUID="2026-09-21-12-53-47-00" LABEL="NIDARA_202609" TYPE="iso9660"
//     /dev/sda1      UUID="2026-09-21-12-53-47-00" LABEL="NIDARA_202609"
//
// Either answer names the DISK, never the partition: what has to stay out of the
// list is the whole device, since that is what an install erases.

import { exec } from "../../lib/process"

interface LsblkNode {
  path?: string
  mountpoint?: string | null
  mountpoints?: (string | null)[]
  uuid?: string | null
  label?: string | null
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
 * What the kernel command line says the medium is: the value of
 * `archisosearchuuid=` or `archisolabel=`, or `""` when neither is there (every
 * machine that is not booted from an archiso — a dev host, the probe runner).
 */
export function archisoIdFrom(cmdline: string): string {
  const m = /(?:^|\s)archiso(?:searchuuid|label)=(\S+)/.exec(cmdline)
  return m ? m[1] : ""
}

/**
 * The disk holding the running live medium, from an `lsblk -J` tree and the
 * kernel command line — or `""` when neither says anything about one.
 *
 * Pure, so the probe can put a USB-shaped tree through it on a machine that has
 * no USB and no medium.
 */
export function liveMediumDiskFrom(lsblkJson: string, cmdline = ""): string {
  let parsed: { blockdevices?: LsblkNode[] }
  try {
    parsed = JSON.parse(lsblkJson)
  } catch (e) {
    console.error("[Installer] Could not parse lsblk output while looking for the live medium:", e)
    return ""
  }

  const id = archisoIdFrom(cmdline)
  const carries = (node: LsblkNode): boolean =>
    mountsOf(node).some(m => m === ARCHISO_PREFIX || m.startsWith(`${ARCHISO_PREFIX}/`))
      // The copytoram case: nothing is mounted, and the volume id is the only
      // thing left that says which device this session came off.
      || (!!id && (node.uuid === id || node.label === id))
      || (node.children ?? []).some(carries)

  for (const top of parsed.blockdevices ?? []) {
    // ⚠️ A DISK, and this line is the whole reason the first version of this
    // function did nothing on the machine it was written for. `/dev/loop0` — the
    // squashfs — is mounted at `/run/archiso/airootfs` and lsblk lists it FIRST,
    // so the walk below answered "/dev/loop0", which is a path no disk in the
    // list has: nothing was excluded and the stick stayed on the page. Measured
    // on a USB boot, 2026-09-22, with the rest of the mechanism working.
    //
    // The question is which DISK to keep out of the list, so a loop, a zram or
    // the `rom` a CD shows up as cannot be the answer — none of them is offered.
    if (top.type !== "disk") continue
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
    let cmdline = ""
    try {
      cmdline = exec(["cat", "/proc/cmdline"])
    } catch {
      // A machine with no /proc/cmdline to read is not one of ours; the mount
      // half of the answer still applies.
    }
    _cached = liveMediumDiskFrom(exec(["lsblk", "-J", "-o", "PATH,MOUNTPOINTS,UUID,LABEL,TYPE"]), cmdline)
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
