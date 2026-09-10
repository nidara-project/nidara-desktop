// Probe for GPU hardware detection, kernel selection, and NVIDIA driver matrix (#311, #495).
//
// Tests:
// 1. parseGpuInfo correctly identifies Turing+, legacy NVIDIA, AMD, and Intel hardware.
// 2. getNvidiaDriverPackages returns the correct package list for linux, linux-lts, linux-zen.
// 3. assemblePlan injects selected kernel and NVIDIA driver packages, and strips inert gfx_driver.

import { parseGpuInfo, getNvidiaDriverPackages, type KernelOption } from "../../ui/installer/lib/graphics"
import { assemblePlan } from "../../ui/installer/lib/plan"
import type { Answers } from "../../ui/installer/lib/answers"
import type { BaseConfigResult } from "../../ui/installer/lib/base-config"

const print = (s: string) => console.log(s)
let failures = 0

function fail(name: string, reason: string) {
  print(`   FAIL         ${name}: ${reason}`)
  failures++
}

function ok(name: string) {
  print(`   ok           ${name}`)
}

print("\n── GPU hardware detection (parseGpuInfo) ───────────────────────────────\n")

{
  // 1. Turing (GTX 1660 Ti)
  const lspciTuring = "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation TU116 [GeForce GTX 1660 Ti] [10de:2182] (rev a1)"
  const gpusTuring = parseGpuInfo(lspciTuring)
  if (gpusTuring.length === 1 && gpusTuring[0].vendor === "nvidia" && gpusTuring[0].nvidiaOpenSupported === true && gpusTuring[0].chipCode === "TU116") {
    ok("Turing GPU detected as nvidia with open driver support (TU116)")
  } else {
    fail("Turing GPU detection", JSON.stringify(gpusTuring))
  }

  // 2. Ampere (RTX 3060)
  const lspciAmpere = "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA106 [GeForce RTX 3060] [10de:2503] (rev a1)"
  const gpusAmpere = parseGpuInfo(lspciAmpere)
  if (gpusAmpere.length === 1 && gpusAmpere[0].vendor === "nvidia" && gpusAmpere[0].nvidiaOpenSupported === true && gpusAmpere[0].chipCode === "GA106") {
    ok("Ampere GPU detected as nvidia with open driver support (GA106)")
  } else {
    fail("Ampere GPU detection", JSON.stringify(gpusAmpere))
  }

  // 3. Ada Lovelace (RTX 4070)
  const lspciAda = "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation AD104 [GeForce RTX 4070] [10de:2786] (rev a1)"
  const gpusAda = parseGpuInfo(lspciAda)
  if (gpusAda.length === 1 && gpusAda[0].vendor === "nvidia" && gpusAda[0].nvidiaOpenSupported === true && gpusAda[0].chipCode === "AD104") {
    ok("Ada Lovelace GPU detected as nvidia with open driver support (AD104)")
  } else {
    fail("Ada GPU detection", JSON.stringify(gpusAda))
  }

  // 4. Legacy Pascal (GTX 1060)
  const lspciPascal = "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GP106 [GeForce GTX 1060 6GB] [10de:1c03] (rev a1)"
  const gpusPascal = parseGpuInfo(lspciPascal)
  if (gpusPascal.length === 1 && gpusPascal[0].vendor === "nvidia" && gpusPascal[0].nvidiaOpenSupported === false) {
    ok("Pascal GPU detected as legacy nvidia (nvidiaOpenSupported = false)")
  } else {
    fail("Pascal GPU detection", JSON.stringify(gpusPascal))
  }

  // 5. AMD (Radeon RX 5600 XT)
  const lspciAmd = "2d:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT] [1002:731f] (rev c1)"
  const gpusAmd = parseGpuInfo(lspciAmd)
  if (gpusAmd.length === 1 && gpusAmd[0].vendor === "amd" && gpusAmd[0].nvidiaOpenSupported === undefined) {
    ok("AMD GPU correctly detected as vendor amd")
  } else {
    fail("AMD GPU detection", JSON.stringify(gpusAmd))
  }

  // 6. Intel (Alder Lake)
  const lspciIntel = "00:02.0 VGA compatible controller [0300]: Intel Corporation Alder Lake-P GT2 [Iris Xe Graphics] [8086:46a6] (rev 0c)"
  const gpusIntel = parseGpuInfo(lspciIntel)
  if (gpusIntel.length === 1 && gpusIntel[0].vendor === "intel" && gpusIntel[0].nvidiaOpenSupported === undefined) {
    ok("Intel GPU correctly detected as vendor intel")
  } else {
    fail("Intel GPU detection", JSON.stringify(gpusIntel))
  }
}

print("\n── NVIDIA driver package matrix (getNvidiaDriverPackages) ─────────────\n")

