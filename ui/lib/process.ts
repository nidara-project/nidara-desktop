// Subprocess helpers — what `ags/process` gave us, minus everything we never
// called.
//
// AGS's module is 341 lines: a `Process` GObject with stdout/stderr signals, a
// `subprocess()` wrapper, and `createSubprocess()`, a gnim Accessor that polls a
// long-lived child. Nidara imports exactly two names from it across all three
// bundles — `execAsync` (27 call sites) and `exec` (2) — so that is all that is
// here. Anything long-lived in this codebase already owns its own
// `Gio.Subprocess` (core/AgentService, core/hypr-ipc, bin/nidara-*).
//
// Both accept a string (parsed with `GLib.shell_parse_argv`) or an argv array.
// **Prefer the array.** A string goes through shell-word splitting, so a path
// with a space in it silently becomes two arguments; the array form is the one
// every call site that touches user data uses.
//
// ⚠️ Behaviour deliberately kept IDENTICAL to the AGS version it replaces, one
// trap included: `communicate_utf8*` marshals stdout through a NUL-terminated C
// string, so **stdout is truncated at the first NUL, silently**. That is not a
// bug we introduced and it is not one to fix here — a child whose output can
// contain NUL must read the BYTES itself (`communicate_async` +
// `Gio.Bytes.get_data()`), which is what `widgets/clipboard.ts` does after one
// UTF-16 clip made 49 KB of history arrive as six characters.
//
// 🔑 **Every child process of ours starts through `spawn()`** — `exec` and
// `execAsync` included — because a child inherits our ENVIRONMENT, and ours
// carries one variable that must never leave: `GTK_THEME=Empty` (commandment 11,
// `nidara-kit/platform/gtk-theme.ts`). It is how our process draws with no GTK
// theme, and GTK keeps re-reading it at every theme update, so it cannot be unset
// after start-up (measured 2026-09-27: unset it, flip dark mode, and the shell
// loads Adwaita). Inherited, it did the same to every app the dock, the app grid
// or Prism launched: they came up with NO theme at all — owner-caught the same
// day, measured on a Calculator started through `launchApp`. Our own programs
// (Settings, the installer…) set it again for themselves; nobody else should
// ever see it. `scripts/ci/child-env-check.mjs` keeps every other way of starting
// a process out of the desktop bundles.

import Gio from "gi://Gio"
import GLib from "gi://GLib"

/** Variables of OUR process that a child must not inherit. */
const PRIVATE_ENV = ["GTK_THEME"]

/**
 * Start a child process — the only door to one in the desktop bundles. Same
 * contract as `Gio.Subprocess.new`, minus our private environment.
 */
export function spawn(argv: string[], flags: Gio.SubprocessFlags = Gio.SubprocessFlags.NONE): Gio.Subprocess {
  const launcher = new Gio.SubprocessLauncher({ flags })
  for (const name of PRIVATE_ENV) launcher.unsetenv(name)
  return launcher.spawnv(argv)
}

/** Fire-and-forget a command line (`GLib.spawn_command_line_async`'s job). */
export function spawnCommandLine(cmd: string): void {
  spawn(toArgv(cmd))
}

function toArgv(cmd: string | string[]): string[] {
  if (Array.isArray(cmd)) return cmd
  const [ok, argv] = GLib.shell_parse_argv(cmd)
  if (!ok || !argv) throw Error(`could not parse command: ${cmd}`)
  return argv
}

/**
 * Run a command and block until it exits.
 *
 * @throws its stderr, as an Error, when the exit status is non-zero
 * @returns trimmed stdout
 */
export function exec(cmd: string | string[]): string {
  const proc = spawn(
    toArgv(cmd),
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  )
  const [, out, err] = proc.communicate_utf8(null, null)
  if (!proc.get_successful()) throw Error((err ?? "").trim())
  return (out ?? "").trim()
}

/**
 * Run a command without blocking the main loop.
 *
 * @throws (rejects with) its stderr, as an Error, when the exit status is non-zero
 * @returns trimmed stdout
 */
export function execAsync(cmd: string | string[]): Promise<string> {
  const proc = spawn(
    toArgv(cmd),
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  )
  return new Promise((resolve, reject) => {
    proc.communicate_utf8_async(null, null, (_: any, res: any) => {
      try {
        const [, out, err] = proc.communicate_utf8_finish(res)
        if (proc.get_successful()) resolve((out ?? "").trim())
        else reject(Error((err ?? "").trim()))
      } catch (error) {
        reject(error)
      }
    })
  })
}
