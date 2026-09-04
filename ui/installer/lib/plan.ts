// Assembles the final installation plan from base.json + user answers + live session defaults.
//
// Generates the JSON configuration consumed by archinstall and the credentials object
// consumed via `--creds`. Passwords are hashed with `openssl passwd -6` before
// being placed in the credentials object.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { exec } from "../../lib/process"
import { readBaseConfig, type BaseConfigResult, type BaseConfig } from "./base-config"
import { entireDiskConfig, manualDiskConfig } from "./disk-config"
import type { Answers } from "./answers"

export interface LocaleConfig {
  kb_layout: string
  sys_enc: string
  sys_lang: string
}

export interface LiveDefaults {
  hostname: string
  timezone: string
  localeConfig: LocaleConfig
}

export interface ArchinstallUser {
  username: string
  sudo: boolean
  enc_password: string
}

export interface ArchinstallCreds {
  users: ArchinstallUser[]
}

export interface AssembledPlan {
  config: BaseConfig
  creds: ArchinstallCreds
}

/**
 * Hashes a plaintext password using sha512 crypt (`openssl passwd -6`).
 * Plaintext is piped over stdin and never stored on disk.
 */
export function hashPassword(password: string): string {
  const proc = Gio.Subprocess.new(
    ["openssl", "passwd", "-6", "-stdin"],
    Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
  )
  const [ok, out] = proc.communicate_utf8(password + "\n", null)
  if (!ok || !proc.get_successful() || !out) {
    throw new Error("Failed to generate password hash with openssl")
  }
  return out.trim()
}

/**
 * Reads live session defaults (timezone, locale, keymap, hostname).
 *
 * Cached: three synchronous subprocesses, and on the only medium where the
 * installer is armed they can only ever return the same three values — the ISO
 * generates `en_US.UTF-8` and nothing else, symlinks /etc/localtime to UTC, and
 * Hyprland's kb_layout defaults to `us`. It was being called once per step
 * factory and again on every map and every language change of the summary.
 */
let _liveDefaults: LiveDefaults | null = null

export function getLiveDefaults(): LiveDefaults {
  if (_liveDefaults) return _liveDefaults
  let timezone = "UTC"
  try {
    const tz = exec(["timedatectl", "show", "-p", "Timezone", "--value"]).trim()
    if (tz) timezone = tz
  } catch {}

  let sysLang = "en_US"
  let sysEnc = "UTF-8"
  let kbLayout = "us"

  try {
    const raw = exec(["localectl", "status"])
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("System Locale:")) {
        const match = /LANG=([a-zA-Z0-9_]+)(?:\.([a-zA-Z0-9_-]+))?/.exec(trimmed)
        if (match) {
          sysLang = match[1]
          if (match[2]) sysEnc = match[2]
        }
      } else if (trimmed.startsWith("VC Keymap:")) {
        const match = /VC Keymap:\s+([a-zA-Z0-9_-]+)/.exec(trimmed)
        if (match && match[1] !== "(unset)") {
          kbLayout = match[1]
        }
      } else if (trimmed.startsWith("X11 Layout:") && kbLayout === "us") {
        const match = /X11 Layout:\s+([a-zA-Z0-9_-]+)/.exec(trimmed)
        if (match && match[1] !== "(unset)") {
          kbLayout = match[1]
        }
      }
    }
  } catch {
    const langEnv = GLib.getenv("LANG")
    if (langEnv) {
      const match = /([a-zA-Z0-9_]+)(?:\.([a-zA-Z0-9_-]+))?/.exec(langEnv)
      if (match) {
        sysLang = match[1]
        if (match[2]) sysEnc = match[2]
      }
    }
  }

  let hostname = "nidara"
  try {
    const h = exec(["hostname"]).trim()
    if (h && h !== "archiso" && h !== "localhost") {
      hostname = h
    }
  } catch {}

  _liveDefaults = {
    hostname,
    timezone,
    localeConfig: {
      kb_layout: kbLayout,
      sys_enc: sysEnc,
      sys_lang: sysLang,
    },
  }
  return _liveDefaults
}

