// Step 6 — the last page before the point of no return.
//
// It answers two different questions, and it used to answer only the first:
//
//   1. what did you tell us      — five rows, all of them things the person typed
//   2. what did WE decide        — one kernel, open-source graphics only, zram
//                                  swap, systemd-boot, a locked root, and which
//                                  packages this medium actually installs
//
// Deciding (2) on the person's behalf is what makes Nidara a product rather than
// a menu of Arch options. Not SAYING it is what made this page feel thin (#401),
// and it is also the half that carries the consequences: nothing here is
// reversible after the next button.

import Gtk from "gi://Gtk?version=4.0"
import type { Step } from "../lib/flow"
import { NidaraList, NidaraRow } from "../../lib/nidara-kit"
import { t, onLocaleChange } from "../lib/i18n"
import { getAnswers, type ManualPartitionMount } from "../lib/answers"
import { getLiveDefaults } from "../lib/plan"
import { espMount } from "../lib/disk-config"
import { readBaseConfig, basePackages, type BaseConfig } from "../lib/base-config"
import { heading, prose, formatSize } from "./common"

/**
 * What a row will actually be formatted as.
 *
 * ⚠️ Not `m.filesystem` on a swap row. The filesystem dropdown does not offer
 * swap — it cannot, the answer is `mkswap` — so a swap row carries whatever the
 * dropdown happened to hold, and this page would announce that a partition is
 * about to be erased as "btrfs" while archinstall makes it swap.
 */
function targetFs(m: ManualPartitionMount): string {
  return m.mountpoint === "swap" ? "swap" : m.filesystem
}

/**
 * What this install is about to destroy, named, in the words the disk page used.
 *
 * ⚠️ One function, two readers: the loudest line on this page (#401, D-25) and
 * the body of the confirmation in front of the install (#436). A modal that
 * names something other than the page behind it is worse than no modal — it is a
 * second description of an irreversible act, and the person is left deciding
 * which of the two to believe.
 *
 * Only when something really is destroyed: a manual layout that formats nothing
 * destroys nothing, and claiming otherwise is how a warning becomes the kind
 * people learn to click through.
 */
export function eraseSentence(): string {
  const disk = getAnswers().disk
  if (disk?.mode === "entire_disk") {
    const d = disk.disk
    return t("summaryEraseDiskPrefix")
      + `${d.model || d.name} · ${formatSize(d.size)} · ${d.path}`
  }
  if (disk?.mode === "manual") {
    const formatted = disk.mounts.filter(m => m.format)
    if (formatted.length > 0) {
      return t("summaryErasePartsPrefix") + "\n"
        + formatted
          .map(m => `${m.path}  ·  ${formatSize(m.size)}  ·  ${m.mountpoint}  ·  ${targetFs(m)}`)
          .join("\n")
    }
  }
  return t("summaryWarning")
}

/** `config.a.b` without throwing on a config that does not have an `a`. */
function pick(config: BaseConfig, path: string[]): unknown {
  let node: any = config
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined
    node = node[key]
  }
  return node
}

