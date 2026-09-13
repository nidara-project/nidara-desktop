// The networks joined on the live medium, carried into the installed system.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Somebody with no cable joins their Wi-Fi from the live session's control
// centre, installs, reboots — and the installed system has never heard of that
// network. `/etc/NetworkManager/system-connections/` on the target was EMPTY
// (measured, 2026-09-14 VM: a connection saved on the medium, a complete install,
// nothing on the disk), so the first thing a new machine asks for is the password
// its owner typed ten minutes earlier; with a password nobody has to hand, the
// machine boots offline.
//
// base.json asks archinstall for `network_config: nm`, which installs and enables
// NetworkManager and copies nothing. archinstall's `iso` type does not help
// either: `copy_iso_network_config` carries iwd's `*.psk` and systemd-networkd's
// files, not NetworkManager's, and forces systemd-resolved as well
// (`installer.py:781`). Calamares' `networkcfg` module is the prior art
// (`src/modules/networkcfg/main.py`): copy every connection, and put the new
// user where the live user was.
//
// ─── WHAT IS COPIED ──────────────────────────────────────────────────────────
// Keyfiles the person SAVED (`*.nmconnection` in /etc). NetworkManager's
// automatic "Wired connection 1" lives in /run and is not a file here — the
// installed system makes its own.
//
// ⚠️ A connection restricted to one user (`permissions=user:live;`) names the
// live account, which does not exist on the target: NetworkManager there would
// hide it from everybody. `withOwner` swaps that user for the new account and
// touches nothing else — least of all a secret.
//
// ⚠️ These files can hold a Wi-Fi password in clear (`psk=`). They are written
// through `umask 077`, so they are 0600 from the moment they exist, never
// readable in between.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Answers } from "./answers"

const SOURCE_DIR = "/etc/NetworkManager/system-connections"
const TARGET_DIR = "/mnt/etc/NetworkManager/system-connections"

/**
 * The connection with `liveUser` replaced by `newUser` in its `permissions=` key,
 * which NetworkManager writes as `user:<name>;` entries (optionally several).
 * Only the `[connection]` section's key is read; a different user, or the same
 * text anywhere else in the file (an SSID, a comment), is left as it is.
 */
export function withOwner(text: string, liveUser: string, newUser: string): string {
  let section = ""
  return text.split("\n").map(line => {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) { section = header[1]; return line }
    if (section !== "connection") return line
    const m = line.match(/^(\s*permissions\s*=\s*)(.*)$/)
    if (!m) return line
    const entries = m[2].split(";").map(e => (e.trim() === `user:${liveUser}` ? `user:${newUser}` : e))
    return m[1] + entries.join(";")
  }).join("\n")
}

/** The saved connections among a directory listing — keyfiles only. */
export function connectionFiles(names: string[]): string[] {
  return names.filter(n => n.endsWith(".nmconnection") && !n.includes("/") && !n.startsWith("."))
}

function run(cmd: string[], stdin: string | null = null): string {
  const isRoot = GLib.get_user_name() === "root"
  const fullCmd = isRoot ? cmd : ["sudo", "-n", ...cmd]
  const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    | (stdin !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0)
  const proc = Gio.Subprocess.new(fullCmd, flags)
  const [, stdout, stderr] = proc.communicate_utf8(stdin, null)
  if (!proc.get_successful()) {
    throw new Error(stderr?.trim() || `Command failed: ${fullCmd.join(" ")}`)
  }
  return stdout ?? ""
}

/**
 * Copies the live medium's saved connections into the installed system.
 * Runs after archinstall, which leaves /mnt mounted. A failure is a log line,
 * never a failed install: the machine still has NetworkManager, only not the
 * network it was installed from.
 */
export function copyNetworkConnections(arm: boolean, answers: Answers, appendLog: (msg: string) => void) {
  if (!arm) return
  const newUser = answers.account?.username
  // The live session's own account — the one a connection saved from its
  // control centre is restricted to.
  const liveUser = GLib.get_user_name() === "root" ? "live" : GLib.get_user_name()

  let names: string[]
  try {
    names = connectionFiles(run(["ls", "-1", SOURCE_DIR]).split("\n").filter(Boolean))
  } catch {
    return // no NetworkManager keyfiles on the medium: nothing was saved
  }
  if (names.length === 0) return

  let copied = 0
  for (const name of names) {
    try {
      const text = run(["cat", `${SOURCE_DIR}/${name}`])
      const next = newUser ? withOwner(text, liveUser, newUser) : text
      run(["install", "-d", "-m", "0700", TARGET_DIR])
      // `$1` is the path, passed as an argument rather than spliced into the
      // script: a connection name is somebody's SSID, and an SSID can hold a quote.
      run(["sh", "-c", 'umask 077 && cat > "$1"', "sh", `${TARGET_DIR}/${name}`], next)
      copied++
    } catch (e: any) {
      appendLog(`[WARN] Could not carry the saved network ${name} into the installed system: ${e.message || e}`)
    }
  }
  if (copied > 0) {
    appendLog(`[NETWORK] ${copied} saved ${copied === 1 ? "network" : "networks"} from this session carried into the installed system.`)
  }
}
