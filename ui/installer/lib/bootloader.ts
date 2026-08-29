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

  // 2. Add Silent Boot + Plymouth Splash parameters and disable hardware watchdog
  const silentParams = "quiet splash loglevel=3 systemd.show_status=false vt.global_cursor_default=0 fbcon=nodefer nowatchdog modprobe.blacklist=iTCO_wdt,sp5100_tco,i6300esb,wdat_wdt"
  try {
    runCmd([
      "bash",
      "-c",
      `for f in /mnt/boot/loader/entries/*.conf; do
        if [ -f "$f" ] && ! grep -q "quiet" "$f"; then
          sed -i '/^options/ s/$/ ${silentParams}/' "$f"
        fi
      done
      mkdir -p /mnt/etc/systemd/system.conf.d
      cat > /mnt/etc/systemd/system.conf.d/00-watchdog.conf << 'EOF'
[Manager]
RuntimeWatchdogSec=off
RebootWatchdogSec=off
ShutdownWatchdogSec=off
KExecWatchdogSec=off
EOF
      mkdir -p /mnt/etc/modprobe.d
      cat > /mnt/etc/modprobe.d/nowatchdog.conf << 'EOF'
blacklist iTCO_wdt
blacklist iTCO_vendor_support
blacklist sp5100_tco
blacklist i6300esb
blacklist wdat_wdt
EOF

      # Configure Plymouth if installed
      if [ -f /mnt/usr/bin/plymouth ]; then
        mkdir -p /mnt/etc/plymouth
        cat > /mnt/etc/plymouth/plymouthd.conf << 'EOF'
[Daemon]
Theme=nidara
ShowDelay=0
EOF
        if [ -f /mnt/etc/mkinitcpio.conf ] && ! grep -q "plymouth" /mnt/etc/mkinitcpio.conf; then
          sed -i 's/HOOKS=(\\(.*\\)udev\\(.*\\))/HOOKS=(\\1udev plymouth\\2)/' /mnt/etc/mkinitcpio.conf || true
          arch-chroot /mnt mkinitcpio -P 2>/dev/null || true
        fi
      fi`,
    ])
    appendLog("[BOOTLOADER] Configured kernel silent boot + splash parameters and disabled hardware watchdog.")
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
