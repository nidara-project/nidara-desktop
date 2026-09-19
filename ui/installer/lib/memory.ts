// Reading and evaluating total system RAM.
//
// ⚠️ Runs unprivileged from `/proc/meminfo`.
// During live installation, archinstall + pacstrap download and decompress
// hundreds of packages while running within a zram or ramfs environment.
// Machines with less than 2.8 GiB of RAM (~3 GB) are prone to Out-Of-Memory (OOM)
// killing pacman or GJS midway through the install.
//
// Calamares and Anaconda check minimum memory requirements on their welcome pages.
// Here we detect MemTotal and offer an advisory warning if RAM is low.

import GLib from "gi://GLib"

export const MIN_RECOMMENDED_RAM_MIB = 2800

/**
 * Read the total physical memory in MiB from `/proc/meminfo`.
 * Returns null if the file cannot be read or parsed.
 */
export function readTotalMemoryMib(meminfoPath: string = "/proc/meminfo"): number | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(meminfoPath)
    if (!ok || !bytes) return null
    const text = new TextDecoder().decode(bytes as Uint8Array)
    const match = text.match(/^MemTotal:\s+(\d+)\s+kB/m)
    if (!match) return null
    const kib = parseInt(match[1], 10)
    if (isNaN(kib)) return null
    return Math.round(kib / 1024)
  } catch {
    return null
  }
}

/**
 * True when the machine has less than the recommended RAM threshold.
 */
export function isLowMemory(memMib: number | null, thresholdMib: number = MIN_RECOMMENDED_RAM_MIB): boolean {
  if (memMib === null) return false
  return memMib < thresholdMib
}
