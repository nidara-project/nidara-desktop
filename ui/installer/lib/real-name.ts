// Writes the full name the person typed into the system that was just installed.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The account step has asked for a full name since it was written, validates it,
// and shows it back on the summary — and then dropped it. Nothing carried it out
// of the installer: `ArchinstallUser` has `username`, `sudo` and `enc_password`,
// and archinstall's own model has nowhere to put a real name either. So every
// machine this installer produced had an EMPTY GECOS field, and every surface
// that shows a person's name fell back to the username.
//
// That fallback is deliberate and shared — `ui/lib/users.ts` is the one reader
// for the greeter, the lockscreen and Settings → Users — so the name was missing
// in all three at once, and the only place it ever appeared was the summary page
// of the installer that discarded it.
//
// ⚠️ Not `GLib.get_real_name()` and not AccountsService: GECOS in /etc/passwd is
// the source those read from (AccountsService's SetRealName writes it too), so
// writing it here is what makes every surface agree.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Answers } from "./answers"

function runCmd(cmd: string[]): void {
  const isRoot = GLib.get_user_name() === "root"
  const fullCmd = isRoot ? cmd : ["sudo", "-n", ...cmd]
  const proc = Gio.Subprocess.new(fullCmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
  const [, , stderr] = proc.communicate_utf8(null, null)
  if (!proc.get_successful()) {
    throw new Error(stderr?.trim() || `Command failed: ${fullCmd.join(" ")}`)
  }
}

/**
 * Sets the installed user's GECOS field to the full name from the account step.
 *
 * Runs after archinstall has created the account, and only on a real install —
 * a dry run has no /mnt to write into.
 */
export function applyRealName(
  arm: boolean,
  answers: Answers,
  appendLog: (msg: string) => void,
) {
  if (!arm) return

  const account = answers.account
  if (!account) return

  const fullName = account.fullName.trim()
  // Nothing to say when the name IS the username: that is what the surfaces
  // already display on their own, and writing it would only make the fallback
  // look like a choice.
  if (!fullName || fullName === account.username) return

  try {
    // `usermod --root` edits the target's passwd files directly, so this needs
    // no chroot and none of the mounts one requires. `--comment` is passed as
    // its own argv element, never through a shell: the name is free text a
    // person typed.
    runCmd(["usermod", "--root", "/mnt", "--comment", fullName, account.username])
    appendLog(`[ACCOUNT] Full name set for ${account.username}: ${fullName}`)
  } catch (e: any) {
    // Worth a line and not worth failing the install over: the machine is
    // complete and usable, it just shows the username where it could show a
    // name, and Settings → Users can set it afterwards.
    appendLog(`[WARN] Could not set the full name for ${account.username}: ${e.message || e}`)
  }
}
