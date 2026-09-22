// What base.json's custom_commands print, somewhere a person can read it.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// archinstall 4.4 runs each custom command as
// `SysCommand(f'arch-chroot -S {target} bash {script}')` with no `peek_output`
// (lib/installer.py, run_custom_user_commands). Its output is kept in memory and
// thrown away when the command succeeds: it never reaches archinstall's stdout —
// which is what our run page shows — nor cmd_output.txt, nor install.log, which
// records only `Executing custom command "…"`. Measured on the clean install of
// 2026-09-22: of five commands, including the pacman transaction that installs
// the desktop, not one line of output survived anywhere.
//
// That silently voided every warning nidara-setup prints — among them the check
// that the icon-theme default was really seeded. A check whose result reaches
// nobody is not a check (tech-debt #101). A FAILING command was never silent:
// archinstall raises with the last 500 characters, and still does, because `tee`
// passes the output through as well as keeping it.
//
// So each command is wrapped to append its output to a file in the target, and
// after archinstall the run page reads that file back: every line stays in the
// installed system, and the lines that warn or fail are repeated in our own log.

import GLib from "gi://GLib"

/** Where the output lands, as seen from INSIDE the target (the command runs chrooted). */
export const COMMAND_LOG = "/var/log/nidara-install-commands.log"

/**
 * Wraps one custom command so its output is appended to COMMAND_LOG and still
 * passed through to archinstall. `pipefail` keeps the command's own exit status —
 * without it the pipeline would answer with `tee`'s, and a failed install would
 * read as a success.
 *
 * ⚠️ The wrap must not change what the command MEANS. The brace group runs in a
 * subshell that inherits `pipefail`, so it is switched back off inside: base.json's
 * `curl … | pacman-key --add -` answers with pacman-key's status, and with
 * pipefail leaking in it would answer with curl's instead (measured: 0 → 7).
 */
export function wrapCommandForLog(cmd: string): string {
  // A trailing `;` inside `{ …; }` is `;;`, which is a syntax error.
  const body = cmd.replace(/[\s;]+$/, "")
  return `set -o pipefail; { set +o pipefail; ${body}; } 2>&1 | tee -a ${COMMAND_LOG}`
}

/**
 * The lines worth repeating in our own log: nidara-setup's `[WARN]`/`[ERROR]` and
 * `WARNING:`, pacman's and pacman-key's `warning:`/`error:` at the start of a line,
 * mkinitcpio's `==> ERROR:`.
 *
 * ⚠️ Anchored on those SHAPES, never on the bare word: pacman lists package names,
 * and `perl-error` is one — `\bERROR\b` matched it three times in the first real
 * install (the package list, "downloading", "installing"). mkinitcpio's
 * `==> WARNING:` is left out on purpose: in a VM it is a page of "Possibly missing
 * firmware" that says nothing about the install.
 */
export function isNoteworthy(line: string): boolean {
  return /\[(WARN|ERROR)\]/.test(line)
    || (/\bWARNING:/.test(line) && !line.startsWith("==> "))
    || /^\s*(warning|error):/i.test(line)
    || /^==> ERROR:/.test(line)
}

/**
 * After archinstall: says where the commands' output is kept, and repeats the
 * lines that warn or fail. Silent when there is no file — a preview, or a run
 * that stopped before the first command.
 */
export function reportCommandLog(arm: boolean, appendLog: (msg: string) => void): void {
  if (!arm) return
  const path = `/mnt${COMMAND_LOG}`
  if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return
  let text = ""
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok) return
    text = new TextDecoder().decode(bytes)
  } catch (e: any) {
    appendLog(`[COMMANDS] Could not read ${COMMAND_LOG} from the installed system: ${e.message || e}`)
    return
  }
  const lines = text.split("\n").filter(l => l.trim() !== "")
  const noteworthy = lines.filter(isNoteworthy)
  appendLog(`[COMMANDS] ${lines.length} lines of output from the setup commands are kept in ${COMMAND_LOG}; ${noteworthy.length} of them warn or fail.`)
  for (const line of noteworthy) appendLog(`[COMMANDS]   ${line.trim()}`)
}