/**
 * Assembles the full plan from base.json + answers + live defaults.
 * Rewrites SUDO_USER in custom_commands with the selected user account.
 */
export function assemblePlan(
  answers: Answers,
  baseResult: BaseConfigResult | null = readBaseConfig(),
): AssembledPlan {
  if (!baseResult) {
    throw new Error("Cannot assemble plan: base.json is missing or invalid")
  }
  if (!answers.account) {
    throw new Error("Cannot assemble plan: user account is not configured")
  }

  const live = getLiveDefaults()
  const account = answers.account
  const username = account.username

  // Deep copy base config
  const config: BaseConfig = JSON.parse(JSON.stringify(baseResult.config))

  config.hostname = account.hostname?.trim() || live.hostname || "nidara"
  config.timezone = answers.timezone?.timezone || live.timezone
  config.locale_config = {
    // The CONSOLE keymap, not the xkb layout. archinstall's `kb_layout` ends up in
    // /etc/vconsole.conf, and the two namespaces disagree for four of our rows —
    // see the `keymap` field on KeyboardLayout in lib/region.ts for what that costs.
    kb_layout: answers.keyboard?.keymap || live.localeConfig.kb_layout,
    sys_enc: answers.language?.sysEnc || live.localeConfig.sys_enc,
    sys_lang: answers.language?.sysLang || live.localeConfig.sys_lang,
  }

  // Rewrite SUDO_USER in custom_commands so the first-boot setup runs for the chosen user
  const originalCommands = Array.isArray(config.custom_commands)
    ? (config.custom_commands as string[])
    : []

  config.custom_commands = originalCommands.map(cmd => {
    return cmd.replace(/\bSUDO_USER=[a-zA-Z0-9_-]+/, `SUDO_USER=${username}`)
  })

  // ── Who owns the disk, and it is no longer us ─────────────────────────────
  //
  // Both modes now hand archinstall the layout and let it partition, format and
  // mount: the same numbers we used to run by hand, written in its schema (see
  // lib/disk-config.ts). `pre_mounted_config` is gone, and with it the last
  // reason for `steps/run.ts` to touch a disk — a plan that describes a layout
  // while our own partitioner also ran would write the disk twice, ours first
  // and archinstall's over the top (#310).
  if (answers.disk?.mode === "entire_disk") {
    config.disk_config = entireDiskConfig(answers.disk)
  } else if (answers.disk) {
    config.disk_config = manualDiskConfig(answers.disk)
  }

  // ── Root is left as Arch leaves it, and that is a decision ────────────────
  //
  // No `root_enc_password`. archinstall only touches root when that field is
  // present (`scripts/guided.py`), so omitting it means the account keeps what
  // `filesystem` ships in /etc/shadow — measured: `root:*:14871::::::`, an
  // asterisk no password can ever match. The person administers with sudo, and
  // recovery is the live medium we already hand out.
  //
  // What it replaces was never chosen: root carried the SAME hash as the user, so
  // whoever knew that password had a root console without passing through sudo —
  // one credential doing two jobs, silently. Ubuntu and Fedora both lock root and
  // give sudo instead; this is that, and it is also plain Arch's own default.
  const creds: ArchinstallCreds = {
    users: [
      {
        username,
        sudo: true,
        enc_password: hashPassword(account.password),
      },
    ],
  }

  // Dump support for debugging/inspection
  const dumpPath = GLib.getenv("NIDARA_INSTALLER_DUMP")
  if (dumpPath) {
    try {
      GLib.file_set_contents(dumpPath, JSON.stringify(config, null, 2) + "\n")
      console.log(`[installer] Assembled plan dumped to ${dumpPath}`)
    } catch (e) {
      console.error(`[installer] Failed to dump plan to ${dumpPath}:`, e)
    }
  }

  return { config, creds }
}
