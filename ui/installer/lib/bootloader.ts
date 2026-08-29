import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Answers } from "./answers"

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
export function detectOtherOperatingSystems(): boolean {
  // 1. Check if Windows Boot Manager exists in the EFI partition
  try {
    if (GLib.file_test("/mnt/boot/EFI/Microsoft", GLib.FileTest.IS_DIR)) {
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

  appendLog("[BOOTLOADER] Configuring systemd-boot for Nidara...")

  // 1. Rename 'Arch Linux' -> 'Nidara' in loader entries
  try {
    runCmd([
      "bash",
      "-c",
      "sed -i 's/^title\\s\\+Arch Linux/title\\tNidara/' /mnt/boot/loader/entries/*.conf 2>/dev/null || true",
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
  // ⚠️ `splash` is still here and must be: the initramfs half arrives with the package,
  // but a splash needs both, and the cmdline half has no owner but us. `nowatchdog` and
  // the `modprobe.blacklist=` list are duplicated by the package's drop-ins on purpose —
  // the cmdline reaches the kernel before any file in /etc is read, which is the point of
  // putting them there as well.
  const silentParams = "quiet splash loglevel=3 systemd.show_status=false vt.global_cursor_default=0 fbcon=nodefer nowatchdog modprobe.blacklist=iTCO_wdt,sp5100_tco,i6300esb,wdat_wdt"
  try {
    runCmd([
      "bash",
      "-c",
      `for f in /mnt/boot/loader/entries/*.conf; do
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
    const hasOtherOS = detectOtherOperatingSystems() || answers.disk?.mode === "manual"
    const timeout = hasOtherOS ? 3 : 0

    runCmd([
      "bash",
      "-c",
      `cat > /mnt/boot/loader/loader.conf << 'EOF'
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
