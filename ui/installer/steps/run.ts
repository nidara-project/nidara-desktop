// Step 8 — Installation execution and live progress output with safety arm guard.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import Gio from "gi://Gio"
import type { Step } from "../lib/flow"
import { NidaraButton, NidaraScrolled } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { assemblePlan, type AssembledPlan } from "../lib/plan"
import { configureInstalledBootloader } from "../lib/bootloader"
import { applyRealName } from "../lib/real-name"
import { stripAnsi } from "../lib/ansi"
import { connectivity, isUsable } from "../lib/network"
import { isPreview, previewSkip } from "../lib/preview"
import { heading, prose } from "./common"

export function RunStep(): Step {
  let _busy = false
  let _proc: Gio.Subprocess | null = null
  /**
   * Handed in at build time, and the reason the footer is honest.
   *
   * ⚠️ `Step.busy` documents that a step reporting busy MUST call this when the
   * answer changes — and this step never took the callback at all. `sync()` runs
   * on entering the step, when `_busy` is still false, so it showed Close and a
   * primary, highlighted "Restart now"; `_busy` flipping to true a moment later
   * notified nobody. Both stayed lit for the whole install, over a partition
   * table that had already been written (measured on the 09-02 ISO, #391), and
   * they happened to be correct again at the end, which is what hid it.
   */
  let _notify: (() => void) | undefined

  const setBusy = (v: boolean) => { _busy = v; _notify?.() }

  return {
    id: "run",
    title: () => t("runTitle"),
    nextLabel: () => t("continue"),
    busy: () => _busy,
    ready: () => false,

    build(notifyReady) {
      _notify = notifyReady
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
        vexpand: true,
      })

      const head = heading(t("runHeading"))
      const desc = prose(t("runTitle"), "installer-prose--dim")
      box.append(head)
      box.append(desc)

      // ── Named phases, and the last line the work actually printed ──────────
      //
      // ⚠️ What was here was `GLib.timeout_add(80ms, () => progressBar.pulse())`:
      // a bar that swept back and forth for twenty minutes and told nobody
      // anything, with the real log folded shut behind a collapsed expander
      // (#307). A pulse says "something is happening"; over a disk being erased
      // that is not the question anyone has.
      //
      // The four phases are the ones this file actually has boundaries for. Inside
      // archinstall there is no progress to read — so what is shown there is its
      // LAST LINE, which is the honest answer to "what is it doing now".
      const PHASES = ["runPhaseNetwork", "runPhaseDisk", "runPhaseBase", "runPhaseConfig"] as const
      let phase = -1

      const progressBar = new Gtk.ProgressBar({ hexpand: true, valign: Gtk.Align.CENTER })
      box.append(progressBar)

      const phaseRows: { row: Gtk.Box; marker: Gtk.Label; title: Gtk.Label }[] = []
      const phaseBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true })
      for (const key of PHASES) {
        const marker = new Gtk.Label({ label: "○", css_classes: ["installer-phase-marker"] })
        const title = new Gtk.Label({
          label: t(key), css_classes: ["installer-phase-title"],
          halign: Gtk.Align.FILL, hexpand: true, xalign: 0,
        })
        const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10, hexpand: true })
        row.append(marker); row.append(title)
        phaseBox.append(row)
        phaseRows.push({ row, marker, title })
      }
      box.append(phaseBox)

      // The child's last line, under the phases. Ellipsised rather than wrapped:
      // this is a single moving line, and a wrapping one would move the buttons.
      const detail = new Gtk.Label({
        label: "", css_classes: ["installer-phase-detail"],
        halign: Gtk.Align.FILL, hexpand: true, xalign: 0,
        ellipsize: Pango.EllipsizeMode.END, single_line_mode: true,
      })
      box.append(detail)

      const paintPhases = () => {
        phaseRows.forEach((r, i) => {
          const done = i < phase
          r.marker.label = done ? "✓" : i === phase ? "●" : "○"
          r.row[i === phase ? "add_css_class" : "remove_css_class"]("is-active")
          r.row[done ? "add_css_class" : "remove_css_class"]("is-done")
        })
        progressBar.fraction = Math.max(0, phase) / PHASES.length
      }

      const enterPhase = (i: number) => { phase = i; detail.label = ""; paintPhases() }
      paintPhases()

      const textBuffer = new Gtk.TextBuffer()
      const textView = new Gtk.TextView({
        buffer: textBuffer,
        editable: false,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.CHAR,
        monospace: true,
        hexpand: true,
        vexpand: true,
        css_classes: ["installer-log-view"],
      })

      const { widget: logScrolledWidget, scrolled } = NidaraScrolled({
        child: textView,
        minContentHeight: 220,
        propagateNaturalHeight: false,
        alwaysVisible: false,
        reserveLane: false,
      })
      scrolled.vexpand = true
      scrolled.hexpand = true
      logScrolledWidget.vexpand = true
      logScrolledWidget.hexpand = true

      const logCard = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["installer-log-card"],
        hexpand: true,
        vexpand: true,
      })
      logCard.append(logScrolledWidget)

      const expander = new Gtk.Expander({
        label: t("runShowLog"),
        expanded: false,
        css_classes: ["installer-expander"],
        child: logCard,
        vexpand: true,
        hexpand: true,
      })
      box.append(expander)
      // "Show log" while it is shut, "Hide log" while it is open. It used to say
      // Show in both states (D-27).
      expander.connect("notify::expanded", () => {
        expander.label = expander.expanded ? t("runHideLog") : t("runShowLog")
      })

      // One funnel for every line, ours and the child's alike. The child's arrive
      // TTY-shaped and have to be undressed (lib/ansi.ts); ours never carry an
      // escape, so the call costs them nothing — and being HERE rather than at
      // the pipe means a caller added later cannot forget it. A line that was
      // something and is now nothing was pure terminal control: printing a blank
      // row for it is how the log came out padded with gaps.
      const appendLog = (raw: string) => {
        const line = stripAnsi(raw)
        if (line === "" && raw !== "") return
        const endIter = textBuffer.get_end_iter()
        textBuffer.insert(endIter, line + "\n", -1)
        // The same line the log gets, under the phase — so the page says what it
        // is doing without anybody having to open the expander to find out.
        if (line.trim()) detail.label = line.trim()
        const adj = scrolled.vadjustment
        if (adj) adj.value = adj.upper - adj.page_size
      }

      const finishRun = (success: boolean) => {
        setBusy(false)
        if (success) { phase = PHASES.length; paintPhases() }
        progressBar.visible = false
        detail.visible = false

        if (success) {
          head.label = t("runSuccessHeading")
          desc.label = t("runSuccessProse")
          desc.remove_css_class("installer-prose--warning")
          desc.add_css_class("installer-prose--dim")
        } else {
          head.label = t("runFailedHeading")
          desc.label = t("runFailedProse")
          desc.remove_css_class("installer-prose--dim")
          desc.add_css_class("installer-prose--warning")
          expander.expanded = true
        }
      }

      // Prepare disks, subvolumes, and /mnt mount hierarchy.
      //
      // ⚠️ The `arm` gate lives in `runCmd`, deliberately, and NOT in the branches that
      // call it. It used to guard only the destructive half (sgdisk/mkfs), which left three
      // things running during what the UI was calling a dry run: the `umount -R /mnt` at the
      // top, an explicit else-branch that mounted the chosen disk's real partitions "for
      // schema validation", and the whole manual-mode mount loop, which was never inside a
      // guard at all. None of that destroys data, and all of it mutates the machine of
      // whoever is developing the installer — silently, because two of the three were wrapped
      // in a bare `catch {}`. A dry run describes what it would do; it touches nothing. With
      // the gate here, a branch added later cannot escape it by forgetting to ask.
      function prepareDiskAndMounts(disk: any, arm: boolean) {
        const isRoot = GLib.get_user_name() === "root"
        const sudoPrefix = isRoot ? [] : ["sudo", "-n"]
        // `optional` = a command whose failure is a normal outcome, not an error (nothing was
        // mounted under /mnt). It still gets logged, so the log shows the real sequence.
        const runCmd = (args: string[], opts: { optional?: boolean } = {}) => {
          if (!arm) {
            appendLog(`[PREP] (dry-run, not executed) ${args.join(" ")}`)
            return
          }
          appendLog(`[PREP] ${args.join(" ")}`)
          const fullCmd = [...sudoPrefix, ...args]
          const proc = Gio.Subprocess.new(fullCmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE)
          proc.wait(null)
          if (!proc.get_successful() && !opts.optional) {
            throw new Error(`Command failed: ${fullCmd.join(" ")}`)
          }
        }

        // Unmount anything currently under /mnt
        try {
          runCmd(["umount", "-R", "/mnt"], { optional: true })
        } catch {}

        if (disk.mode === "entire_disk") {
          const dPath = disk.disk.path
          const isNvme = dPath.includes("nvme") || dPath.includes("mmcblk")
          const p1 = isNvme ? `${dPath}p1` : `${dPath}1`
          const p2 = isNvme ? `${dPath}p2` : `${dPath}2`

          appendLog(`[PREP] Partitioning entire disk ${dPath}...`)
          runCmd(["sgdisk", "--zap-all", dPath])
          runCmd(["sgdisk", "-n", "1:1M:+512M", "-t", "1:ef00", dPath])
          runCmd(["sgdisk", "-n", "2:0:0", "-t", "2:8300", dPath])
          runCmd(["partprobe", dPath])

          appendLog(`[PREP] Formatting EFI partition ${p1}...`)
          runCmd(["mkfs.vfat", "-F32", p1])

          if (disk.filesystem === "btrfs") {
            appendLog(`[PREP] Formatting Btrfs root on ${p2}...`)
            runCmd(["mkfs.btrfs", "-f", p2])
            runCmd(["mkdir", "-p", "/mnt"])
            runCmd(["mount", p2, "/mnt"])
            runCmd(["btrfs", "subvolume", "create", "/mnt/@"])
            runCmd(["btrfs", "subvolume", "create", "/mnt/@home"])
            runCmd(["btrfs", "subvolume", "create", "/mnt/@log"])
            runCmd(["btrfs", "subvolume", "create", "/mnt/@pkg"])
            runCmd(["btrfs", "subvolume", "create", "/mnt/@snapshots"])
            runCmd(["umount", "/mnt"])

            runCmd(["mount", "-o", "compress=zstd,subvol=@", p2, "/mnt"])
            runCmd(["mkdir", "-p", "/mnt/home", "/mnt/var/log", "/mnt/var/cache/pacman/pkg", "/mnt/.snapshots", "/mnt/boot"])
            runCmd(["mount", "-o", "compress=zstd,subvol=@home", p2, "/mnt/home"])
            runCmd(["mount", "-o", "compress=zstd,subvol=@log", p2, "/mnt/var/log"])
            runCmd(["mount", "-o", "compress=zstd,subvol=@pkg", p2, "/mnt/var/cache/pacman/pkg"])
            runCmd(["mount", "-o", "compress=zstd,subvol=@snapshots", p2, "/mnt/.snapshots"])
            runCmd(["mount", p1, "/mnt/boot"])
          } else {
            appendLog(`[PREP] Formatting Ext4 root on ${p2}...`)
            runCmd(["mkfs.ext4", "-F", p2])
            runCmd(["mkdir", "-p", "/mnt"])
            runCmd(["mount", p2, "/mnt"])
            runCmd(["mkdir", "-p", "/mnt/boot"])
            runCmd(["mount", p1, "/mnt/boot"])
          }
        } else if (disk.mode === "manual") {
          const sorted = [...disk.mounts].sort((a, b) => {
            if (a.mountpoint === "/") return -1
            if (b.mountpoint === "/") return 1
            return a.mountpoint.localeCompare(b.mountpoint)
          })

          for (const m of sorted) {
            if (m.format) {
              appendLog(`[PREP] Formatting ${m.path} as ${m.filesystem}...`)
              if (m.filesystem === "btrfs") {
                runCmd(["mkfs.btrfs", "-f", m.path])
              } else if (m.filesystem === "vfat") {
                runCmd(["mkfs.vfat", "-F32", m.path])
              } else if (m.filesystem === "xfs") {
                runCmd(["mkfs.xfs", "-f", m.path])
              } else if (m.filesystem === "f2fs") {
                runCmd(["mkfs.f2fs", "-f", m.path])
              } else {
                runCmd(["mkfs.ext4", "-F", m.path])
              }
            }
          }

          for (const m of sorted) {
            const target = m.mountpoint === "/" ? "/mnt" : `/mnt${m.mountpoint.startsWith("/") ? m.mountpoint : `/${m.mountpoint}`}`
            runCmd(["mkdir", "-p", target])
            runCmd(["mount", m.path, target])
          }
        }
      }

      // Execute archinstall
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        setBusy(true)
        enterPhase(0)
        const answers = getAnswers()

        // ⚠️ Checked HERE, before prepareDiskAndMounts, and not one line later.
        // Everything below this point needs the network — pacstrap, the curl that
        // fetches the repo signing key, the `pacman -Sy` of the three Nidara
        // packages — and the first thing below it erases a partition table. Failing
        // after that leaves a machine with no operating system at all, which is
        // strictly worse than the one it had five minutes ago.
        connectivity().then(c => {
          if (!isUsable(c)) {
            appendLog(`[ERROR] ${t("runErrNoNetwork")}`)
            finishRun(false)
            return
          }
          startInstall(answers)
        })

        return GLib.SOURCE_REMOVE
      })

      function startInstall(answers: ReturnType<typeof getAnswers>) {
        // Two modes, and WHERE it runs picks one: the live medium installs for real, anything
        // else is a dry run. There is deliberately no variable that arms it elsewhere — the
        // dangerous direction is unreachable, not merely discouraged. `NIDARA_INSTALLER_DRY_RUN`
        // only ever points the safe way, so the worst a typo in it can do is refuse to install.
        const isLiveMedium = GLib.file_test("/run/archiso", GLib.FileTest.EXISTS)
        const isForcedDryRun = GLib.getenv("NIDARA_INSTALLER_DRY_RUN") === "1"
        const isArm = isLiveMedium && !isForcedDryRun

        if (answers.disk) {
          enterPhase(1)
          try {
            prepareDiskAndMounts(answers.disk, isArm)
          } catch (e: any) {
            appendLog(`[ERROR] Failed to prepare disk partitions/mounts: ${e.message || e}`)
            finishRun(false)
            return
          }
        }

        let plan: AssembledPlan
        try {
          plan = assemblePlan(answers)
        } catch (e: any) {
          appendLog(`[ERROR] Failed to assemble installation plan: ${e.message || e}`)
          finishRun(false)
          return
        }

        // ⚠️ Preview stops HERE, before the credentials file exists.
        //
        // Not for the sake of archinstall — it would get `--dry-run` anyway — but
        // for the two lines below it: the plan and the CREDENTIALS are written to
        // /tmp, and the creds file holds the account password hash. It is mode
        // 0600 and it is deleted afterwards, which is right on a medium that is
        // about to be powered off and wrong on a shared machine that will not be.
        // The password is also the one thing somebody walking the installer for
        // the tenth time is most likely to have typed carelessly.
        if (isPreview()) {
          appendLog(previewSkip("writing the plan and credentials to /tmp"))
          appendLog(previewSkip("sudo archinstall --config … --creds … --silent --dry-run"))
          appendLog(previewSkip("applyRealName + configureInstalledBootloader (already gated on arm)"))
          appendLog("")
          appendLog("[PREVIEW] The plan that WOULD be handed to archinstall:")
          for (const line of JSON.stringify(plan.config, null, 2).split("\n")) appendLog(line)
          enterPhase(3)
          finishRun(true)
          return
        }

        const configPath = `/tmp/nidara-plan-${GLib.random_int()}.json`
        const credsPath = `/tmp/nidara-creds-${GLib.random_int()}.json`

        try {
          GLib.file_set_contents(configPath, JSON.stringify(plan.config, null, 2) + "\n")
          // Secure mode 0600 for creds
          const file = Gio.File.new_for_path(credsPath)
          const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
          const data = new TextEncoder().encode(JSON.stringify(plan.creds, null, 2) + "\n")
          stream.write_all(data, null)
          stream.close(null)
        } catch (e: any) {
          appendLog(`[ERROR] Failed to write temporary config files: ${e.message || e}`)
          finishRun(false)
          return
        }

        const cleanup = () => {
          try { Gio.File.new_for_path(configPath).delete(null) } catch {}
          try { Gio.File.new_for_path(credsPath).delete(null) } catch {}
        }

        const isRoot = GLib.get_user_name() === "root"
        const cmd = isRoot
          ? ["archinstall", "--config", configPath, "--creds", credsPath, "--silent"]
          : ["sudo", "-n", "archinstall", "--config", configPath, "--creds", credsPath, "--silent"]

        if (!isArm) {
          cmd.push("--dry-run")
          appendLog(
            isLiveMedium
              ? "[INFO] Dry-run mode: NIDARA_INSTALLER_DRY_RUN=1 is set. Nothing on disk will be touched."
              : "[INFO] Dry-run mode: this is not an installation medium (no /run/archiso). Nothing on disk will be touched.",
          )
        } else {
          appendLog("[INFO] Running in live installation mode.")
        }

        enterPhase(2)
        appendLog(`[EXEC] ${cmd.join(" ")}`)

        try {
          _proc = Gio.Subprocess.new(
            cmd,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
          )

          const stdoutPipe = _proc.get_stdout_pipe()
          if (stdoutPipe) {
            const dataStream = Gio.DataInputStream.new(stdoutPipe)
            const readLineAsync = () => {
              dataStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_src, res) => {
                try {
                  const [line] = dataStream.read_line_finish_utf8(res)
                  if (line !== null) {
                    appendLog(line)
                    readLineAsync()
                  }
                } catch {}
              })
            }
            readLineAsync()
          }

          _proc.wait_async(null, (_procSrc, res) => {
            let success = false
            try {
              _proc?.wait_finish(res)
              success = _proc?.get_successful() ?? false
              if (success) {
                enterPhase(3)
                applyRealName(isArm, answers, appendLog)
                configureInstalledBootloader(isArm, answers, appendLog)
              }
            } catch (e: any) {
              appendLog(`[ERROR] Process exited with error: ${e.message || e}`)
            } finally {
              cleanup()
              finishRun(success)
            }
          })
        } catch (e: any) {
          cleanup()
          appendLog(`[ERROR] Failed to spawn installer process: ${e.message || e}`)
          finishRun(false)
        }

      }

      return box
    },
  }
}
