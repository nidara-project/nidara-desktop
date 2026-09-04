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
 * Detects whether another operating system is installed on the machine
 * (e.g. Windows EFI binaries or other OS partitions).
 */
export function detectOtherOperatingSystems(loaderDir: string = "/mnt/boot"): boolean {
  // 1. Check if Windows Boot Manager exists in the EFI partition
  try {
    if (GLib.file_test(`${loaderDir}/EFI/Microsoft`, GLib.FileTest.IS_DIR)) {
      return true
    }
  } catch {}

  // 2. Check if other disk partitions have Windows (ntfs/bitlocker) or other OSes
  try {
    const isRoot = GLib.get_user_name() === "root"
    const cmd = isRoot
      ? ["lsblk", "-J", "-o", "NAME,FSTYPE,LABEL,MOUNTPOINTS"]
      : ["sudo", "-n", "lsblk", "-J", "-o", "NAME,FSTYPE,LABEL,MOUNTPOINTS"]
    const proc = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDOUT_PIPE)
    const [ok, stdout] = proc.communicate_utf8(null, null)
    if (ok && stdout) {
      const jsonStr = stdout.toLowerCase()
      if (jsonStr.includes('"fstype": "ntfs"') || jsonStr.includes('"fstype": "bitlocker"')) {
        return true
      }
    }
  } catch {}

  return false
}

/**
 * Configures systemd-boot on the installed system:
 * 1. Renames entry titles to "Nidara" (e.g. "Nidara (linux)")
 * 2. Injects silent boot parameters (quiet loglevel=3 systemd.show_status=false vt.global_cursor_default=0)
 * 3. Configures loader.conf with smart timeout (0s for single boot, 3s for dual boot)
 */
export function configureInstalledBootloader(
  arm: boolean,
  answers: Answers,
  appendLog: (msg: string) => void,
) {
  if (!arm) return

  const loaderDir = loaderRoot(answers)
  appendLog(`[BOOTLOADER] Configuring systemd-boot for Nidara (${loaderDir})...`)

  // 1. Rename 'Arch Linux' -> 'Nidara' in loader entries
  try {
    runCmd([
      "bash",
      "-c",
      `sed -i 's/^title\\s\\+Arch Linux/title\\tNidara/' ${loaderDir}/loader/entries/*.conf 2>/dev/null || true`,
    ])
    appendLog("[BOOTLOADER] Updated bootloader entries title to Nidara.")
  } catch (e: any) {
    appendLog(`[BOOTLOADER] Note: Entry title adjustment skipped: ${e.message || e}`)
  }

  // 2. The kernel command line — and ONLY the kernel command line.
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
  try {
    runCmd([
      "bash",
      "-c",
      `for f in ${loaderDir}/loader/entries/*.conf; do
        if [ -f "$f" ] && ! grep -q "quiet" "$f"; then
          sed -i '/^options/ s/$/ ${silentParams}/' "$f"
        fi
      done`,
    ])
    appendLog("[BOOTLOADER] Added silent boot and splash parameters to the kernel command line.")
  } catch (e: any) {
    appendLog(`[BOOTLOADER] Note: Silent boot parameters injection skipped: ${e.message || e}`)
  }

  // 3. Configure loader.conf with smart timeout
  try {
    const hasOtherOS = detectOtherOperatingSystems(loaderDir) || answers.disk?.mode === "manual"
    const timeout = hasOtherOS ? 3 : 0

    runCmd([
      "bash",
      "-c",
      `cat > ${loaderDir}/loader/loader.conf << 'EOF'
default @saved
timeout ${timeout}
console-mode keep
EOF`,
    ])
    appendLog(`[BOOTLOADER] Configured loader.conf (timeout: ${timeout}s, dual-boot detected: ${hasOtherOS}).`)
  } catch (e: any) {
    appendLog(`[BOOTLOADER] Note: loader.conf update skipped: ${e.message || e}`)
  }
}
