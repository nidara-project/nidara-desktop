// Step 8 — Installation execution and live progress output with safety arm guard.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Step } from "../lib/flow"
import { NidaraButton } from "../../lib/nidara-kit"
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

      const spinner = new Gtk.Spinner({
        spinning: true,
        width_request: 32,
        height_request: 32,
        halign: Gtk.Align.CENTER,
      })
      box.append(spinner)

      const textBuffer = new Gtk.TextBuffer()
      const textView = new Gtk.TextView({
        buffer: textBuffer,
        editable: false,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.CHAR,
        monospace: true,
        css_classes: ["installer-log-view"],
      })

      const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        min_content_height: 180,
        max_content_height: 240,
        child: textView,
      })

      const expander = new Gtk.Expander({
        label: t("runShowLog"),
        expanded: false,
        child: scrolled,
      })
      box.append(expander)

      const actionBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        halign: Gtk.Align.END,
        visible: false,
      })

      const restartBtn = NidaraButton({ label: t("runRestart"), variant: "primary" })
      const closeBtn = NidaraButton({ label: t("runClose"), variant: "secondary" })

      restartBtn.connect("clicked", () => {
        try {
          Gio.Subprocess.new(["systemctl", "reboot"], Gio.SubprocessFlags.NONE)
        } catch {}
      })

      closeBtn.connect("clicked", () => {
        const root = box.get_root() as Gtk.Window | null
        root?.close()
      })

      actionBox.append(closeBtn)
      actionBox.append(restartBtn)
      box.append(actionBox)

      const appendLog = (line: string) => {
        const endIter = textBuffer.get_end_iter()
        textBuffer.insert(endIter, line + "\n", -1)
        const adj = scrolled.vadjustment
        if (adj) adj.value = adj.upper - adj.page_size
      }

      const finishRun = (success: boolean) => {
        _busy = false
        spinner.spinning = false
        spinner.visible = false

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

        actionBox.visible = true
      }

      // Execute archinstall
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        _busy = true
        let plan: AssembledPlan
        try {
          plan = assemblePlan(getAnswers())
        } catch (e: any) {
          appendLog(`[ERROR] Failed to assemble installation plan: ${e.message || e}`)
          finishRun(false)
          return GLib.SOURCE_REMOVE
        }

        const isArm = GLib.getenv("NIDARA_INSTALLER_ARM") === "1"
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

        const cmd = [
          "pkexec",
          "archinstall",
          "--config", configPath,
          "--creds", credsPath,
          "--silent",
        ]

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
              success = (_proc?.get_successful() ?? false) || !isArm
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
