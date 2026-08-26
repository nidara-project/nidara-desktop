// Assembles the final installation plan from base.json + user answers + live session defaults.
//
// Generates the JSON configuration consumed by archinstall and the credentials object
// consumed via `--creds`. Passwords are hashed with `openssl passwd -6` before
// being placed in the credentials object.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { exec } from "../../lib/process"
import { readBaseConfig, type BaseConfigResult, type BaseConfig } from "./base-config"
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
  root_enc_password: string
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
 */
export function getLiveDefaults(): LiveDefaults {
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

  return {
    hostname,
    timezone,
    localeConfig: {
      kb_layout: kbLayout,
      sys_enc: sysEnc,
      sys_lang: sysLang,
    },
  }
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

  config.hostname = live.hostname
  config.timezone = answers.timezone?.timezone || live.timezone
  config.locale_config = {
    kb_layout: answers.keyboard?.layout || live.localeConfig.kb_layout,
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

  // TODO(T6): disk_config is generated dynamically on the target machine by archinstall / gen-disk.py

  const encPassword = hashPassword(account.password)
  const creds: ArchinstallCreds = {
    users: [
      {
        username,
        sudo: true,
        enc_password: encPassword,
      },
    ],
    root_enc_password: encPassword,
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
