// firmware-probe — verifying UEFI and Secure Boot state detection.
//
//   ./scripts/bundle.sh --js scripts/dev/firmware-probe.ts /tmp/firmware-probe.js \
//     && gjs -m /tmp/firmware-probe.js
//
// Tests the three states of Secure Boot (#493):
//   1. Enforcing (SecureBoot=1, SetupMode=0) -> "enforcing" (positive control)
//   2. Setup mode (SecureBoot=1, SetupMode=1) -> "disabled"
//   3. Disabled (SecureBoot=0) -> "disabled"
//   4. Missing/absent variable file (e.g. BIOS legacy) -> "unknown"
//   5. Truncated/corrupt variable file (<5 bytes) -> "unknown"
//   6. Negative control on this host machine (which has SecureBoot=0)

import GLib from "gi://GLib"
import {
  isUefi,
  secureBootState,
  SECURE_BOOT_VAR,
  SETUP_MODE_VAR,
} from "../../ui/installer/lib/firmware"

let failures = 0

function fail(name: string, msg: string): void {
  failures++
  print(`   ✗ ${name}: ${msg}`)
}

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    print(`   ok           ${name} = ${JSON.stringify(got)}`)
  } else {
    fail(name, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
}

// 5-byte EFI variable helper: 4 bytes attributes (06 00 00 00) + 1 byte value
function makeEfiVar(val: number): Uint8Array {
  return new Uint8Array([0x06, 0x00, 0x00, 0x00, val])
}

const tmpDir = GLib.dir_make_tmp("nidara-firmware-probe-XXXXXX")

try {
  print("\n── Positive & synthetic controls (mock efivars) ───────────────────")

  // Case 1: POSITIVE CONTROL — SecureBoot=1, SetupMode=0 (Enforcing)
  const dirEnforcing = `${tmpDir}/enforcing`
  GLib.mkdir_with_parents(dirEnforcing, 0o700)
  GLib.file_set_contents(`${dirEnforcing}/${SECURE_BOOT_VAR}`, makeEfiVar(1))
  GLib.file_set_contents(`${dirEnforcing}/${SETUP_MODE_VAR}`, makeEfiVar(0))

  check("enforcing state", secureBootState(dirEnforcing), "enforcing")
  check("enforcing is enforcing", secureBootState(dirEnforcing) === "enforcing", true)

  // Case 2: Setup Mode — SecureBoot=1, SetupMode=1 (Not enforcing)
  const dirSetupMode = `${tmpDir}/setup-mode`
  GLib.mkdir_with_parents(dirSetupMode, 0o700)
  GLib.file_set_contents(`${dirSetupMode}/${SECURE_BOOT_VAR}`, makeEfiVar(1))
  GLib.file_set_contents(`${dirSetupMode}/${SETUP_MODE_VAR}`, makeEfiVar(1))

  check("setup-mode state", secureBootState(dirSetupMode), "disabled")
  check("setup-mode is NOT enforcing", secureBootState(dirSetupMode) === "enforcing", false)

  // Case 3: Disabled — SecureBoot=0, SetupMode=0
  const dirDisabled = `${tmpDir}/disabled`
  GLib.mkdir_with_parents(dirDisabled, 0o700)
  GLib.file_set_contents(`${dirDisabled}/${SECURE_BOOT_VAR}`, makeEfiVar(0))
  GLib.file_set_contents(`${dirDisabled}/${SETUP_MODE_VAR}`, makeEfiVar(0))

  check("disabled state", secureBootState(dirDisabled), "disabled")
  check("disabled is NOT enforcing", secureBootState(dirDisabled) === "enforcing", false)

  // Case 4: Absent file — directory has no SecureBoot variable
  const dirAbsent = `${tmpDir}/absent`
  GLib.mkdir_with_parents(dirAbsent, 0o700)

  check("absent state", secureBootState(dirAbsent), "unknown")
  check("absent is NOT enforcing", secureBootState(dirAbsent) === "enforcing", false)

  // Case 5: Corrupt/short file (<5 bytes)
  const dirCorrupt = `${tmpDir}/corrupt`
  GLib.mkdir_with_parents(dirCorrupt, 0o700)
  GLib.file_set_contents(`${dirCorrupt}/${SECURE_BOOT_VAR}`, new Uint8Array([0x06, 0x00]))

  check("corrupt state", secureBootState(dirCorrupt), "unknown")
  check("corrupt is NOT enforcing", secureBootState(dirCorrupt) === "enforcing", false)

  // Case 6: SecureBoot=1, SetupMode missing
  const dirSmMissing = `${tmpDir}/sm-missing`
  GLib.mkdir_with_parents(dirSmMissing, 0o700)
  GLib.file_set_contents(`${dirSmMissing}/${SECURE_BOOT_VAR}`, makeEfiVar(1))

  check("setupmode-missing state", secureBootState(dirSmMissing), "unknown")
  check("setupmode-missing is NOT enforcing", secureBootState(dirSmMissing) === "enforcing", false)

  print("\n── Negative control on host machine ────────────────────────────────")
  // The host machine has SecureBoot=0; warning MUST NOT trigger here.
  const hostState = secureBootState()
  const hostEnforcing = hostState === "enforcing"
  print(`   host efivars read: state = "${hostState}", enforcing = ${hostEnforcing}`)
  check("host is NOT enforcing", hostEnforcing, false)
  check("host state is disabled", hostState, "disabled")

  print("\n── UEFI boot mode detection ────────────────────────────────────────")
  check("host UEFI mode", isUefi(), true)
  check("missing UEFI dir", isUefi(`${tmpDir}/nonexistent-efi`), false)

} finally {
  // Cleanup temporary test directory
  const rmSub = (dir: string) => {
    try {
      const d = GLib.Dir.open(dir, 0)
      let name: string | null = null
      while ((name = d.read_name()) !== null) {
        const p = `${dir}/${name}`
        if (GLib.file_test(p, GLib.FileTest.IS_DIR)) rmSub(p)
        else GLib.unlink(p)
      }
      GLib.rmdir(dir)
    } catch {}
  }
  rmSub(tmpDir)
}

print("\n───────────────────────────────────────────────────────────────────")
if (failures > 0) {
  print(`FAILED: ${failures} check(s) failed.\n`)
  // @ts-ignore
  imports.system.exit(1)
} else {
  print("All firmware checks passed.\n")
}
