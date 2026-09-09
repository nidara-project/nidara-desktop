// bitlocker-probe — verifying BitLocker detection and warning generation (#448).
//
//   ./scripts/bundle.sh --js scripts/dev/bitlocker-probe.ts /tmp/bitlocker-probe.js \
//     && gjs -m /tmp/bitlocker-probe.js
//
// Tests:
//   1. Positive control with synthetic `lsblk -J -b -o NAME,FSTYPE` containing "BitLocker"
//   2. Negative control with synthetic `lsblk -J -b -o NAME,FSTYPE` without BitLocker
//   3. Case-insensitivity checks ("bitlocker", "BitLocker", "BITLOCKER")
//   4. Full lsblk JSON format with PATH and multiple partitions
//   5. Negative control on this host machine (reading real lsblk)
//   6. Verification of warning interpolation across all 12 supported locales

import {
  isBitlocker,
  findBitlockerDevices,
  bitlockerWarnings,
} from "../../ui/installer/lib/bitlocker"
import {
  setLocale,
  getLocale,
  t,
  type Locale,
} from "../../ui/installer/lib/i18n"
import { exec } from "../../ui/lib/process"

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

// ── 1. Positive Control: mock `lsblk -J -b -o NAME,FSTYPE` with BitLocker ────
print("\n── 1. Positive control (mock `lsblk -J -b -o NAME,FSTYPE` with BitLocker) ──")

const mockLsblkPositive = JSON.stringify({
  blockdevices: [
    {
      name: "sda",
      fstype: null,
      children: [
        { name: "sda1", fstype: "vfat" },
        { name: "sda2", fstype: "BitLocker" },
        { name: "sda3", fstype: "ntfs" },
      ],
    },
  ],
})

const positiveDevs = findBitlockerDevices(mockLsblkPositive)
check("positive control detects BitLocker partition", positiveDevs, ["/dev/sda2"])

const positiveWarnings = bitlockerWarnings(positiveDevs)
check("positive control produces 1 warning", positiveWarnings.length, 1)
const pWarn = positiveWarnings[0] ?? ""
const containsDev = pWarn.includes("/dev/sda2")
const containsBitLocker = pWarn.includes("BitLocker")
check("warning contains device name (/dev/sda2)", containsDev, true)
check("warning contains 'BitLocker'", containsBitLocker, true)

// ── 2. Negative Control: mock `lsblk -J -b -o NAME,FSTYPE` without BitLocker ─
print("\n── 2. Negative control (mock `lsblk -J -b -o NAME,FSTYPE` without BitLocker) ─")

const mockLsblkNegative = JSON.stringify({
  blockdevices: [
    {
      name: "sda",
      fstype: null,
      children: [
        { name: "sda1", fstype: "vfat" },
        { name: "sda2", fstype: "ntfs" },
        { name: "sda3", fstype: "ext4" },
      ],
    },
  ],
})

const negativeDevs = findBitlockerDevices(mockLsblkNegative)
check("negative control detects 0 devices", negativeDevs, [])

const negativeWarnings = bitlockerWarnings(negativeDevs)
check("negative control produces 0 warnings", negativeWarnings, [])

// ── 3. Case-insensitivity & format variants ─────────────────────────────────
print("\n── 3. Case-insensitivity and variants ──────────────────────────────")

check("isBitlocker('BitLocker')", isBitlocker("BitLocker"), true)
check("isBitlocker('bitlocker')", isBitlocker("bitlocker"), true)
check("isBitlocker('BITLOCKER')", isBitlocker("BITLOCKER"), true)
check("isBitlocker('bItLoCkEr')", isBitlocker("bItLoCkEr"), true)
check("isBitlocker('ntfs')", isBitlocker("ntfs"), false)
check("isBitlocker('vfat')", isBitlocker("vfat"), false)
check("isBitlocker('btrfs')", isBitlocker("btrfs"), false)
check("isBitlocker(null)", isBitlocker(null), false)
check("isBitlocker(undefined)", isBitlocker(undefined), false)

// Mock with multiple partitions and lower-case "bitlocker"
const mockLsblkMultiple = JSON.stringify({
  blockdevices: [
    {
      name: "nvme0n1",
      path: "/dev/nvme0n1",
      fstype: null,
      children: [
        { name: "nvme0n1p1", path: "/dev/nvme0n1p1", fstype: "vfat" },
        { name: "nvme0n1p2", path: "/dev/nvme0n1p2", fstype: "bitlocker" },
        { name: "nvme0n1p3", path: "/dev/nvme0n1p3", fstype: "BITLOCKER" },
        { name: "nvme0n1p4", path: "/dev/nvme0n1p4", fstype: "ntfs" },
      ],
    },
  ],
})

const multiDevs = findBitlockerDevices(mockLsblkMultiple)
check("multi-device case-insensitive paths", multiDevs, ["/dev/nvme0n1p2", "/dev/nvme0n1p3"])
const multiWarnings = bitlockerWarnings(multiDevs)
check("multi-device produces 2 warnings", multiWarnings.length, 2)
check("multi warning 1 has nvme0n1p2", multiWarnings[0].includes("/dev/nvme0n1p2"), true)
check("multi warning 2 has nvme0n1p3", multiWarnings[1].includes("/dev/nvme0n1p3"), true)

// ── 4. Negative Control on Real Host Machine ────────────────────────────────
print("\n── 4. Negative control on real host machine ─────────────────────────")

try {
  const hostLsblk = exec(["lsblk", "-J", "-b", "-o", "NAME,FSTYPE"])
  const hostDevs = findBitlockerDevices(hostLsblk)
  check("host machine BitLocker count", hostDevs.length, 0)
  check("host machine has no BitLocker warning", bitlockerWarnings(hostDevs).length, 0)
} catch (e) {
  fail("host lsblk execution", String(e))
}

// ── 5. Locale Interpolation Check (12 languages) ────────────────────────────
print("\n── 5. Locale interpolation check (all 12 languages) ─────────────────")

const allLocales: Locale[] = [
  "en", "es", "fr", "de", "it", "pt-BR", "pt-PT", "pl", "nl", "ru", "zh-CN", "ja",
]

const testDev = "/dev/nvme0n1p3"
const initialLocale = getLocale()

for (const loc of allLocales) {
  setLocale(loc)
  const rawString = t("diskWarnBitlocker")
  const interpolated = rawString.replace("%s", testDev)
  const hasSubstituted = interpolated.includes(testDev)
  const hasLeftover = interpolated.includes("%s")
  const hasBitLockerName = interpolated.includes("BitLocker")

  if (hasSubstituted && !hasLeftover && hasBitLockerName) {
    print(`   ok           locale ${loc.padEnd(6)}: formatted correctly`)
  } else {
    fail(`locale ${loc}`, `subst=${hasSubstituted}, leftover=${hasLeftover}, bitlocker=${hasBitLockerName}`)
  }
}

setLocale(initialLocale)

// ── Summary ─────────────────────────────────────────────────────────────────
print("\n───────────────────────────────────────────────────────────────────")
if (failures > 0) {
  print(`FAILED: ${failures} check(s) failed.`)
  imports.system.exit(1)
} else {
  print("All BitLocker probe checks passed.")
}