export function SummaryStep(): Step {
  // Read once, at construction: it is a file on the medium, and the page is
  // rebuilt on every language change.
  const base = readBaseConfig()

  return {
    id: "summary",
    title: () => t("summaryTitle"),
    nextLabel: () => t("installNow"),
    ready: () => {
      const answers = getAnswers()
      return answers.disk !== null && answers.account !== null
    },

    /**
     * The point of no return, and the only place in the flow that has one.
     *
     * ⚠️ Before this, the footer button on the last reversible screen was the
     * seventh Continue in the same position as the six before it, and it started
     * `archinstall` (#436). Closing the window asked — #405 wired `onClose` to
     * `showNidaraAlert` so a stray click could not throw away a typed password —
     * and erasing the disk did not. Every reference draws the line here:
     * subiquity's "Confirm destructive action", Calamares' blocking QMessageBox,
     * Anaconda's Summary of Changes.
     *
     * The frame shows it, because the frame already owns the other alert. What
     * this step supplies is the words — the same sentence the page prints at the
     * top, from the same function.
     */
    confirmNext: () => ({
      heading: t("confirmInstallHeading"),
      body: `${eraseSentence()}\n\n${t("confirmInstallBody")}`,
      cancelLabel: t("confirmInstallCancel"),
      confirmLabel: t("installNow"),
    }),

    build() {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      const headLabel = heading(t("summaryHeading"))
      // ⚠️ THE loudest thing on the page, and it names the disk (D-25). It used
      // to be a generic "back up important data" line while the disk about to be
      // erased sat in a row below, styled exactly like the timezone. The single
      // most consequential fact on the last reversible screen is not one field
      // among five.
      const eraseLabel = prose("", "installer-prose--warning")
      eraseLabel.add_css_class("installer-erase")
      box.append(headLabel)
      box.append(eraseLabel)

      const chosen = NidaraList(t("summaryChosen"))
      const decided = NidaraList(t("summaryDecided"))
      box.append(chosen.box)
      box.append(decided.box)

      const clear = (listBox: Gtk.ListBox) => {
        let child = listBox.get_first_child()
        while (child) {
          const next = child.get_next_sibling()
          listBox.remove(child)
          child = next
        }
      }

      const refresh = () => {
        headLabel.label = t("summaryHeading")
        if (chosen.titleLabel) chosen.titleLabel.label = t("summaryChosen").toUpperCase()
        if (decided.titleLabel) decided.titleLabel.label = t("summaryDecided").toUpperCase()

        clear(chosen.listBox)
        clear(decided.listBox)

        const answers = getAnswers()
        const disk = answers.disk
        const account = answers.account
        const live = getLiveDefaults()

        // ── What is about to be destroyed ────────────────────────────────────
        eraseLabel.label = eraseSentence()

        // ── What the person answered ─────────────────────────────────────────
        if (disk) {
          chosen.listBox.append(NidaraRow(
            t("summaryDiskMode"),
            disk.mode === "entire_disk" ? t("diskModeEntire") : t("diskModeManual"),
          ))

          if (disk.mode === "entire_disk") {
            const d = disk.disk
            chosen.listBox.append(NidaraRow(
              t("summaryDisk"),
              `${d.model || d.name} · ${formatSize(d.size)} · ${d.path}${d.rm ? ` · ${t("diskRemovable")}` : ""}`,
            ))
            chosen.listBox.append(NidaraRow(t("summaryFilesystem"), disk.filesystem))
          } else {
            // ⚠️ ONE LINE PER MOUNT, not a comma-joined sentence (D-26). This is
            // the last screen before a disk is written, and what a reader has to
            // do here is check a list against what they meant — which a paragraph
            // of "/dev/sda1 → /boot (vfat [Format]), …" does not let them do. The
            // row's subtitle wraps and both row heights are floors, so it grows.
            //
            // No `toLowerCase()` anywhere near a translated string: German
            // capitalises its nouns, so "Formatieren" lowercased is a misspelling.
            const breakdown = disk.mounts
              .map(m => `${m.mountpoint}  ·  ${m.path}  ·  ${formatSize(m.size)}  ·  ${m.format ? `${targetFs(m)} · ${t("diskFormat")}` : t("diskKeep")}`)
              .join("\n")
            chosen.listBox.append(NidaraRow(t("summaryPartitionLayout"), breakdown))
          }
        }

        // The country decides the time, the formats, the keyboard and where we
        // will look for packages, and it was the one answer the page did not
        // repeat back (D-23). The three things derived from it are the rows
        // under it, so it belongs above them.
        if (answers.country) {
          chosen.listBox.append(NidaraRow(
            t("summaryCountry"),
            `${answers.country.name} · ${answers.country.code}`,
          ))
        }

        if (account) {
          const userAtHost = account.hostname ? `${account.username}@${account.hostname}` : account.username
          chosen.listBox.append(NidaraRow(
            t("summaryAccount"),
            `${account.fullName} (${userAtHost}) · sudo`,
          ))
        }

        const chosenLang = answers.language?.label ?? `${live.localeConfig.sys_lang}.${live.localeConfig.sys_enc}`
        chosen.listBox.append(NidaraRow(t("summaryLanguage"), chosenLang))

        const chosenKb = answers.keyboard?.label
          ? `${answers.keyboard.label}${answers.keyboard.variant ? ` (${answers.keyboard.variant})` : ""}`
          : live.localeConfig.kb_layout
        chosen.listBox.append(NidaraRow(t("summaryKeyboard"), chosenKb))

        const chosenTz = answers.timezone?.timezone ?? live.timezone
        chosen.listBox.append(NidaraRow(t("summaryTimezone"), chosenTz))

        // ── What Nidara decided ──────────────────────────────────────────────
        // Read from `base.json` rather than restated here, so that a product
        // decision taken in nidara-iso shows up on this page without anybody
        // remembering to come back — which is the same reason base.json is a file
        // on the medium and not constants in this repo (see lib/base-config.ts).
        const config = base?.config
        if (config) {
          // `basePackages()` was written, exported, and had zero callers (#401).
          // This is the only code we have that can answer "what are you about to
          // install?", and the answer lives in `custom_commands` because the
          // repo's own packages need the signing key in the TARGET keyring.
          const packages = basePackages(config)
          if (packages.length > 0) {
            decided.listBox.append(NidaraRow(t("summaryPackages"), packages.join(" · ")))
          }

          const kernels = pick(config, ["kernels"])
          if (Array.isArray(kernels) && kernels.length > 0) {
            decided.listBox.append(NidaraRow(t("summaryKernel"), (kernels as string[]).join(" · ")))
          }

          const gfx = pick(config, ["profile_config", "gfx_driver"])
          if (typeof gfx === "string" && gfx.length > 0) {
            // The archinstall enum is the value we act on; the sentence is what
            // it MEANS to somebody with an NVIDIA card in front of them, which is
            // the disclosure the audit asked for. An unknown value is printed raw
            // rather than glossed — a wrong gloss is worse than jargon.
            decided.listBox.append(NidaraRow(
              t("summaryGraphics"),
              gfx === "All open-source" ? t("summaryGraphicsOpen") : gfx,
            ))
          }

          const bootloader = pick(config, ["bootloader_config", "bootloader"])
          if (typeof bootloader === "string" && bootloader.length > 0) {
            // …and WHERE it goes (D-24). Entire-disk mode creates the ESP — the
            // 512 MiB partition that lib/disk-config.ts asks archinstall for, and
            // that steps/run.ts used to cut with `sgdisk`; manual mode
            // uses whichever of the three EFI mount points was assigned, and
            // naming the partition is the only way the person can check that the
            // installer picked the one they meant.
            let where = ""
            if (disk?.mode === "entire_disk") {
              where = t("summaryEfiNew")
            } else if (disk?.mode === "manual") {
              // The same `espMount` the disk page validates with and the layout
              // flags with — a fourth spelling of "which one is the ESP" is a
              // fourth chance for this page to name a different partition than the
              // one the bootloader lands on.
              const esp = espMount(disk.mounts)
              if (esp) where = `${esp.mountpoint} · ${esp.path}`
            }
            decided.listBox.append(NidaraRow(
              t("summaryBootloader"),
              where ? `${bootloader} · ${where}` : bootloader,
            ))
          }

          const swapOn = pick(config, ["swap", "enabled"]) === true
          const swapAlgo = pick(config, ["swap", "algorithm"])
          decided.listBox.append(NidaraRow(
            t("summarySwap"),
            swapOn ? `zram · ${typeof swapAlgo === "string" ? swapAlgo : "zstd"}` : t("diskMountNone"),
          ))

          // Not from base.json: archinstall only touches root when the plan
          // carries `root_enc_password`, and `assemblePlan` deliberately omits it
          // so the account keeps the `*` that `filesystem` ships. That decision
          // was invisible to the person it is made for.
          decided.listBox.append(NidaraRow(t("summaryRoot"), t("summaryRootLocked")))

          // The biggest speed lever we do not pull yet (#311). Said plainly
          // rather than left blank: "no region chosen" is itself the decision,
          // and when #311 lands the regions appear here with no change to this.
          const regions = pick(config, ["mirror_config", "mirror_regions"])
          const named = regions && typeof regions === "object" ? Object.keys(regions) : []
          decided.listBox.append(NidaraRow(
            t("summaryMirrors"),
            named.length > 0 ? named.join(" · ") : t("summaryMirrorsMedium"),
          ))
        }
      }

      refresh()
      box.connect("map", refresh)
      onLocaleChange(refresh)

      return box
    },
  }
}
