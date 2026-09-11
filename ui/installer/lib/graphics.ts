// Graphics detection and driver package resolution across kernels.
//
// ─── WHY THIS IS IN LIB AND NOT IN STEPS ─────────────────────────────────────
// The installer needs to answer two questions:
// 1. What GPU hardware is in this computer? (Turing+ NVIDIA, legacy NVIDIA, AMD, Intel)
// 2. What packages must be injected into the plan for the chosen kernel?
//
// Keeping this in lib as pure functions allows headless testing in CI (installer-logic)
// without a display or GTK4 runtime.
//
// ─── ARCH LINUX NVIDIA PACKAGE MATRIX (#495, #311) ───────────────────────────
// Arch Linux officially dropped proprietary legacy packages (nvidia, nvidia-lts,
// nvidia-dkms no longer exist in official repos). The official support matrix is:
//
//   Kernel      │ NVIDIA Packages
//   ────────────┼──────────────────────────────────────────────────────────────
//   linux       │ nvidia-open nvidia-utils egl-wayland libva-nvidia-driver
//   linux-lts   │ nvidia-open-lts nvidia-utils egl-wayland libva-nvidia-driver
//   linux-zen   │ nvidia-open-dkms nvidia-utils egl-wayland libva-nvidia-driver dkms linux-zen-headers
//
// Turing+ (RTX 20+, GTX 16+, RTX 30/40/50+) is supported by nvidia-open.
// Pascal (GTX 10xx) and older are supported by open-source Nouveau (mesa).

import Gio from "gi://Gio"

export type KernelOption = "linux" | "linux-lts" | "linux-zen"
export type GpuVendor = "nvidia" | "amd" | "intel" | "other"

export interface DetectedGpu {
  raw: string
  vendor: GpuVendor
  model: string
  chipCode?: string
  nvidiaOpenSupported?: boolean
}

/**
 * Normalizes GPU model name from lspci string.
 */
function extractModel(raw: string, vendor: GpuVendor): string {
  const brackets = [...raw.matchAll(/\[([^\]]+)\]/g)]
    .map(m => m[1].trim())
    .filter(b => !/^(amd\/ati|ati|amd|0300|0302|0380|rev\s+[0-9a-f]+|[0-9a-f]{4}:[0-9a-f]{4})$/i.test(b))

  if (brackets.length > 0) {
    return brackets[brackets.length - 1]
  }

  return raw
    .replace(/^.*?:\s*/, "")
    .replace(/^.*?(Corporation|Inc\.|Technologies|Ltd\.?)\s*/i, "")
    .replace(/\s*\(rev\s+[0-9a-f]+\)/i, "")
    .trim()
}

/**
 * Parses lspci output lines and extracts GPU hardware details.
 */
export function parseGpuInfo(lspciOutput: string): DetectedGpu[] {
  const results: DetectedGpu[] = []
  if (!lspciOutput) return results

  for (const line of lspciOutput.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!/vga compatible controller|3d controller|display controller/i.test(trimmed)) {
      continue
    }

    const isNvidia = /\bnvidia\b|\[10de:/i.test(trimmed)
    const isIntel = /\bintel\b|\[8086:/i.test(trimmed)
    const isAmd = /\b(amd|ati|advanced micro devices)\b|\[1002:/i.test(trimmed)

    const vendor: GpuVendor = isNvidia ? "nvidia" : isIntel ? "intel" : isAmd ? "amd" : "other"
    const model = extractModel(trimmed, vendor)

    if (vendor === "nvidia") {
      const chipMatch = /\b(TU|GA|AD|GH|GB|GP|GM|GK|GF)[0-9]{2,3}\b/i.exec(trimmed)
      const chipCode = chipMatch ? chipMatch[0].toUpperCase() : undefined

      // Turing+ check: chip code starts with TU, GA, AD, GH, GB
      // Or fallback to marketing model pattern if chip code wasn't emitted by lspci
      const isTuringPlusChip = chipCode ? /^(TU|GA|AD|GH|GB)/.test(chipCode) : false
      const isTuringPlusModel = /\b(RTX\s*(20|30|40|50)[0-9]{2}|GTX\s*16[0-9]{2}|TITAN\s*RTX|Quadro\s*RTX|RTX\s*[A-Z]?[0-9]{4})\b/i.test(trimmed)

      const nvidiaOpenSupported = isTuringPlusChip || isTuringPlusModel

      results.push({
        raw: trimmed,
        vendor,
        model,
        chipCode,
        nvidiaOpenSupported,
      })
    } else {
      results.push({
        raw: trimmed,
        vendor,
        model,
      })
    }
  }

  return results
}

/**
 * Detects GPUs in the current system via `lspci -nn`.
 * Returns empty array if lspci fails or is unavailable.
 */
export async function detectGpus(): Promise<DetectedGpu[]> {
  return new Promise(resolve => {
    try {
      const proc = Gio.Subprocess.new(
        ["lspci", "-nn"],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      )
      proc.communicate_utf8_async(null, null, (_: any, res: any) => {
        try {
          const [, stdout] = proc.communicate_utf8_finish(res)
          if (proc.get_successful() && stdout) {
            resolve(parseGpuInfo(stdout))
            return
          }
        } catch {}
        resolve([])
      })
    } catch {
      resolve([])
    }
  })
}

/**
 * Resolves packages required for open-source NVIDIA drivers for the chosen kernel.
 */
export function getNvidiaDriverPackages(kernel: KernelOption): string[] {
  const common = ["nvidia-utils", "egl-wayland", "libva-nvidia-driver"]

  switch (kernel) {
    case "linux":
      return ["nvidia-open", ...common]
    case "linux-lts":
      return ["nvidia-open-lts", ...common]
    case "linux-zen":
      return ["nvidia-open-dkms", ...common, "dkms", "linux-zen-headers"]
  }
}
