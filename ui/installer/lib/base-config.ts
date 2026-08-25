// The product half of the archinstall config, and the only thing this bundle
// reads from outside itself.
//
// ─── WHY THIS IS A FILE AND NOT CONSTANTS IN THIS REPO ───────────────────────
// Two different questions have two different owners. WHAT Nidara installs — the
// package list, the commands that trust the repo key and run nidara-setup — is a
// product decision and lives in nidara-iso, shipped as airootfs content at the
// path below. HOW somebody is asked about it is this bundle. Keeping them apart
// is what lets the app list change without rebuilding an installer, and what
// keeps this code from hardcoding a single product decision.
//
// The disk is the third owner and it is neither of these: it is computed on the
// machine, by archinstall's own library, because its schema wants absolute byte
// counts of the disk in front of it. See nidara-iso/installer-prototype.

import GLib from "gi://GLib"

/** Where the medium ships it. `./base.json` is the development fallback. */
const CANDIDATES = [
  "/usr/share/nidara-installer/base.json",
  "./base.json",
]

export interface BaseConfig {
  /** archinstall's config, product half — passed through, never interpreted here. */
  [key: string]: unknown
}

export interface BaseConfigResult {
  config: BaseConfig
  path: string
}

/**
 * Read the product's base config, or return null when there is none.
 *
 * Null is not an error to swallow: it means this is not a Nidara medium (a
 * developer's desktop, a machine where the ISO-only file was never installed),
 * and the installer has to say so rather than offer to install from a config it
 * invented. The window shows that state instead of a first step.
 */
export function readBaseConfig(): BaseConfigResult | null {
  for (const path of CANDIDATES) {
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) continue
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      const config = JSON.parse(new TextDecoder().decode(data as Uint8Array)) as BaseConfig
      return { config, path }
    } catch (e) {
      // A present-but-broken file is worth a line in the log: it is the one
      // failure that looks exactly like "not a Nidara medium" from the outside.
      console.error(`[installer] ${path} exists but could not be parsed:`, e)
    }
  }
  return null
}

/** The packages the base config says this product installs, for display. */
export function basePackages(config: BaseConfig): string[] {
  const commands = Array.isArray(config.custom_commands) ? config.custom_commands as string[] : []
  const named = new Set<string>()
  for (const cmd of commands) {
    // The trust model puts the repo's packages in custom_commands rather than in
    // `packages`, because they need the signing key in the TARGET keyring and
    // archinstall installs its package list before anything can import one
    // there. So the honest place to read what this medium installs is the
    // command line that installs it.
    const match = /pacman -S(?:y)?\s+--noconfirm\s+([^;'"]+)/.exec(cmd)
    if (!match) continue
    for (const word of match[1].trim().split(/\s+/)) {
      // Flags and their path arguments are not packages: this same line carries
      // `--overwrite /etc/os-release`, which is required the first time
      // nidara-release lands (systemd's tmpfiles owns that path until we do).
      if (word.startsWith("-") || word.startsWith("/")) continue
      named.add(word)
    }
  }
  const listed = Array.isArray(config.packages) ? config.packages as string[] : []
  for (const p of listed) named.add(p)
  return [...named]
}
