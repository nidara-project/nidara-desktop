// Step 8 — Installation execution and live progress output with safety arm guard.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import Gio from "gi://Gio"
import type { Step } from "../lib/flow"
import { NidaraButton, NidaraScrolled, showNidaraAlert } from "../../lib/nidara-kit"
import { t } from "../lib/i18n"
import { getAnswers } from "../lib/answers"
import { assemblePlan, type AssembledPlan } from "../lib/plan"
import { archinstallStamp, configureInstalledBootloader } from "../lib/bootloader"
import { writeKeyboardConfig } from "../lib/keyboard-config"
import { applyRealName } from "../lib/real-name"
import { writeSwapFstabEntries } from "../lib/swap"
import { copyNetworkConnections } from "../lib/network-connections"
import { releaseTargetDisks } from "../lib/release-target"
import { copyLogToTarget, openLiveLog, type LiveLog } from "../lib/install-log"
import { stripAnsi } from "../lib/ansi"
import { connectivity, isUsable } from "../lib/network"
import { DOWNLOAD_DIRS, STALL_QUIET_MS, failedDownloading, looksStalled } from "../lib/stall"
import { measureMirrors, prepareLiveMirrorlist, restoreTargetMirrorlist } from "../lib/mirrors"
import { isPreview, previewSkip } from "../lib/preview"
import { heading, prose } from "./common"