{
  const pkgsLinux = getNvidiaDriverPackages("linux")
  if (pkgsLinux.includes("nvidia-open") && pkgsLinux.includes("nvidia-utils") && pkgsLinux.includes("egl-wayland") && pkgsLinux.includes("libva-nvidia-driver")) {
    ok("linux kernel maps to nvidia-open + utils + egl-wayland + libva")
  } else {
    fail("linux kernel packages", JSON.stringify(pkgsLinux))
  }

  const pkgsLts = getNvidiaDriverPackages("linux-lts")
  if (pkgsLts.includes("nvidia-open-lts") && pkgsLts.includes("nvidia-utils")) {
    ok("linux-lts kernel maps to nvidia-open-lts + utils")
  } else {
    fail("linux-lts kernel packages", JSON.stringify(pkgsLts))
  }

  const pkgsZen = getNvidiaDriverPackages("linux-zen")
  if (pkgsZen.includes("nvidia-open-dkms") && pkgsZen.includes("dkms") && pkgsZen.includes("linux-zen-headers")) {
    ok("linux-zen kernel maps to nvidia-open-dkms + dkms + linux-zen-headers")
  } else {
    fail("linux-zen kernel packages", JSON.stringify(pkgsZen))
  }
}

print("\n── Plan assembly with kernel and drivers (assemblePlan) ─────────────────\n")

{
  const mockBase: BaseConfigResult = {
    path: "mock.json",
    config: {
      custom_commands: ["SUDO_USER=nidara nidara-setup"],
      packages: [],
      kernels: ["linux"],
      profile_config: {
        profile: { main: "Minimal" },
        gfx_driver: "All open-source",
      },
    },
  }

  const baseAnswers: Answers = {
    country: null,
    language: null,
    keyboard: null,
    timezone: null,
    disk: null,
    account: {
      fullName: "Test",
      username: "test",
      hostname: "test-box",
      password: "pass",
    },
    system: null,
  }

  // 1. Default system (null) -> defaults to linux kernel, no driver packages
  const planDefault = assemblePlan(baseAnswers, mockBase)
  if (Array.isArray(planDefault.config.kernels) && planDefault.config.kernels[0] === "linux") {
    ok("assemblePlan defaults to linux kernel when system answer is null")
  } else {
    fail("default kernel", JSON.stringify(planDefault.config.kernels))
  }

  // 2. Inert gfx_driver is stripped from profile_config
  if ((planDefault.config.profile_config as any)?.gfx_driver === undefined) {
    ok("assemblePlan strips inert gfx_driver from profile_config")
  } else {
    fail("inert gfx_driver", JSON.stringify(planDefault.config.profile_config))
  }

  // 3. User chooses linux-zen kernel
  const answersZen: Answers = {
    ...baseAnswers,
    system: {
      kernel: "linux-zen",
      installNvidiaOpen: false,
      detectedGpus: [],
    },
  }
  const planZen = assemblePlan(answersZen, mockBase)
  if (Array.isArray(planZen.config.kernels) && planZen.config.kernels[0] === "linux-zen") {
    ok("assemblePlan respects linux-zen kernel choice")
  } else {
    fail("zen kernel", JSON.stringify(planZen.config.kernels))
  }

  // 4. User with NVIDIA Turing+ chooses linux-zen + installNvidiaOpen
  const answersNvidiaZen: Answers = {
    ...baseAnswers,
    system: {
      kernel: "linux-zen",
      installNvidiaOpen: true,
      detectedGpus: [{ raw: "", vendor: "nvidia", model: "RTX 3060", chipCode: "GA106", nvidiaOpenSupported: true }],
    },
  }
  const planNvidiaZen = assemblePlan(answersNvidiaZen, mockBase)
  const pkgs = (planNvidiaZen.config.packages ?? []) as string[]
  if (pkgs.includes("nvidia-open-dkms") && pkgs.includes("linux-zen-headers") && pkgs.includes("dkms")) {
    ok("assemblePlan injects nvidia-open-dkms + linux-zen-headers + dkms for linux-zen")
  } else {
    fail("zen nvidia packages", JSON.stringify(pkgs))
  }

  // 5. User with NVIDIA Turing+ chooses linux-lts + installNvidiaOpen
  const answersNvidiaLts: Answers = {
    ...baseAnswers,
    system: {
      kernel: "linux-lts",
      installNvidiaOpen: true,
      detectedGpus: [{ raw: "", vendor: "nvidia", model: "RTX 4070", chipCode: "AD104", nvidiaOpenSupported: true }],
    },
  }
  const planNvidiaLts = assemblePlan(answersNvidiaLts, mockBase)
  const pkgsLts = (planNvidiaLts.config.packages ?? []) as string[]
  if (pkgsLts.includes("nvidia-open-lts") && !pkgsLts.includes("nvidia-open-dkms")) {
    ok("assemblePlan injects nvidia-open-lts for linux-lts")
  } else {
    fail("lts nvidia packages", JSON.stringify(pkgsLts))
  }
}

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)
