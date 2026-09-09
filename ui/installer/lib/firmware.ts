// Detection of firmware properties: UEFI boot mode and Secure Boot enforcement.
//
// ⚠️ This lives in its own module (`lib/firmware.ts`) rather than inside
// `steps/disk.ts`: it is a pure observation of the firmware, can be tested
// without a window or disk, and multiple steps (disk now, summary later)
// can inspect it.
//
// SECURE BOOT DETECTION (#493):
// On Linux, UEFI runtime variables are exposed by efivarfs under
// `/sys/firmware/efi/efivars/`.
// The variables use the standard EFI Global Variable GUID:
//   8be4df61-93ca-11d2-aa0d-00e098032b8c
//
// In efivarfs, each file consists of:
//   - 4 bytes: 32-bit attribute mask (little-endian uint32, e.g. 0x06 0x00 0x00 0x00)
//   - followed by the variable payload.
// For 1-byte boolean UEFI variables (SecureBoot, SetupMode), the file is exactly
// 5 bytes. The 5th byte (index 4) contains the variable's value:
//   - SecureBoot: 1 = enabled, 0 = disabled.
//   - SetupMode:  1 = setup mode (keys not enrolled/cleared), 0 = user mode.
//
// "Enforcing" requires BOTH: SecureBoot == 1 AND SetupMode == 0.
// With SetupMode == 1, the firmware is in setup/provisioning mode and does not
// enforce signature verification — so we do NOT warn there.
//
// Missing file (e.g. legacy BIOS boot, or firmware not exposing the variable):
// absence = unknown = do NOT warn. A false warning on the disk page is worse
// than none.
//
// Permissions: efivars are world-readable (-rw-r--r-- root root), so the
// installer can read them without privileges as the unprivileged `live` user.

import GLib from "gi://GLib"

export const EFI_DIR = "/sys/firmware/efi"
export const EFIVARS_DIR = "/sys/firmware/efi/efivars"
export const SECURE_BOOT_VAR = "SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"
export const SETUP_MODE_VAR = "SetupMode-8be4df61-93ca-11d2-aa0d-00e098032b8c"

export type SecureBootState = "enforcing" | "disabled" | "unknown"

/**
 * Read the single data byte from an efivarfs variable file.
 *
 * Returns null if the file does not exist, cannot be read, or has fewer than 5 bytes.
 */
export function readEfiVarByte(path: string): number | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok || !bytes || bytes.length < 5) return null
    return bytes[4]
  } catch {
    return null
  }
}

/**
 * Is the machine booted in UEFI mode?
 *
 * Presence of `/sys/firmware/efi` indicates UEFI boot; absence indicates legacy BIOS.
 */
export function isUefi(efiDir: string = EFI_DIR): boolean {
  return GLib.file_test(efiDir, GLib.FileTest.EXISTS)
}

/**
 * Determine the current Secure Boot enforcement state.
 *
 * Distinguishes three states:
 *   - "enforcing": SecureBoot is 1 AND SetupMode is 0 (User Mode enforcing signatures)
 *   - "disabled":  SecureBoot is 0, OR SetupMode is 1 (setup mode, not enforcing)
 *   - "unknown":   Variable file is absent or unreadable (legacy BIOS, or variable not exposed)
 */
export function secureBootState(efivarsDir: string = EFIVARS_DIR): SecureBootState {
  const sbPath = `${efivarsDir}/${SECURE_BOOT_VAR}`
  const sbVal = readEfiVarByte(sbPath)

  if (sbVal === null) return "unknown"
  if (sbVal === 0) return "disabled"
  if (sbVal === 1) {
    const smPath = `${efivarsDir}/${SETUP_MODE_VAR}`
    const smVal = readEfiVarByte(smPath)

    if (smVal === 1) return "disabled"
    if (smVal === 0) return "enforcing"
    return "unknown"
  }
  return "unknown"
}

/**
 * Returns true if Secure Boot is actively enforcing signature checks.
 */
export function isSecureBootEnforcing(stateOrDir?: SecureBootState | string): boolean {
  if (stateOrDir === "enforcing") return true
  if (stateOrDir === "disabled" || stateOrDir === "unknown") return false
  return secureBootState(stateOrDir) === "enforcing"
}