export function RunStep(): Step {
  let _busy = false
  let _outcome: "success" | "failure" | null = null
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
    outcome: () => _outcome,
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

      // Shown only while the install is waiting on a connection that has gone —
      // see lib/stall.ts for what counts, and for why nothing is killed.
      const stallWarn = prose(t("runWaitingForNetwork"), "installer-prose--warning")
      stallWarn.visible = false
      box.append(stallWarn)
      // Offered only while that warning is up: waiting is legitimate (the
      // connection can come back), and so is not waiting — pacman takes minutes
      // to give up on mirrors nobody is reaching, and no stalled run in four
      // recovered. Whose choice that is was the question the owner answered: the
      // person's, not a timer's.
      let stopInstall: (() => void) | null = null
      let stoppedByUser = false
      const stopButton = NidaraButton({ label: t("runStopInstall"), halign: Gtk.Align.START })
      stopButton.visible = false
      stopButton.connect("clicked", () => {
        showNidaraAlert({
          parent: box.get_root() as Gtk.Window,
          heading: t("runStopHeading"),
          body: t("runStopBody"),
          responses: [
            { id: "wait", label: t("runStopKeepWaiting") },
            { id: "stop", label: t("runStopConfirm"), suggested: true },
          ],
          onResponse: (id) => { if (id === "stop") stopInstall?.() },
        })
      })
      box.append(stopButton)
      // The child's last lines, kept to tell a download failure from any other
      // one when the run ends. Ours are not in it.
      let childTail: string[] = []

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

      // Offered only once a run has FAILED: that is when the log has to leave this
      // machine — onto a USB stick, into a report. A finished install already
      // carries it in /var/log (lib/install-log.ts).
      let liveLog: LiveLog = { path: "", write() {} }
      const saveLogButton = NidaraButton({ label: t("runSaveLog"), halign: Gtk.Align.START })
      saveLogButton.visible = false
      const savedLabel = new Gtk.Label({
        label: "", css_classes: ["installer-phase-detail"], visible: false,
        halign: Gtk.Align.FILL, hexpand: true, xalign: 0, wrap: true,
      })
      saveLogButton.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({ title: t("runSaveLog"), initial_name: "nidara-installer.log", modal: true })
        dialog.save(box.get_root() as Gtk.Window, null, (_d, res) => {
          let dest: Gio.File | null = null
          try { dest = dialog.save_finish(res) } catch { return } // cancelled
          if (!dest) return
          try {
            Gio.File.new_for_path(liveLog.path).copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null)
            savedLabel.label = t("runLogSaved") + (dest.get_path() ?? dest.get_uri())
          } catch (e: any) {
            savedLabel.label = `${e.message || e}`
          }
          savedLabel.visible = true
        })
      })
      box.append(saveLogButton)
      box.append(savedLabel)
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
      const appendLog = (raw: string, opts: { quiet?: boolean } = {}) => {
        const line = stripAnsi(raw)
        if (line === "" && raw !== "") return
        const endIter = textBuffer.get_end_iter()
        textBuffer.insert(endIter, line + "\n", -1)
        liveLog.write(line)
        // The same line the log gets, under the phase — so the page says what it
        // is doing without anybody having to open the expander to find out.
        //
        // ⚠️ `quiet` is for the lines the page ALREADY says in its own words: the
        // network warning went into the log AND into this one line, so the same
        // sentence appeared twice, once elided to the column width.
        if (line.trim() && !opts.quiet) detail.label = line.trim()
        const adj = scrolled.vadjustment
        if (adj) adj.value = adj.upper - adj.page_size
      }

      const finishRun = (success: boolean) => {
        // Before setBusy: its notify is what repaints the footer, and the footer
        // reads the outcome.
        _outcome = success ? "success" : "failure"
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
          // archinstall's own last words for a download that died are a Python
          // traceback and "please report it to archinstall" — accurate about
          // where it failed and useless about why. When the child's output shows
          // it could not download, say that, and what to do about it.
          desc.label = stoppedByUser
            ? t("runFailedStoppedProse")
            : failedDownloading(childTail) ? t("runFailedNetworkProse") : t("runFailedProse")
          desc.remove_css_class("installer-prose--dim")
          desc.add_css_class("installer-prose--warning")
          expander.expanded = true
          saveLogButton.visible = liveLog.path !== ""
        }
      }

      // Execute archinstall
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        // First, so even a run that stops at the network check leaves a file.
        liveLog = openLiveLog()
        setBusy(true)
        enterPhase(0)
        const answers = getAnswers()

        // ⚠️ Checked HERE, before archinstall is spawned, and not one line later.
        // Everything below this point needs the network — pacstrap, the curl that
        // fetches the repo signing key, the `pacman -Sy` of the three Nidara
        // packages — and the first thing archinstall does is erase a partition
        // table. Failing after that leaves a machine with no operating system at
        // all, which is strictly worse than the one it had five minutes ago.
        connectivity({ fresh: true }).then(c => {
          if (!isUsable(c)) {
            appendLog(`[ERROR] ${t("runErrNoNetwork")}`)
            finishRun(false)
            return
          }
          // Still phase 0, and deliberately: this IS the network phase, and it
          // is the last moment the network is used for something other than
          // downloading the system. It runs here rather than earlier in the
          // wizard because here is where a slow answer costs nothing anybody
          // notices — the install that follows takes minutes — and because a
          // measurement taken five pages ago could be describing a Wi-Fi network
          // the person has since left.
          if (isPreview()) {
            appendLog(previewSkip("reflector --sort rate (measuring mirror speed)"))
            startInstall(answers, [])
            return
          }
          appendLog(`[MIRRORS] ${t("runMirrorsMeasuring")}`)
          measureMirrors(getAnswers().country?.code ?? null).then(servers => {
            // Both outcomes are said out loud. A silent empty answer is
            // indistinguishable from a measurement that was never attempted,
            // and this is the one step of the install whose whole value is
            // invisible afterwards.
            if (servers.length > 0) {
              appendLog(`[MIRRORS] ${t("runMirrorsChosen")}${servers.length}`)
              for (const url of servers) appendLog(`[MIRRORS]   ${url}`)
            } else {
              appendLog(`[MIRRORS] ${t("runMirrorsNone")}`)
            }
            startInstall(answers, servers)
          })
        })

        return GLib.SOURCE_REMOVE
      })

      function startInstall(answers: ReturnType<typeof getAnswers>, measuredMirrors: string[]) {
        // Two modes, and WHERE it runs picks one: the live medium installs for real, anything
        // else is a dry run. There is deliberately no variable that arms it elsewhere — the
        // dangerous direction is unreachable, not merely discouraged. `NIDARA_INSTALLER_DRY_RUN`
        // only ever points the safe way, so the worst a typo in it can do is refuse to install.
        const isLiveMedium = GLib.file_test("/run/archiso", GLib.FileTest.EXISTS)
        const isForcedDryRun = GLib.getenv("NIDARA_INSTALLER_DRY_RUN") === "1"
        const isArm = isLiveMedium && !isForcedDryRun

        // ⚠️ Nothing here touches a disk any more, in EITHER mode. Both hand the
        // layout to archinstall in the plan (lib/disk-config.ts), which
        // partitions, formats, makes the subvolumes and mounts them itself — so
        // running a partitioner of our own as well would write the disk twice,
        // ours first and archinstall's over the top (#310). What used to live
        // here was `sgdisk`, `mkfs.*`, `btrfs subvolume create` and eight mounts,
        // guarded by an arm gate that three of its own commands escaped.
        if (answers.disk) {
          appendLog("[PREP] The disk layout is archinstall's to write — see the plan below.")
        }

        let plan: AssembledPlan
        try {
          plan = assemblePlan(answers, undefined, measuredMirrors)
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
          appendLog(previewSkip("applyRealName + writeKeyboardConfig + configureInstalledBootloader (already gated on arm)"))
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

        // ⚠️ Before the spawn, and it is what makes a second attempt possible: a
        // failed or finished run leaves its swap on and its mounts (and, encrypted,
        // its mapping) in place, and archinstall then dies on `umount -R [SWAP]`
        // before writing anything (lib/release-target.ts). Stopping here if the
        // disk cannot be freed is the same bargain as the network check above.
        if (!releaseTargetDisks(isArm, answers, appendLog)) {
          cleanup()
          finishRun(false)
          return
        }
        // Two leftovers in one file, both the LIVE mirrorlist: the servers earlier
        // attempts prepended (archinstall never removes them), and 431 fallback
        // servers, which is what decides how long a stalled download takes to
        // fail. The full list goes to the installed system at the end.
        const fullMirrorlist = prepareLiveMirrorlist(isArm, appendLog)

        // ── The spawn starts in phase 1, and the child says when it is past it ─
        //
        // The four phases used to line up with this file's own boundaries: phase 1
        // finished when OUR partitioner finished. That work is now inside the
        // process about to be spawned, so ticking "Disk ✓" here would report a
        // disk that has not been touched — and if archinstall then failed while
        // partitioning, the screen would say the disk step had succeeded.
        //
        // ⚠️ The marker is `info(f'Installing packages: {packages}')`
        // (archinstall's `lib/pacman/pacman.py`), the line immediately before
        // pacstrap — an `info`, so it reaches stdout, unlike the `debug` lines
        // around the mounting. If it ever stops matching the cost is a phase row
        // that stays lit until the install finishes, not a wrong claim.
        let awaitingBasePhase = true
        enterPhase(1)

        // ⚠️ Taken HERE, one line before the spawn, and it is not a log line.
        // `configureInstalledBootloader` uses it to tell the loader entries THIS
        // run produced from the ones that were already on the EFI partition — an
        // ESP can be shared with a system that was installed first, and every
        // edit it makes is scoped by this stamp (#443). archinstall fixes its own
        // `init_time` when its Installer is constructed, which is after this, so
        // ours can only be the earlier of the two.
        const startedAt = archinstallStamp()
        let lastLineAt = GLib.get_monotonic_time()

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
                    lastLineAt = GLib.get_monotonic_time()
                    childTail.push(line)
                    if (childTail.length > 300) childTail = childTail.slice(-300)
                    if (awaitingBasePhase && line.includes("Installing packages:")) {
                      awaitingBasePhase = false
                      enterPhase(2)
                    }
                    appendLog(line)
                    readLineAsync()
                  }
                } catch {}
              })
            }
            readLineAsync()
          }

          // ── Is it waiting on a connection that has gone? ──────────────────────
          // Every 20 s: how long since the child printed, and how much the
          // download directories grew in the last STALL_QUIET_MS. Only when both
          // say "nothing" is NetworkManager asked, afresh — and only its answer
          // shows the warning. A line or growth hides it again.
          const dirBytes = (path: string): number => {
            let total = 0
            try {
              const en = Gio.File.new_for_path(path).enumerate_children("standard::size", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
              let info: Gio.FileInfo | null
              while ((info = en.next_file(null)) !== null) total += info.get_size()
              en.close(null)
            } catch {}
            return total
          }
          const sizeHistory: Array<{ at: number, bytes: number }> = []
          let asking = false
          const stallTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            const now = GLib.get_monotonic_time()
            const bytes = DOWNLOAD_DIRS.reduce((sum, d) => sum + dirBytes(d), 0)
            sizeHistory.push({ at: now, bytes })
            const windowUs = STALL_QUIET_MS * 1000
            while (sizeHistory.length > 1 && now - sizeHistory[1].at >= windowUs) sizeHistory.shift()
            // Not enough history to cover a whole window yet: not a stall.
            const waitingUI = (visible: boolean) => { stallWarn.visible = visible; stopButton.visible = visible }
            if (now - sizeHistory[0].at < windowUs) { waitingUI(false); return GLib.SOURCE_CONTINUE }
            const stalled = looksStalled({
              sinceLastLineMs: (now - lastLineAt) / 1000,
              downloadedInWindow: bytes - sizeHistory[0].bytes,
            })
            if (!stalled) { waitingUI(false); return GLib.SOURCE_CONTINUE }
            if (!asking) {
              asking = true
              connectivity({ fresh: true }).then(c => {
                asking = false
                const waiting = !isUsable(c)
                if (waiting && !stallWarn.visible) appendLog(`[NETWORK] ${t("runWaitingForNetwork")}`, { quiet: true })
                waitingUI(waiting)
              })
            }
            return GLib.SOURCE_CONTINUE
          })

          // ⚠️ Our child is `sudo -n archinstall …`, so killing IT kills sudo and
          // leaves archinstall — and the pacstrap under it — running as root on a
          // disk nobody is watching any more. The install is ended from the other
          // end: archinstall itself, then what may outlive it.
          stopInstall = () => {
            stoppedByUser = true
            stopButton.sensitive = false
            appendLog(`[STOP] ${t("runStopHeading")}`, { quiet: true })
            const asRoot = (cmd: string[]) => {
              try {
                const full = GLib.get_user_name() === "root" ? cmd : ["sudo", "-n", ...cmd]
                Gio.Subprocess.new(full, Gio.SubprocessFlags.STDERR_MERGE).wait(null)
              } catch {}
            }
            asRoot(["pkill", "-TERM", "-f", "bin/archinstall"])
            asRoot(["pkill", "-TERM", "-x", "pacstrap"])
            asRoot(["pkill", "-TERM", "-x", "pacman"])
            try { _proc?.force_exit() } catch {}
          }

          _proc.wait_async(null, (_procSrc, res) => {
            GLib.source_remove(stallTimer)
            stallWarn.visible = false
            stopButton.visible = false
            let success = false
            try {
              _proc?.wait_finish(res)
              success = _proc?.get_successful() ?? false
              if (success) {
                enterPhase(3)
                applyRealName(isArm, answers, appendLog)
                writeKeyboardConfig(isArm, answers, appendLog)
                writeSwapFstabEntries(isArm, answers, appendLog)
                copyNetworkConnections(isArm, answers, appendLog)
                configureInstalledBootloader(isArm, answers, appendLog, startedAt)
                restoreTargetMirrorlist(isArm, fullMirrorlist, measuredMirrors, appendLog)
              }
            } catch (e: any) {
              appendLog(`[ERROR] Process exited with error: ${e.message || e}`)
            } finally {
              // Success or not: a target that got as far as /var/log keeps the log.
              copyLogToTarget(isArm, liveLog.path, appendLog)
              // ⚠️ And then let go of the disk. archinstall unmounts nothing on exit,
              // so a finished install sat mounted under /mnt with its swap on — and
              // powering off from the button, or pulling the stick, is what somebody
              // does next as often as pressing Restart. The same release a retry needs
              // (lib/release-target.ts), after the last write: the log copy above.
              releaseTargetDisks(isArm, answers, appendLog)
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
