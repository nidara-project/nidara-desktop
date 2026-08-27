// Step 8 — Installation execution and live progress output with safety arm guard.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Step } from "../lib/flow"
import { NidaraButton, NidaraScrolled } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { assemblePlan, type AssembledPlan } from "../lib/plan"
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
        css_classes: ["installer-log-view"],
      })

      const { widget: logScrolledWidget, scrolled } = NidaraScrolled({
        child: textView,
        minContentHeight: 180,
        maxContentHeight: 240,
        propagateNaturalHeight: false,
        alwaysVisible: false,
        reserveLane: false,
      })

      const logCard = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        css_classes: ["installer-log-card"],
        hexpand: true,
      })
      logCard.append(logScrolledWidget)

      const expander = new Gtk.Expander({
        label: t("runShowLog"),
        expanded: false,
        css_classes: ["installer-expander"],
        child: logCard,
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
        }
      }

      // Prepare disks, subvolumes, and /mnt mount hierarchy
      function prepareDiskAndMounts(disk: any, arm: boolean) {
        const isRoot = GLib.get_user_name() === "root"
        const sudoPrefix = isRoot ? [] : ["sudo", "-n"]
        const runCmd = (args: string[]) => {
          appendLog(`[PREP] ${args.join(" ")}`)
          const fullCmd = [...sudoPrefix, ...args]
          const proc = Gio.Subprocess.new(fullCmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE)
          proc.wait(null)
          if (!proc.get_successful()) {
            throw new Error(`Command failed: ${fullCmd.join(" ")}`)
          }
        }

        // Unmount anything currently under /mnt
        try {
          const proc = Gio.Subprocess.new([...sudoPrefix, "umount", "-R", "/mnt"], Gio.SubprocessFlags.NONE)
          proc.wait(null)
        } catch {}

        if (disk.mode === "entire_disk") {
          const dPath = disk.disk.path
          const isNvme = dPath.includes("nvme") || dPath.includes("mmcblk")
          const p1 = isNvme ? `${dPath}p1` : `${dPath}1`
          const p2 = isNvme ? `${dPath}p2` : `${dPath}2`

          if (arm) {
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
          } else {
            // Dry-run mode: mount existing partitions if available for schema validation
            try {
              runCmd(["mkdir", "-p", "/mnt"])
              runCmd(["mount", p2, "/mnt"])
              runCmd(["mkdir", "-p", "/mnt/boot"])
              runCmd(["mount", p1, "/mnt/boot"])
            } catch {}
          }
        } else if (disk.mode === "manual") {
          const sorted = [...disk.mounts].sort((a, b) => {
            if (a.mountpoint === "/") return -1
            if (b.mountpoint === "/") return 1
            return a.mountpoint.localeCompare(b.mountpoint)
          })

          if (arm) {
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
        const isArm = GLib.getenv("NIDARA_INSTALLER_ARM") === "1"

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
          appendLog("[INFO] Running in dry-run mode (NIDARA_INSTALLER_ARM is not set).")
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
