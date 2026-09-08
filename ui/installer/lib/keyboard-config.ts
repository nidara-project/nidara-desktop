// The xkb keyboard the person chose, written into the installed system.
//
// ─── WHY THIS FILE EXISTS (#498) ─────────────────────────────────────────────
// The answer to "which keyboard?" is an xkb PAIR — `es` + `dvorak` — and the
// desktop that gets installed speaks that same vocabulary. Until this file, the
// pair had no way to travel: archinstall's `locale_config.kb_layout` is the
// CONSOLE keymap, one string in a namespace with no concept of a variant, and
// `bin/nidara-setup` reverse-engineered the layout back out of it at first boot.
//
// That conversion cannot work, and it was measured not working: of the 55
// keyboards the installer offered, 36 arrived at the desktop as a different
// string and 35 of those were not xkb layouts at all — `sv-latin1`, `jp106`,
// `it2`, `pl2`, `cf`, `de-latin1-nodeadkeys`. `xkbcli compile-keymap` refuses
// every one of them. Sweden, Japan, Italy, Poland and Canada were installing
// with a keyboard the desktop could not apply.
//
// ─── WHY THIS FILE AND NOT ANOTHER ───────────────────────────────────────────
// `/etc/X11/xorg.conf.d/00-keyboard.conf` is where the system's graphical
// keyboard is recorded on a systemd machine, and it is not our choice:
// `systemd-localed` writes exactly this file (and `XKBLAYOUT`/`XKBVARIANT` into
// it) whenever anything calls `SetX11Keyboard` — which is what GNOME and Anaconda
// do. Calamares writes the same file by hand, with the same two Options
// (`SetKeyboardLayoutJob.cpp:284-285`). So a Nidara install leaves the machine
// looking like every other install, and `localectl status` on the installed
// system reports the right keyboard without knowing we exist.
//
// ⚠️ NOT written with `localectl set-x11-keymap`, which would be the obvious way
// and does not work here: `localectl` talks to `systemd-localed` over D-Bus, and
// there is no systemd running inside the target at this point. The file IS the
// interface; the tool is one way of writing it.
//
// ⚠️ It is X11's file name on a session that has no X11, which reads like a
// mistake and is not. The name is historical; the CONTENT is what every reader on
// the machine looks for, ours included (`bin/nidara-setup`,
// `config/greetd/hyprland-greeter.lua`). Inventing a Nidara-shaped file instead
// would leave the standard one absent — and then `localectl`, and anybody's
// script, would report `us` on a machine that is not.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Answers } from "./answers"

const TARGET_DIR = "/mnt/etc/X11/xorg.conf.d"
const TARGET_FILE = `${TARGET_DIR}/00-keyboard.conf`

function run(cmd: string[], stdin: string | null = null): void {
  const isRoot = GLib.get_user_name() === "root"
  const fullCmd = isRoot ? cmd : ["sudo", "-n", ...cmd]
  const flags = Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE
    | (stdin !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0)
  const proc = Gio.Subprocess.new(fullCmd, flags)
  const [, , stderr] = proc.communicate_utf8(stdin, null)
  if (!proc.get_successful()) {
    throw new Error(stderr?.trim() || `Command failed: ${fullCmd.join(" ")}`)
  }
}

/**
 * The file's text, in systemd-localed's own shape.
 *
 * ⚠️ `XkbVariant` is written even when empty, exactly as localed does. An absent
 * Option and an empty one mean the same thing to X, but not to a reader doing
 * line matching — and both of our readers do.
 */
export function keyboardConfText(layout: string, variant: string): string {
  return [
    "# Written by the Nidara installer.",
    "# Keyboard settings for the graphical session. The text console is separate:",
    "# see KEYMAP in /etc/vconsole.conf.",
    'Section "InputClass"',
    '        Identifier "system-keyboard"',
    '        MatchIsKeyboard "on"',
    `        Option "XkbLayout" "${layout}"`,
    `        Option "XkbVariant" "${variant}"`,
    "EndSection",
    "",
  ].join("\n")
}

/**
 * Records the chosen xkb layout and variant in the installed system.
 *
 * Runs after archinstall has finished, for the same reason `applyRealName` does:
 * `Installer.__exit__` does not unmount, so /mnt is still there.
 *
 * A failure here is a WARNING, not an error. The install is complete and bootable
 * without it; what is lost is the variant, and the layout falls back to the
 * console keymap the way it did before — degraded, not broken.
 */
export function writeKeyboardConfig(
  arm: boolean,
  answers: Answers,
  appendLog: (msg: string) => void,
) {
  if (!arm) return

  const k = answers.keyboard
  if (!k?.layout) return

  try {
    run(["mkdir", "-p", TARGET_DIR])
    run(["tee", TARGET_FILE], keyboardConfText(k.layout, k.variant))
    appendLog(`[Nidara] Keyboard recorded: XkbLayout=${k.layout}`
      + (k.variant ? ` XkbVariant=${k.variant}` : ""))
  } catch (e: any) {
    appendLog(`[WARN] Could not write ${TARGET_FILE}: ${e.message || e}`)
  }
}
