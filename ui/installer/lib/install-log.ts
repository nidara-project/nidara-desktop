// The installation log, somewhere it outlives the window.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Every line the run step printed — ours and archinstall's — lived in one
// Gtk.TextBuffer and nowhere else. Close the window, or have the installer die,
// and the only record of what happened was gone; on success it never reached
// the installed system either, where archinstall's own log does land. The one
// outside report so far (nidara-iso#17) could not be settled for want of it.
//
// Calamares keeps its session log on the medium and copies it into the target
// as /var/log/installation.log. This does the same, in three places:
//
//   1. a file on the live medium, written line by line as the run goes, so it
//      survives the window (`openLiveLog`) — one per attempt, named by the
//      moment it started, because the log that matters after a retry is usually
//      the attempt that FAILED;
//   2. the installed system's /var/log/nidara-installer.log, next to
//      /var/log/archinstall/install.log, whenever the target got far enough to
//      have a /var/log (`copyLogToTarget`), readable by root only;
//   3. wherever the person chooses, from the run page — see steps/run.ts.
//
// ⚠️ What goes in is what the page shows, which by construction carries no
// secret: the credentials go to archinstall in a 0600 file that is never
// printed, and the plan JSON is printed only in preview mode.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { exec } from "../../lib/process"

export const TARGET_LOG = "/mnt/var/log/nidara-installer.log"

export interface LiveLog {
  path: string
  write(line: string): void
}

/**
 * Opens a fresh log file for this attempt under the user's state directory
 * (`~/.local/state/nidara/installer-<YYYYmmdd-HHMMSS>.log`), private to the user.
 * Never throws: a log that cannot be opened must not stop an install, so the
 * failure comes back as a writer that does nothing and a path of "".
 */
export function openLiveLog(): LiveLog {
  try {
    const dir = GLib.build_filenamev([GLib.get_user_state_dir(), "nidara"])
    GLib.mkdir_with_parents(dir, 0o700)
    const stamp = GLib.DateTime.new_now_local().format("%Y%m%d-%H%M%S")
    const path = GLib.build_filenamev([dir, `installer-${stamp}.log`])
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
    const encoder = new TextEncoder()
    return {
      path,
      write(line: string) {
        // Flushed per line: the whole point is that the file is complete up to the
        // moment the process stopped, however it stopped.
        try {
          stream.write_all(encoder.encode(line + "\n"), null)
          stream.flush(null)
        } catch {}
      },
    }
  } catch {
    return { path: "", write() {} }
  }
}

function run(cmd: string[]): void {
  const isRoot = GLib.get_user_name() === "root"
  const fullCmd = isRoot ? cmd : ["sudo", "-n", ...cmd]
  const proc = Gio.Subprocess.new(fullCmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  const [, , stderr] = proc.communicate_utf8(null, null)
  if (!proc.get_successful()) {
    throw new Error(stderr?.trim() || `Command failed: ${fullCmd.join(" ")}`)
  }
}

/**
 * Copies the live log into the installed system, root-only. Returns whether it
 * did. Only on a real install, and only when the target has a /var/log — a run
 * that failed before pacstrap has no system to put it in, and creating one would
 * be writing into a disk that holds nothing.
 */
export function copyLogToTarget(arm: boolean, livePath: string, appendLog: (msg: string) => void): boolean {
  if (!arm || !livePath) return false
  if (!GLib.file_test("/mnt/var/log", GLib.FileTest.IS_DIR)) return false
  // Said BEFORE the copy, so the line is in the copy.
  appendLog(`[LOG] This log is kept in the installed system as ${TARGET_LOG.replace(/^\/mnt/, "")}.`)
  try {
    run(["install", "-m", "0600", "-o", "root", "-g", "root", livePath, TARGET_LOG])
    return true
  } catch (e: any) {
    appendLog(`[WARN] Could not copy the log into the installed system: ${e.message || e}`)
    return false
  }
}

/** archinstall's own log on the live medium. */
export const ARCHINSTALL_LOG = "/var/log/archinstall/install.log"

/**
 * The last lines of archinstall's own log, for deciding what a failure was — never
 * shown. Some failures reach it and not our page: when archinstall's FIRST sync dies
 * (the live medium's overlay full, measured 2026-10-13), it prints only "Failed to
 * sync Arch Linux package database" and keeps pacman's words — "Failure writing output
 * to destination" — for this file. Read directly when it is readable, through
 * `sudo -n` when it is not (archinstall runs as root); `[]` when neither works, so a
 * failure to read it changes nothing.
 */
export function archinstallLogTail(lines = 200): string[] {
  try {
    const [ok, bytes] = GLib.file_get_contents(ARCHINSTALL_LOG)
    if (ok) return new TextDecoder().decode(bytes).split("\n").slice(-lines)
  } catch {}
  try {
    const cmd = ["tail", "-n", String(lines), ARCHINSTALL_LOG]
    return exec(GLib.get_user_name() === "root" ? cmd : ["sudo", "-n", ...cmd]).split("\n")
  } catch {
    return []
  }
}
