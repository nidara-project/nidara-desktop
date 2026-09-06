import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { espMount } from "./disk-config"
import type { Answers } from "./answers"

/**
 * Where, under /mnt, the loader configuration this function edits actually lives.
 *
 * ⚠️ Every path here used to be spelled `/mnt/boot`, and manual mode offers three
 * places to put the EFI system partition (`/boot`, `/boot/efi`, `/efi`). Choose
 * either of the other two — `/boot/efi` is the Debian/Ubuntu/Fedora spelling, so
 * it is what somebody reusing an existing layout is most likely to pick — and
 * archinstall installs the bootloader onto that partition while all three edits
 * below land in an ordinary `/boot` directory on the root filesystem: renamed
 * entries nobody reads, a silent boot nobody gets, and a `loader.conf` the
 * firmware never sees. Nothing fails; the machine simply boots as stock Arch,
 * fifteen seconds of menu included. (Installer study, H-03.)
 *
 * The two paths archinstall itself derives are `$ESP/loader/loader.conf` and
 * `$BOOT/loader/entries` (`installer._add_systemd_bootloader`,
 * `_create_bls_entries`), and $BOOT is the partition carrying the `boot` flag —
 * which, in the layout we emit, is the ESP itself. So one answer serves both.
 */
export function loaderRoot(answers: Answers): string {
  if (answers.disk?.mode !== "manual") return "/mnt/boot"
  return `/mnt${espMount(answers.disk.mounts)?.mountpoint ?? "/boot"}`
}

