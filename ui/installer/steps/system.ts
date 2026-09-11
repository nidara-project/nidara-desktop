// Step — System configuration: Kernel selection and hardware drivers (#311, #495).
//
// 1. Kernel selection:
//    - linux (Standard Arch Linux kernel, default)
//    - linux-lts (Long-Term Support)
//    - linux-zen (Performance/desktop tuned)
//
// 2. Hardware graphics drivers:
//    - Autodetects GPUs via lspci
//    - Turing+ NVIDIA GPUs: toggle to install open-source NVIDIA module (nvidia-open / nvidia-open-lts / nvidia-open-dkms)
//    - Legacy NVIDIA GPUs: notice that Nouveau is provided by official Arch repos
//    - AMD / Intel: notice that integrated Mesa drivers are used

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import type { Step } from "../lib/flow"
import {
  NidaraList,
  NidaraRow,
  NidaraToggleRow,
  NidaraSelectionCheck,
} from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers, setSystemAnswer } from "../lib/answers"
import {
  detectGpus,
  getNvidiaDriverPackages,
  type KernelOption,
  type DetectedGpu,
} from "../lib/graphics"
import { heading, prose } from "./common"

let draft = {
  kernel: "linux" as KernelOption,
  installNvidiaOpen: false,
  gpus: null as DetectedGpu[] | null,
}

export function SystemStep(): Step {
  return {
    id: "system",
    title: () => t("systemTitle"),
    nextLabel: () => t("continue"),
    ready: () => getAnswers().system !== null,

    build(notifyReady) {
      const rootBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      rootBox.append(heading(t("systemHeading")))
      rootBox.append(prose(t("systemIntro"), "installer-prose--dim"))

      // Restore from answers if present
      const existingAnswer = getAnswers().system
      if (existingAnswer) {
        draft.kernel = existingAnswer.kernel
        draft.installNvidiaOpen = existingAnswer.installNvidiaOpen
        draft.gpus = existingAnswer.detectedGpus
      }

      const syncAnswer = () => {
        setSystemAnswer({
          kernel: draft.kernel,
          installNvidiaOpen: draft.installNvidiaOpen,
          detectedGpus: draft.gpus || [],
        })
        notifyReady()
      }

      // ── Hardware Graphics Drivers ─────────────────────────────────────────
      const { box: gfxContainer, listBox: gfxListBox } = NidaraList(
        t("systemGraphicsSection"),
        [],
        "",
      )

      function renderGpuSection() {
        // Clear previous rows from gfxListBox
        let child = gfxListBox.get_first_child()
        while (child) {
          const next = child.get_next_sibling()
          gfxListBox.remove(child)
          child = next
        }

        const gpus = draft.gpus || []
        if (gpus.length > 0) {
          for (const gpu of gpus) {
            const subtitle = gpu.vendor.toUpperCase() + (gpu.chipCode ? ` · ${gpu.chipCode}` : "")
            gfxListBox.append(NidaraRow(gpu.model, subtitle, null))
          }
        }

        const turingGpu = gpus.find(g => g.vendor === "nvidia" && g.nvidiaOpenSupported)
        const legacyNvidiaGpu = gpus.find(g => g.vendor === "nvidia" && !g.nvidiaOpenSupported)

        if (turingGpu) {
          const pkgs = getNvidiaDriverPackages(draft.kernel).join(", ")
          const desc = GLib.strdup_printf(t("systemNvidiaOpenDesc"), pkgs)
          const toggleRow = NidaraToggleRow(
            t("systemNvidiaOpenTitle"),
            desc,
            draft.installNvidiaOpen,
            (active) => {
              draft.installNvidiaOpen = active
              syncAnswer()
            },
          )
          gfxListBox.append(toggleRow)
        } else if (legacyNvidiaGpu) {
          gfxListBox.append(NidaraRow(
            t("systemGpuDetected"),
            t("systemNvidiaLegacyNotice"),
            null,
          ))
        } else {
          gfxListBox.append(NidaraRow(
            t("systemGpuDetected"),
            t("systemGpuMesaNotice"),
            null,
          ))
        }
      }

      // ── Kernel Selection ──────────────────────────────────────────────────
      const { box: kernelContainer, listBox: kernelListBox } = NidaraList(
        t("systemKernelSection"),
        [],
        "",
        { pick: true },
      )
      kernelContainer.set_margin_bottom(4)

      const checkLinux = NidaraSelectionCheck(16)
      const checkLts = NidaraSelectionCheck(16)
      const checkZen = NidaraSelectionCheck(16)

      const rowLinux = NidaraRow(t("kernelLinuxTitle"), t("kernelLinuxDesc"), checkLinux)
      const rowLts = NidaraRow(t("kernelLtsTitle"), t("kernelLtsDesc"), checkLts)
      const rowZen = NidaraRow(t("kernelZenTitle"), t("kernelZenDesc"), checkZen)

      const updateKernelSelection = (selected: KernelOption) => {
        draft.kernel = selected
        rowLinux.remove_css_class("is-selected")
        rowLts.remove_css_class("is-selected")
        rowZen.remove_css_class("is-selected")

        checkLinux.visible = selected === "linux"
        checkLts.visible = selected === "linux-lts"
        checkZen.visible = selected === "linux-zen"

        if (selected === "linux") rowLinux.add_css_class("is-selected")
        else if (selected === "linux-lts") rowLts.add_css_class("is-selected")
        else if (selected === "linux-zen") rowZen.add_css_class("is-selected")

        renderGpuSection()
        syncAnswer()
      }

      kernelListBox.connect("row-activated", (_, row) => {
        if (row === rowLinux) updateKernelSelection("linux")
        else if (row === rowLts) updateKernelSelection("linux-lts")
        else if (row === rowZen) updateKernelSelection("linux-zen")
      })

      kernelListBox.append(rowLinux)
      kernelListBox.append(rowLts)
      kernelListBox.append(rowZen)

      // Initial visual selection
      updateKernelSelection(draft.kernel)

      rootBox.append(kernelContainer)
      rootBox.append(gfxContainer)

      if (draft.gpus === null) {
        detectGpus().then(gpus => {
          draft.gpus = gpus
          const hasTuring = gpus.some(g => g.vendor === "nvidia" && g.nvidiaOpenSupported)
          if (hasTuring && getAnswers().system === null) {
            draft.installNvidiaOpen = true
          }
          renderGpuSection()
          syncAnswer()
        })
      } else {
        renderGpuSection()
        syncAnswer()
      }

      return rootBox
    },
  }
}
