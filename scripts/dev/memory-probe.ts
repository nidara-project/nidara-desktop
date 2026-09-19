// memory-probe.ts — verify memory detection logic and threshold decisions.
//
// Run with:
//   ./scripts/bundle.sh --js scripts/dev/memory-probe.ts /tmp/memory-probe.js && gjs -m /tmp/memory-probe.js

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { readTotalMemoryMib, isLowMemory, MIN_RECOMMENDED_RAM_MIB } from "../../ui/installer/lib/memory"

// ⚠️ The THROW is what makes this exit non-zero. What was here also scheduled a
// `GLib.idle_add(… imports.system.exit(1))`, and that callback never runs: this
// probe has no main loop, so the idle is dead code. A probe whose failure path is
// dead prints FAIL and exits 0 — the exact defect the `installer-logic` controls
// exist to catch (2026-09-05). The control in CI deletes the threshold comparison
// and requires this to come back non-zero.
function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`)
    throw new Error(msg)
  }
}

// 1. Parsing mock meminfo content
const tmpDir = GLib.dir_make_tmp("meminfo-test-XXXXXX")

try {
  // Low RAM mock (2 GB)
  const lowMemPath = `${tmpDir}/meminfo-low`
  GLib.file_set_contents(lowMemPath, "MemTotal:        2097152 kB\nMemFree:          500000 kB\n")
  const lowMib = readTotalMemoryMib(lowMemPath)
  assert(lowMib === 2048, `Expected 2048 MiB, got ${lowMib}`)
  assert(isLowMemory(lowMib), "2048 MiB should be considered low memory (< 2800)")

  // Sufficient RAM mock (8 GB)
  const highMemPath = `${tmpDir}/meminfo-high`
  GLib.file_set_contents(highMemPath, "MemTotal:        8388608 kB\nMemFree:         4000000 kB\n")
  const highMib = readTotalMemoryMib(highMemPath)
  assert(highMib === 8192, `Expected 8192 MiB, got ${highMib}`)
  assert(!isLowMemory(highMib), "8192 MiB should NOT be considered low memory")

  // Edge threshold
  assert(isLowMemory(MIN_RECOMMENDED_RAM_MIB - 1), "Threshold - 1 should be low memory")
  assert(!isLowMemory(MIN_RECOMMENDED_RAM_MIB), "Exact threshold should not be low memory")
  assert(!isLowMemory(null), "Null memory should safely return false")

  // Invalid file
  const invalidPath = `${tmpDir}/meminfo-invalid`
  GLib.file_set_contents(invalidPath, "InvalidContent: no kB here\n")
  assert(readTotalMemoryMib(invalidPath) === null, "Invalid file should return null")

  // Non-existent path
  assert(readTotalMemoryMib(`${tmpDir}/nonexistent`) === null, "Non-existent file should return null")

  // Real system check if on Linux
  if (GLib.file_test("/proc/meminfo", GLib.FileTest.EXISTS)) {
    const realMib = readTotalMemoryMib("/proc/meminfo")
    assert(typeof realMib === "number" && realMib > 0, `Real system RAM should be > 0 (detected: ${realMib} MiB)`)
  }

  console.log("PASS: memory-probe passed all assertions.")
} finally {
  // Cleanup tmpDir
  try {
    const dir = Gio.File.new_for_path(tmpDir)
    const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info
    while ((info = enumerator.next_file(null)) !== null) {
      dir.get_child(info.get_name()).delete(null)
    }
    dir.delete(null)
  } catch {}
}