function runCmd(cmd: string[]): string {
  const isRoot = GLib.get_user_name() === "root"
  const fullCmd = isRoot ? cmd : ["sudo", "-n", ...cmd]
  const proc = Gio.Subprocess.new(fullCmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  const [ok, stdout, stderr] = proc.communicate_utf8(null, null)
  if (!proc.get_successful()) {
    throw new Error(stderr?.trim() || `Command failed: ${fullCmd.join(" ")}`)
  }
  return stdout?.trim() || ""
}

/**
 * Write a file under /mnt through the same privilege escalation as everything
 * else here — the content goes in on STDIN rather than through a shell heredoc.
 *
 * ⚠️ It has to. The one file this writes can be somebody ELSE'S `loader.conf`,
 * carrying whatever they put in it, and a heredoc puts arbitrary foreign text
 * back through a shell that will read it as syntax. `tee` reading STDIN never
 * looks at the bytes.
 */
function writeTextAsRoot(path: string, text: string): void {
  const isRoot = GLib.get_user_name() === "root"
  const cmd = isRoot ? ["tee", path] : ["sudo", "-n", "tee", path]
  const proc = Gio.Subprocess.new(
    cmd,
    Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE,
  )
  const [, , stderr] = proc.communicate_utf8(text, null)
  if (!proc.get_successful()) throw new Error(stderr?.trim() || `Could not write ${path}`)
}

/**
 * The moment this install started, in the spelling archinstall stamps its own
 * output with (`time.strftime('%Y-%m-%d_%H-%M-%S')`, `installer.py:95`).
 *
 * Recorded by the caller BEFORE archinstall is spawned, and the reason it exists
 * is `entryIsOurs` below: it is the line between the entries this run produced
 * and the ones that were already on the disk.
 */
export function archinstallStamp(): string {
  return GLib.DateTime.new_now_local().format("%Y-%m-%d_%H-%M-%S") ?? ""
}

/**
 * Is this loader entry one WE just produced?
 *
 * ## Why this question has to be asked at all
 *
 * An EFI system partition can be shared. Somebody installing Nidara beside an
 * existing Windows or Ubuntu reuses the ESP that is already there — that is the
 * whole point of reusing it, one firmware menu with everything on it — and
 * `loader/entries/` then holds their entries as well as ours. Every edit below
 * used to run over `*.conf`, so a neighbouring Arch install had its entry
 * retitled `Nidara` (two entries with our name, one of which boots somebody
 * else's system) and any foreign entry without `quiet` had our kernel command
 * line appended to it (#443).
 *
 * ## How the line is drawn
 *
 * archinstall writes a header into every entry it creates
 * (`installer.py:1224-1232`):
 *
 *     # Created by: archinstall
 *     # Created on: 2026-09-06_20-31-04
 *
 * and that timestamp is `init_time`, fixed when its `Installer` is constructed —
 * so every entry from ONE run carries the same stamp, and a run that happened
 * before ours carries an earlier one. `startedAt` is taken just before we spawn
 * it, so `>=` is "written by the archinstall we started".
 *
 * ⚠️ This reads another program's output format, and it fails SAFE by
 * construction: if archinstall ever stops writing that header, nothing matches,
 * we edit nothing, and the person gets an entry titled `Arch Linux` — cosmetic.
 * The alternative failure, matching too much, edits a system that is not ours.
 * Which way a wrong guess falls is the whole reason it is written this way round.
 */
export function entryIsOurs(text: string, startedAt: string): boolean {
  if (!/^#\s*Created by:\s*archinstall\s*$/m.test(text)) return false
  const stamp = text.match(/^#\s*Created on:\s*(\S+)\s*$/m)?.[1]
  if (!stamp) return false
  // Same format on both sides (`%Y-%m-%d_%H-%M-%S`), so lexicographic order IS
  // chronological order — no parsing, and no timezone to get wrong.
  return stamp >= startedAt
}

/** `title Arch Linux (linux)` → `title Nidara (linux)`. The kernel keeps its name. */
export function retitleEntry(text: string): string {
  return text.replace(/^title(\s+)Arch Linux/m, "title\tNidara")
}

/**
 * Append the silent-boot parameters to an entry's kernel command line, unless it
 * already carries them.
 *
 * ⚠️ The "already?" test reads the `options` LINE, not the file. The file also
 * holds the header comments and, on a machine somebody has edited, whatever they
 * wrote there — and the old test (`grep -q quiet <file>`) would have been
 * satisfied by the word appearing in a comment.
 */
export function withSilentParams(text: string, params: string): string {
  return text.replace(/^options[ \t]+(.*)$/m, (line, rest: string) =>
    /(^|\s)quiet(\s|$)/.test(rest) ? line : `options ${rest} ${params}`)
}

/**
 * What `loader/loader.conf` should say after us — given what it says now.
 *
 * ## The rule, and why it is this one
 *
 * This file used to be written flat, three lines, no questions asked. On a shared
 * ESP it is not ours: it belongs to whoever installed first, and it carries their
 * `default`, their `timeout` and their console settings (#444). systemd itself is
 * careful here — `bootctl install` refuses to overwrite an existing `loader.conf`
 * (`src/bootctl/bootctl-install.c:913`) — and so is archinstall, which reads the
 * file and replaces only its `default` line (`installer.py:1310-1326`). We were
 * the one program in the chain that destroyed it.
 *
 * So: when the ESP is ours alone, this writes the canonical file, exactly as
 * before. When it is SHARED, it changes **one key, `timeout`, and only upwards**:
 *
 * - a foreign timeout LONGER than ours is left alone — a slower menu is a
 *   preference, not a fault;
 * - a timeout of 0 (or a commented-out one, which means the same thing to
 *   systemd: no menu unless a key is held) is raised to ours, because otherwise
 *   the entry we just added cannot be reached at all;
 * - `default`, `console-mode`, `editor` and every other line survive untouched,
 *   including ones we have never heard of.
 *
 * Returns the file's new content — identical to `existing` when there is nothing
 * to do, which is how the caller knows not to write at all.
 */
export function patchLoaderConf(
  existing: string | null,
  opts: { timeout: number; shared: boolean },
): string {
  const ours = `default @saved\ntimeout ${opts.timeout}\nconsole-mode keep\n`
  if (existing === null || existing.trim() === "") return ours
  if (!opts.shared) return ours

  const lines = existing.split("\n")
  const idx = lines.findIndex(l => /^\s*#?\s*timeout\b/.test(l))
  if (idx === -1) {
    // No timeout at all. Appended rather than prepended: a key at the end of a
    // file somebody may read later is a key they can see we added.
    const body = existing.endsWith("\n") ? existing : existing + "\n"
    return `${body}timeout ${opts.timeout}\n`
  }

  const commented = /^\s*#/.test(lines[idx])
  const current = Number(lines[idx].match(/timeout\s+(\d+)/)?.[1] ?? NaN)
  // A commented line is not in force, so its number is not a preference — and a
  // `timeout menu-force`/`menu-hidden` (systemd accepts words here) is not a
  // number at all: NaN, and we leave the person's word alone rather than
  // replacing a setting we did not understand.
  if (!commented && Number.isNaN(current)) return existing
  if (!commented && current >= opts.timeout) return existing

  lines[idx] = `timeout ${opts.timeout}`
  return lines.join("\n")
}

/**
 * Is there another operating system on this ESP, or on this machine?
 *
 * Pure, because every input is something the caller had to go and read anyway,
 * and because the answer decides whether a boot MENU appears at all — a rule
 * worth being able to test without a disk.
 */
export function otherOsPresent(facts: {
  /** Entries in `loader/entries/` that this install did not write. */
  foreignEntries: number
  /** The directory names under `EFI/` on the ESP. */
  vendorDirs: string[]
  /** An NTFS or BitLocker filesystem exists somewhere on the machine. */
  windowsFilesystem: boolean
}): boolean {
  if (facts.foreignEntries > 0) return true
  if (facts.windowsFilesystem) return true
  // Everything an Arch + systemd-boot install puts there itself. Anything else —
  // `Microsoft`, `ubuntu`, `fedora`, `debian`, `Pop_OS` — is somebody's bootloader.
  //
  // ⚠️ Lowercased: an ESP is FAT, `EFI/Microsoft` and `EFI/microsoft` are the same
  // directory, and which one `ls` reports is not ours to predict.
  const ours = new Set(["systemd", "boot", "linux", "arch", "nidara"])
  return facts.vendorDirs.some(d => d.trim() !== "" && !ours.has(d.trim().toLowerCase()))
}

/** An NTFS or BitLocker volume anywhere on the machine — the Windows tell. */
function hasWindowsFilesystem(): boolean {
  try {
    const isRoot = GLib.get_user_name() === "root"
    const cmd = isRoot
      ? ["lsblk", "-J", "-o", "NAME,FSTYPE,LABEL,MOUNTPOINTS"]
      : ["sudo", "-n", "lsblk", "-J", "-o", "NAME,FSTYPE,LABEL,MOUNTPOINTS"]
    const proc = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDOUT_PIPE)
    const [ok, stdout] = proc.communicate_utf8(null, null)
    if (ok && stdout) {
      const jsonStr = stdout.toLowerCase()
      return jsonStr.includes('"fstype": "ntfs"') || jsonStr.includes('"fstype": "bitlocker"')
    }
  } catch {}
  return false
}

/**
 * Detects whether another operating system is installed on the machine.
 *
 * ⚠️ It used to look for exactly two things: an `EFI/Microsoft` directory, and
 * `ntfs`/`bitlocker` in `lsblk`. Both are Windows. So on a machine whose other
 * system is Ubuntu or Fedora — or another Arch — this answered `false`, and the
 * caller then wrote `timeout 0`: systemd-boot goes straight into Nidara and the
 * neighbouring system, still installed and still bootable, has no menu to be
 * reached from (#445). Now it also counts foreign loader entries and foreign
 * vendor directories on the ESP, which is where a Linux neighbour actually shows.
 */
export function detectOtherOperatingSystems(
  loaderDir: string = "/mnt/boot",
  foreignEntries: number = 0,
): boolean {
  let vendorDirs: string[] = []
  try {
    vendorDirs = runCmd(["bash", "-c", `ls -1 ${loaderDir}/EFI 2>/dev/null || true`])
      .split("\n").filter(Boolean)
  } catch {}
  return otherOsPresent({ foreignEntries, vendorDirs, windowsFilesystem: hasWindowsFilesystem() })
}

/** One loader entry as it sits on the disk. */
type LoaderEntry = { path: string; text: string }

function readLoaderEntries(loaderDir: string): LoaderEntry[] {
  let paths: string[] = []
  try {
    paths = runCmd(["bash", "-c", `ls -1 ${loaderDir}/loader/entries/*.conf 2>/dev/null || true`])
      .split("\n").filter(Boolean)
  } catch {}
  const out: LoaderEntry[] = []
  for (const path of paths) {
    try { out.push({ path, text: runCmd(["cat", path]) }) } catch {}
  }
  return out
}

/**
 * Configures systemd-boot on the installed system:
 * 1. Retitles the entries THIS install produced to "Nidara (linux)"
 * 2. Injects the silent boot parameters into those same entries
 * 3. Sets a timeout that makes every installed system reachable
 *
 * ⚠️ Everything it touches is scoped to what we wrote, because the ESP may be
 * shared with a system that was here first — see `entryIsOurs` and
 * `patchLoaderConf`. Nothing in this function may go back to editing `*.conf`.
 */
export function configureInstalledBootloader(
  arm: boolean,
  answers: Answers,
  appendLog: (msg: string) => void,
  startedAt: string,
) {
  if (!arm) return

  const loaderDir = loaderRoot(answers)
  appendLog(`[BOOTLOADER] Configuring systemd-boot for Nidara (${loaderDir})...`)

  const entries = readLoaderEntries(loaderDir)
  const ours = entries.filter(e => entryIsOurs(e.text, startedAt))
  const foreign = entries.length - ours.length
  if (foreign > 0) {
    appendLog(`[BOOTLOADER] ${foreign} loader ${foreign === 1 ? "entry belongs" : "entries belong"} `
      + "to another system on this EFI partition — left untouched.")
  }
  if (ours.length === 0 && entries.length > 0) {
    // Not an error, and worth saying out loud: it means the header archinstall
    // stamps its entries with has changed, and the two edits below did nothing.
    appendLog("[BOOTLOADER] Note: none of the loader entries carry this run's archinstall stamp; "
      + "leaving all of them alone.")
  }

  // 1 & 2. The title and the kernel command line — and ONLY the kernel command line.
  //
  // This function used to also write /etc/systemd/system.conf.d/00-watchdog.conf,
  // /etc/modprobe.d/nowatchdog.conf, /etc/plymouth/plymouthd.conf and a `sed` into the
  // target's mkinitcpio.conf. All four are now the `nidara-system` package's, installed
  // by base.json alongside `nidara` — see nidara-iso/PRODUCT.md, "Four layers". They left
  // for one reason: written here they were applied ONCE, at install, so a machine
  // installed in August would never receive an improvement to its own boot. A package
  // arrives by `pacman -Syu` like everything else.
  //
  // What stays is what genuinely cannot be packaged: these entries are archinstall's
  // output, named after this machine's kernels, and nothing owns them. The loader
  // timeout below is the same — it depends on what else is on THIS disk.
  //
  // ⚠️ `splash` is here and must be: the initramfs half arrives with the `nidara-system`
  // package, a splash needs both halves, and the cmdline half has no owner but us.
  //
  // ⚠️ `nowatchdog` and `modprobe.blacklist=iTCO_wdt,…` were here too until 2026-08-30, to
  // silence `watchdog: watchdog0: watchdog did not stop!` over the splash. They are gone,
  // and the package's `RebootWatchdogSec=off` is expected to do the whole job on its own:
  // that message appears because systemd ARMS the watchdog for the second phase of a
  // reboot and the driver then cannot stop it, so not arming it leaves nothing to
  // silence. Blacklisting the modules removes the watchdog device from every machine
  // permanently — the big hammer for what the small one covers.
  //
  // If a VM pass shows the message surviving, the honest fix is to put the blacklist back
  // HERE rather than in the package: a kernel parameter is per-machine and reversible by
  // editing one loader entry, while a modprobe drop-in is a decision taken for everybody.
  const silentParams = "quiet splash loglevel=3 systemd.show_status=false vt.global_cursor_default=0 fbcon=nodefer"
  let retitled = 0
  for (const entry of ours) {
    const next = withSilentParams(retitleEntry(entry.text), silentParams)
    if (next === entry.text) continue
    try {
      writeTextAsRoot(entry.path, next)
      retitled++
    } catch (e: any) {
      appendLog(`[BOOTLOADER] Note: could not update ${entry.path}: ${e.message || e}`)
    }
  }
  if (retitled > 0) {
    appendLog(`[BOOTLOADER] Titled ${retitled} ${retitled === 1 ? "entry" : "entries"} as Nidara, `
      + "with silent boot and splash on the kernel command line.")
  }

  // 3. The timeout — the one key we are entitled to on a shared ESP.
  try {
    const hasOtherOS = detectOtherOperatingSystems(loaderDir, foreign) || answers.disk?.mode === "manual"
    const timeout = hasOtherOS ? 3 : 0
    const path = `${loaderDir}/loader/loader.conf`
    let existing: string | null = null
    try { existing = runCmd(["cat", path]) } catch {}

    // Shared means: somebody else's entries are on this ESP. A Windows-only
    // neighbour has no loader entries of ours to collide with, but it did not
    // write this file either — archinstall did, this run. So the file is ours to
    // shape unless another Linux is sharing it.
    const next = patchLoaderConf(existing, { timeout, shared: foreign > 0 })
    if (next === existing) {
      appendLog("[BOOTLOADER] loader.conf already shows a menu for long enough — left as it is.")
    } else {
      writeTextAsRoot(path, next)
      appendLog(`[BOOTLOADER] Configured loader.conf (timeout: ${timeout}s, another system present: ${hasOtherOS}).`)
    }
  } catch (e: any) {
    appendLog(`[BOOTLOADER] Note: loader.conf update skipped: ${e.message || e}`)
  }
}
