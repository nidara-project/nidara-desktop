// Hands archinstall target disks that nothing on the live medium is still holding.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// A second attempt in the same live session failed before touching anything,
// with `umount -R [SWAP]: not found` (measured, 2026-09-13 manual-mode VM pass).
// The first attempt had installed a swap partition, and archinstall `swapon`s
// what it creates and never turns it off. On the next run
// `device_handler.umount_all_existing` walks the disk's partitions and hands
// every MOUNTPOINT to `umount -R` — and lsblk's mountpoint for an active swap is
// the literal string `[SWAP]`. So the retry dies, with a message nobody can act
// on, and the only way out was rebooting the medium.
//
// Retrying is not an edge case: it is what somebody does after ANY failure — a
// network drop during pacstrap, a mirror that times out — and every one of those
// leaves the same leftovers behind, because archinstall's `Installer.__exit__`
// does not unmount either. So before the spawn, everything on the target disks
// that the live medium still holds is released, in the order the kernel needs:
//
//   1. swaps off           (a swap can sit on a crypt device, so before 3)
//   2. mounts, deepest first ( /mnt/boot before /mnt )
//   3. crypt devices closed, deepest first (a previous encrypted attempt leaves
//      `/dev/mapper/…` open, and cryptsetup cannot close a mapping still mounted)
//
// Only on the TARGET disks. A USB stick the person mounted to copy files from is
// not ours to unmount, and neither is anything on a disk the layout does not name.
//
// The planning is a pure function of lsblk's JSON, so the probe can check the
// order and the scope without a disk.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Answers } from "./answers"

/** One node of `lsblk -J -o NAME,PATH,TYPE,MOUNTPOINTS`. */
export interface BlockNode {
  name: string
  path: string
  type: string
  mountpoints?: (string | null)[]
  children?: BlockNode[]
}

/** The disks this install will write to, as device paths. */
export function targetDisks(answers: Pick<Answers, "disk">): string[] {
  const disk = answers.disk
  if (!disk) return []
  if (disk.mode === "entire_disk") return [disk.disk.path]
  return [...new Set(disk.mounts.map(m => m.device))]
}

/**
 * The commands that release everything on `targets`, in the order they must run.
 * Empty when nothing is held — which is every first attempt.
 */
export function releaseCommands(tree: BlockNode[], targets: string[]): string[][] {
  const swaps: string[] = []
  const mounts: string[] = []
  const crypts: { name: string; depth: number }[] = []

  const walk = (node: BlockNode, depth: number) => {
    for (const mp of node.mountpoints ?? []) {
      if (!mp) continue
      if (mp === "[SWAP]") swaps.push(node.path)
      else mounts.push(mp)
    }
    if (node.type === "crypt") crypts.push({ name: node.name, depth })
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const disk of tree) {
    if (targets.includes(disk.path)) walk(disk, 0)
  }

  // Deepest path first: `/mnt/boot` has to go before `/mnt` or the second umount
  // fails as busy. Counting separators is enough — these are mount points, not
  // arbitrary strings, and a tie is two siblings whose order does not matter.
  const byDepth = (a: string, b: string) => b.split("/").length - a.split("/").length || b.length - a.length
  return [
    ...swaps.map(path => ["swapoff", path]),
    ...[...new Set(mounts)].sort(byDepth).map(mp => ["umount", mp]),
    ...crypts.sort((a, b) => b.depth - a.depth).map(c => ["cryptsetup", "close", c.name]),
  ]
}

function run(cmd: string[]): string {
  const isRoot = GLib.get_user_name() === "root"
  const fullCmd = isRoot ? cmd : ["sudo", "-n", ...cmd]
  const proc = Gio.Subprocess.new(fullCmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  const [, stdout, stderr] = proc.communicate_utf8(null, null)
  if (!proc.get_successful()) {
    throw new Error(stderr?.trim() || `Command failed: ${fullCmd.join(" ")}`)
  }
  return stdout ?? ""
}

/**
 * Releases the target disks. Returns false — and says why in the log — if
 * something could not be released, so the caller stops BEFORE archinstall erases
 * anything: a disk we could not free is one archinstall would fail on halfway.
 */
export function releaseTargetDisks(
  arm: boolean,
  answers: Answers,
  appendLog: (msg: string) => void,
): boolean {
  if (!arm) return true
  const targets = targetDisks(answers)
  if (targets.length === 0) return true

  let tree: BlockNode[]
  try {
    tree = JSON.parse(run(["lsblk", "-J", "-o", "NAME,PATH,TYPE,MOUNTPOINTS", ...targets])).blockdevices ?? []
  } catch (e: any) {
    appendLog(`[WARN] Could not read what is using ${targets.join(", ")}: ${e.message || e}`)
    return true
  }

  for (const cmd of releaseCommands(tree, targets)) {
    appendLog(`[RELEASE] ${cmd.join(" ")}`)
    try {
      run(cmd)
    } catch (e: any) {
      appendLog(`[ERROR] Could not release ${cmd[cmd.length - 1]}, which a previous attempt left in use: ${e.message || e}`)
      return false
    }
  }
  return true
}
