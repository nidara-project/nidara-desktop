// The swap partition the person asked for, written into the target's fstab.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Since #429 a row assigned to `swap` reaches archinstall as `fs_type:
// "linux-swap"` with no mountpoint, which is what makes it run `mkswap` and
// `swapon` instead of mounting a partition on a directory called /swap (#423).
// Both of those happen during the install. Neither of them puts anything in
// `/etc/fstab`, so nothing in the installed system DECLARES the swap.
//
// ⚠️ **And the machine still has swap after a reboot**, which is what makes this
// worth writing down rather than obvious: measured on the 2026-09-04 VM pass,
// `swapon --show` on the rebooted system lists the partition. What activates it
// is `systemd-gpt-auto-generator`, which reads the GPT partition TYPE — the
// partition keeps the discoverable swap GUID (0657FD6D-…) through archinstall's
// delete-and-recreate, so systemd turns it on by itself. It works, and it works
// through a mechanism nobody chose and nothing on the machine mentions: change
// the partition type, move the disk, or install onto a layout systemd does not
// consider the root disk, and the swap disappears with no error to read.
//
// ─── WHY genfstab DOES NOT WRITE IT, WHICH IS NOT OUR BUG ────────────────────
// archinstall calls `genfstab -pU -f /mnt /mnt` (`installer.genfstab`). The `-f`
// prefix filter exists for swap FILES — a `/mnt/swapfile` does start with /mnt —
// and genfstab applies it to swap devices too:
//
//     # skip devices not part of the prefix
//     [[ $device = "$prefixfilter"* ]] || continue
//
// A swap PARTITION is `/dev/vda3`, which never starts with the prefix, so it is
// always skipped. Every archinstall install with a swap partition is missing that
// line, not just ours.
//
// So the entry is written here, in genfstab's own shape, and keyed by UUID like
// every other line it produces. If upstream ever fixes the filter, the UUID check
// below finds their line and this one does nothing.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Answers } from "./answers"

const TARGET_FSTAB = "/mnt/etc/fstab"

function run(cmd: string[], stdin: string | null = null): string {
  const isRoot = GLib.get_user_name() === "root"
  const fullCmd = isRoot ? cmd : ["sudo", "-n", ...cmd]
  const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    | (stdin !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0)
  const proc = Gio.Subprocess.new(fullCmd, flags)
  const [, stdout, stderr] = proc.communicate_utf8(stdin, null)
  if (!proc.get_successful()) {
    throw new Error(stderr?.trim() || `Command failed: ${fullCmd.join(" ")}`)
  }
  return stdout ?? ""
}

/** genfstab pads its columns; matching it keeps the file one file rather than two. */
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

/**
 * `# /dev/vda3` then `UUID=…  none  swap  defaults  0 0`, in genfstab's own
 * spacing (`write_source` pads the spec to 20, then three tab-separated columns
 * padded to 10).
 *
 * No `pri=`: genfstab only writes one for a swap with a non-negative priority,
 * and a partition activated from fstab gets the kernel's default. That ordering
 * is the one we want anyway — the zram the product ships sits at priority 100, so
 * memory is compressed first and the disk is the fallback.
 */
export function swapFstabEntry(devPath: string, uuid: string): string {
  return `# ${devPath}\n`
    + `${pad(`UUID=${uuid}`, 20)}\t${pad("none", 10)}\t${pad("swap", 10)}\t${pad("defaults", 10)}\t0 0\n\n`
}

/**
 * Declares every swap partition of a manual layout in the installed system's
 * fstab.
 *
 * Runs after archinstall has finished, for the same reason `applyRealName` does:
 * `Installer.__exit__` does not unmount, so /mnt is still there.
 */
export function writeSwapFstabEntries(
  arm: boolean,
  answers: Answers,
  appendLog: (msg: string) => void,
) {
  if (!arm) return

  const disk = answers.disk
  // Entire-disk mode lays down an ESP and a root and nothing else, so there is
  // never a swap partition to declare.
  if (disk?.mode !== "manual") return

  const swaps = disk.mounts.filter(m => m.mountpoint === "swap")
  if (swaps.length === 0) return

  let fstab: string
  try {
    fstab = run(["cat", TARGET_FSTAB])
  } catch (e: any) {
    appendLog(`[WARN] Could not read ${TARGET_FSTAB}, swap not declared: ${e.message || e}`)
    return
  }

  for (const m of swaps) {
    try {
      // ⚠️ Asked of the DEVICE, not assumed from the answer. A formatted row
      // reaches archinstall as `modify`, which deletes the partition and creates
      // it again, so the only honest source for both facts is the disk as it is
      // now. A device that is not swap gets a line saying so instead of an fstab
      // entry that would fail at boot.
      const type = run(["blkid", "-s", "TYPE", "-o", "value", m.path]).trim()
      if (type !== "swap") {
        appendLog(`[WARN] ${m.path} is ${type || "unformatted"}, not swap — no fstab entry written.`)
        continue
      }
      const uuid = run(["blkid", "-s", "UUID", "-o", "value", m.path]).trim()
      if (!uuid) {
        appendLog(`[WARN] ${m.path} has no UUID — no fstab entry written.`)
        continue
      }
      if (fstab.includes(uuid)) {
        appendLog(`[SWAP] ${m.path} is already declared in the installed fstab.`)
        continue
      }

      const entry = swapFstabEntry(m.path, uuid)
      // `tee -a` over stdin rather than a shell redirection: the line carries
      // tabs, and a `bash -c` around it would be one quoting mistake away from
      // writing something else into the file that decides what the machine mounts.
      run(["tee", "-a", TARGET_FSTAB], entry)
      fstab += entry
      appendLog(`[SWAP] ${m.path} declared in the installed fstab (UUID=${uuid}).`)
    } catch (e: any) {
      // Worth a line, not worth failing a finished install: systemd's
      // gpt-auto-generator still turns the partition on, which is exactly the
      // implicit behaviour this function exists to make explicit.
      appendLog(`[WARN] Could not declare ${m.path} as swap in the installed fstab: ${e.message || e}`)
    }
  }
}
