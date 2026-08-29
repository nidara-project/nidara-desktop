// Step 8 — Installation execution and live progress output with safety arm guard.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Step } from "../lib/flow"
import { NidaraButton, NidaraScrolled } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { assemblePlan, type AssembledPlan } from "../lib/plan"
import { configureInstalledBootloader } from "../lib/bootloader"
import { heading, prose } from "./common"

export function RunStep(): Step {
  let _busy = false
  let _proc: Gio.Subprocess | null = null

  return {
    id: "run",
    title: () => t("runTitle"),
    nextLabel: () => t("continue"),
    busy: () => _busy,
    ready: () => false,

    build() {
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

      const progressBar = new Gtk.ProgressBar({
        hexpand: true,
        valign: Gtk.Align.CENTER,
      })
      box.append(progressBar)

      const pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
        if (!_busy) return GLib.SOURCE_REMOVE
        progressBar.pulse()
        return GLib.SOURCE_CONTINUE
      })

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

      const appendLog = (line: string) => {
        const endIter = textBuffer.get_end_iter()
        textBuffer.insert(endIter, line + "\n", -1)
        const adj = scrolled.vadjustment
        if (adj) adj.value = adj.upper - adj.page_size
      }

      const finishRun = (success: boolean) => {
        _busy = false
        progressBar.visible = false
        if (progressBar.get_parent()) {
          box.remove(progressBar)
        }

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
        _busy = true
        const answers = getAnswers()
        const isLiveEnvironment = GLib.file_test("/run/archiso", GLib.FileTest.EXISTS)
        const isExplicitArm = GLib.getenv("NIDARA_INSTALLER_ARM") === "1"
        const isExplicitDryRun = GLib.getenv("NIDARA_INSTALLER_DRY_RUN") === "1"
        const isArm = (isLiveEnvironment || isExplicitArm) && !isExplicitDryRun

        if (answers.disk) {
          try {
            prepareDiskAndMounts(answers.disk, isArm)
          } catch (e: any) {
            appendLog(`[ERROR] Failed to prepare disk partitions/mounts: ${e.message || e}`)
            finishRun(false)
            return GLib.SOURCE_REMOVE
          }
        }

        let plan: AssembledPlan
        try {
          plan = assemblePlan(answers)
        } catch (e: any) {
          appendLog(`[ERROR] Failed to assemble installation plan: ${e.message || e}`)
          finishRun(false)
          return GLib.SOURCE_REMOVE
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
          return GLib.SOURCE_REMOVE
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
          appendLog("[INFO] Running in dry-run mode (live medium or NIDARA_INSTALLER_ARM is not active).")
        } else {
          appendLog("[INFO] Running in live installation mode.")
        }

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

        return GLib.SOURCE_REMOVE
      })

      return box
    },
  }
}
