// Step 5 — Execution and live installation progress.
//
// Drives archinstall securely:
// - Writes /tmp/nidara-plan.json and /tmp/nidara-creds.json (mode 0600).
// - Generates disk partition layout dynamically with archinstall library if available.
// - Spawns pkexec archinstall, streams output line-by-line into the log view.
// - Cleans up credentials from /tmp immediately on completion (success or error).
// - Presents reboot button on success or error details on failure.

import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import type { Step } from "../lib/flow"
import { NidaraButton } from "../../lib/nidara-kit"
import { execAsync } from "../../lib/process"
import { t } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { assemblePlan } from "../lib/plan"

const PLAN_PATH = "/tmp/nidara-plan.json"
const CREDS_PATH = "/tmp/nidara-creds.json"

function heading(text: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: ["installer-heading"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
  })
}

function prose(text: string, extraClass?: string): Gtk.Label {
  return new Gtk.Label({
    label: text,
    css_classes: extraClass ? ["installer-prose", extraClass] : ["installer-prose"],
    halign: Gtk.Align.FILL,
    hexpand: true,
    xalign: 0,
    wrap: true,
    wrap_mode: Pango.WrapMode.WORD_CHAR,
  })
}

function cleanupTempFiles() {
  try {
    if (GLib.file_test(CREDS_PATH, GLib.FileTest.EXISTS)) {
      GLib.unlink(CREDS_PATH)
    }
  } catch {}
  try {
    if (GLib.file_test(PLAN_PATH, GLib.FileTest.EXISTS)) {
      GLib.unlink(PLAN_PATH)
    }
  } catch {}
}

export function RunStep(): Step {
  // True from the moment archinstall is handed the plan until it has exited, one
  // way or the other. The frame reads it through `busy()` to refuse an exit.
  let running = false

  return {
    id: "run",
    title: t("runTitle"),
    nextLabel: "",
    ready: () => false,
    busy: () => running,

    build(notifyReady) {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        hexpand: true,
      })

      const headLabel = heading(t("runHeading"))
      const subLabel = prose("", "installer-prose--dim")
      subLabel.visible = false

      const spinner = new Gtk.Spinner({
        spinning: true,
        width_request: 36,
        height_request: 36,
        halign: Gtk.Align.CENTER,
        margin_top: 12,
        margin_bottom: 12,
      })

      const progressBar = new Gtk.ProgressBar({
        hexpand: true,
        pulse_step: 0.05,
      })

      const logBuffer = new Gtk.TextBuffer()
      const logView = new Gtk.TextView({
        buffer: logBuffer,
        editable: false,
        monospace: true,
        cursor_visible: false,
        wrap_mode: Gtk.WrapMode.CHAR,
      })
      logView.add_css_class("installer-log-view")

      const logScroll = new Gtk.ScrolledWindow({
        child: logView,
        min_content_height: 180,
        max_content_height: 240,
        hexpand: true,
        vexpand: true,
      })

      const expander = new Gtk.Expander({
        label: t("runShowLog"),
        child: logScroll,
        hexpand: true,
      })

      const actionsBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        halign: Gtk.Align.END,
        margin_top: 8,
        visible: false,
      })

      const restartBtn = NidaraButton({ label: t("runRestart"), variant: "primary" })
      restartBtn.connect("clicked", () => {
        execAsync(["systemctl", "reboot"]).catch(e => console.error("[Installer] reboot:", e))
      })

      const closeBtn = NidaraButton({ label: t("runClose"), variant: "secondary" })
      closeBtn.connect("clicked", () => {
        const root = box.get_root()
        if (root && root instanceof Gtk.Window) {
          root.close()
        }
      })

      actionsBox.append(closeBtn)
      actionsBox.append(restartBtn)

      box.append(headLabel)
      box.append(subLabel)
      box.append(spinner)
      box.append(progressBar)
      box.append(expander)
      box.append(actionsBox)

      const appendLog = (line: string) => {
        const iter = logBuffer.get_end_iter()
        logBuffer.insert(iter, line + "\n", -1)
        progressBar.pulse()
      }

      // Start execution when the step is built
      running = true
      notifyReady?.()
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        startInstallation(appendLog, (success, errorMsg) => {
          running = false
          notifyReady?.()
          spinner.spinning = false
          spinner.visible = false
          progressBar.visible = false

          if (success) {
            headLabel.label = t("runSuccessHeading")
            subLabel.label = t("runSuccessProse")
            subLabel.visible = true
            subLabel.remove_css_class("installer-prose--warning")
            actionsBox.visible = true
            restartBtn.visible = true
            closeBtn.visible = false
          } else {
            headLabel.label = t("runFailedHeading")
            subLabel.label = errorMsg || t("runFailedProse")
            subLabel.visible = true
            subLabel.add_css_class("installer-prose--warning")
            expander.expanded = true
            actionsBox.visible = true
            restartBtn.visible = false
            closeBtn.visible = true
          }
        })
        return GLib.SOURCE_REMOVE
      })

      return box
    },
  }
}

function startInstallation(
  onLog: (line: string) => void,
  onComplete: (success: boolean, error?: string) => void,
) {
  try {
    const answers = getAnswers()
    if (!answers.disk || !answers.account) {
      onComplete(false, "Incomplete installer configuration")
      return
    }

    const { config, creds } = assemblePlan(answers)

    // The user's password, in the clear, in a world-readable directory: it is
    // created 0600 and never widened, rather than written and then narrowed.
    // `file_set_contents` + `chmod` leaves the file at the umask (0644 on Arch)
    // for the width of two syscalls — small, but /tmp is the one place on the
    // system where anything at all can be watching. `FileCreateFlags.PRIVATE` is
    // "only the current user can read it" applied AT creation; the unlink first
    // is because `replace` on an existing file would inherit ITS permissions.
    const credsJson = JSON.stringify(creds, null, 2)
    if (GLib.file_test(CREDS_PATH, GLib.FileTest.EXISTS)) GLib.unlink(CREDS_PATH)
    const credsStream = Gio.File.new_for_path(CREDS_PATH)
      .replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
    credsStream.write_all(new TextEncoder().encode(credsJson), null)
    credsStream.close(null)

    // Write initial plan
    GLib.file_set_contents(PLAN_PATH, JSON.stringify(config, null, 2))

    // Inject disk layout via python archinstall if available
    const diskPath = answers.disk.path
    const pythonScript = `
import sys, json, asyncio
from pathlib import Path
try:
    from archinstall.lib.disk.device_handler import device_handler
    from archinstall.lib.disk.disk_menu import suggest_single_disk_layout
    from archinstall.lib.models.device import DiskLayoutConfiguration, DiskLayoutType, FilesystemType
    dev = device_handler.get_device(Path("${diskPath}"))
    if dev:
        mod = asyncio.run(suggest_single_disk_layout(dev, FilesystemType.EXT4, separate_home=False))
        disk_cfg = DiskLayoutConfiguration(config_type=DiskLayoutType.Default, device_modifications=[mod]).json()
        cfg = json.loads(Path("${PLAN_PATH}").read_text())
        cfg["disk_config"] = disk_cfg
        Path("${PLAN_PATH}").write_text(json.dumps(cfg, indent=2))
        print("disk_config_ok")
except Exception as e:
    print(f"disk_error:{e}", file=sys.stderr)
`

    try {
      const diskProc = Gio.Subprocess.new(
        ["python3", "-c", pythonScript],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      )
      diskProc.communicate_utf8(null, null)
    } catch (e) {
      console.warn("[Installer] Dynamic disk layout calculation skipped:", e)
    }

    // Determine command: on ISO / root we invoke archinstall
    const isIso = GLib.file_test("/usr/share/nidara-installer/base.json", GLib.FileTest.EXISTS)
    const cmd = isIso
      ? ["pkexec", "archinstall", "--config", PLAN_PATH, "--creds", CREDS_PATH, "--silent"]
      : ["archinstall", "--config", PLAN_PATH, "--creds", CREDS_PATH, "--silent", "--dry-run"]

    onLog(`[Installer] Starting: ${cmd.join(" ")}`)

    let proc: Gio.Subprocess
    try {
      proc = Gio.Subprocess.new(
        cmd,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      )
    } catch (e: any) {
      cleanupTempFiles()
      onComplete(false, String(e?.message ?? e))
      return
    }

    const stdoutStream = new Gio.DataInputStream({
      base_stream: proc.get_stdout_pipe()!,
    })

    const readLineAsync = () => {
      stdoutStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_, res) => {
        try {
          const [lineBytes] = stdoutStream.read_line_finish_utf8(res)
          if (lineBytes !== null) {
            onLog(lineBytes)
            readLineAsync()
          }
        } catch {
          // Stream finished or error
        }
      })
    }
    readLineAsync()

    proc.wait_async(null, (_, res) => {
      try {
        proc.wait_finish(res)
        const ok = proc.get_successful()
        cleanupTempFiles()
        onComplete(ok, ok ? undefined : "archinstall exited with failure status")
      } catch (e: any) {
        cleanupTempFiles()
        onComplete(false, String(e?.message ?? e))
      }
    })
  } catch (err: any) {
    cleanupTempFiles()
    onComplete(false, String(err?.message ?? err))
  }
}
