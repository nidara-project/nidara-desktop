// Does the archinstall on THIS medium accept the configuration this medium
// ships? Asked once, at the welcome page, and long before anything is erased.
//
// ─── WHY IT IS ASKED AT ALL ──────────────────────────────────────────────────
// nidara-iso's `packages.x86_64` names `archinstall` with no version, so an
// image takes whatever was current the day it was built. The live session cannot
// make it drift afterwards — squashfs, no `-Syu` — so the medium in front of the
// user carries one fixed pair, and the only question is whether the two halves
// of it agree. nidara-iso's `check-base-config.sh` asks that at build time and
// refuses to hand over an image that fails; this is the same question asked
// again by the program that will act on the answer, which covers the image built
// before that gate existed and the medium somebody modified.
//
// The cost of not asking is specific, not theoretical: `steps/run.ts` partitions
// and mounts BEFORE it hands the plan to archinstall. A configuration archinstall
// refuses is therefore not a failed install — it is a wiped disk followed by a
// refusal, on a machine that had an operating system five minutes earlier. That
// is the point of no return this check sits in front of.
//
// ─── WHAT IT DOES NOT DO, AND WHY ────────────────────────────────────────────
// It does not check that archinstall READ every key it was given. It cannot see
// that from here: archinstall reads its config with `args_config.get(key,
// default)`, so a key it no longer knows is skipped in silence and `--dry-run`
// still exits 0. What catches that is reading back the configuration archinstall
// saves for itself (/var/log/archinstall/user_configuration.json, root-owned and
// 0640) and comparing it with what went in — which is exactly what the build
// gate does, with root and with both files in front of it. Splitting it that way
// is deliberate: the strict check belongs where a bad pair can still be stopped
// from shipping, and this one is the last line, not the first.

import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { readBaseConfig } from "./base-config"
import { isPreview } from "./preview"

export type ArchinstallVerdict =
  /** archinstall accepted the config, and its version is the declared one. */
  | { kind: "ok", version: string }
  /** Not an installation medium: there is nothing here to check. */
  | { kind: "skipped" }
  /** No archinstall at all. Nothing can be installed. */
  | { kind: "missing" }
  /** archinstall refused the configuration. An install would stop mid-way. */
  | { kind: "rejected", detail: string }
  /** It accepts the config, but it is not the version base.json declares. */
  | { kind: "mismatch", found: string, declared: string }
  /** The check itself could not run. Advisory only — never blocks. */
  | { kind: "unknown", detail: string }

/**
 * Run a command, and answer with its exit status and its whole output.
 *
 * `execAsync` cannot be used here: it rejects with STDERR only, and archinstall
 * prints its refusals through its own logger, which goes to stdout. The reason a
 * config was refused would be thrown away by the very call that reports it.
 */
function run(argv: string[], timeoutMs: number): Promise<{ ok: boolean, output: string }> {
  return new Promise(resolve => {
    let proc: Gio.Subprocess
    try {
      proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
      )
    } catch (e: any) {
      resolve({ ok: false, output: `${e?.message ?? e}` })
      return
    }

    // A hung child must not leave the page waiting for an answer that is never
    // coming. `force_exit` makes `communicate_utf8_async` return, so the callback
    // below is what resolves the promise in both directions.
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
      try { proc.force_exit() } catch {}
      return GLib.SOURCE_REMOVE
    })

    proc.communicate_utf8_async(null, null, (_src, res) => {
      GLib.source_remove(timer)
      try {
        const [, out] = proc.communicate_utf8_finish(res)
        resolve({ ok: proc.get_successful(), output: (out ?? "").trim() })
      } catch (e: any) {
        resolve({ ok: false, output: `${e?.message ?? e}` })
      }
    })
  })
}

/** `archinstall 4.4` → `4.4`. Anything else answers null rather than a guess. */
function parseVersion(out: string): string | null {
  const m = /^archinstall\s+(\S+)/m.exec(out)
  return m ? m[1] : null
}

/**
 * Force one of the three warning states, for looking at them.
 *
 * ⚠️ This env variable only ever points the SAFE way — the same rule
 * `NIDARA_INSTALLER_DRY_RUN` follows in steps/run.ts. It can produce a warning
 * and it can hold the flow shut; it cannot produce `ok`, cannot clear a real
 * verdict and cannot arm anything. So the worst a typo in it can do is refuse to
 * install. Without it the three states are unreachable outside a medium whose
 * archinstall is genuinely broken, which is not a thing anyone can arrange.
 */
function forcedVerdict(): ArchinstallVerdict | null {
  switch (GLib.getenv("NIDARA_INSTALLER_FAKE_ARCHINSTALL")) {
    case "missing": return { kind: "missing" }
    case "rejected": return { kind: "rejected", detail: "NIDARA_INSTALLER_FAKE_ARCHINSTALL=rejected" }
    case "mismatch": return { kind: "mismatch", found: "9.9", declared: "4.4" }
    default: return null
  }
}

async function probe(): Promise<ArchinstallVerdict> {
  const forced = forcedVerdict()
  if (forced) return forced

  // ⚠️ Preview never runs archinstall, and that is a rule rather than a
  // detail: the preview banner's whole job is that a screenshot of it cannot be
  // mistaken for an install, and "it is only a dry run" is the exact reasoning
  // that once had the installer touching disks. The probe below is read-only by
  // construction; it still does not run here. Use the variable above to look at
  // what this page does with each answer.
  if (isPreview()) return { kind: "skipped" }

  // ⚠️ The same test `steps/run.ts` arms the install with, and for the same
  // reason. Off the medium there is no archinstall and no passwordless sudo, so
  // running this on a developer's desktop would report "missing" and hold the
  // flow shut on every preview — a check that fires where it cannot be true.
  if (!GLib.file_test("/run/archiso", GLib.FileTest.EXISTS)) return { kind: "skipped" }

  const base = readBaseConfig()
  // No base.json is already the welcome page's own blocking state; this check
  // has nothing to validate against and stays quiet rather than saying it twice.
  if (!base) return { kind: "skipped" }

  if (!GLib.find_program_in_path("archinstall")) return { kind: "missing" }

  const declared = typeof base.config.version === "string" ? base.config.version : null

  // `--version` is argparse's own action: it prints and exits before archinstall
  // looks at a config or at who is running it, so this needs no root.
  const ver = await run(["archinstall", "--version"], 15000)
  const found = ver.ok ? parseVersion(ver.output) : null

  // ⚠️ `--offline` is what keeps the answer about the CONFIG. Without it
  // archinstall probes connectivity, fetches the package database and checks for
  // a newer release of itself before it ever reads the file — so a medium on a
  // captive-portal network would report the configuration as broken. The welcome
  // page asks about the network separately, and says so in its own words.
  const isRoot = GLib.get_user_name() === "root"
  const argv = [
    ...(isRoot ? [] : ["sudo", "-n"]),
    "archinstall", "--config", base.path, "--silent", "--dry-run", "--offline",
  ]
  const dry = await run(argv, 60000)

  if (!dry.ok) {
    console.error(`[installer] archinstall refused ${base.path}:\n${dry.output}`)
    return { kind: "rejected", detail: dry.output }
  }

  if (found && declared && found !== declared) {
    console.warn(`[installer] archinstall ${found} accepted ${base.path}, which declares ${declared}`)
    return { kind: "mismatch", found, declared }
  }
  if (!found) return { kind: "unknown", detail: ver.output }

  return { kind: "ok", version: found }
}

let _pending: Promise<ArchinstallVerdict> | null = null
let _verdict: ArchinstallVerdict | null = null

/**
 * The answer, computed once per run.
 *
 * Once, because it cannot change: the medium is read-only and the configuration
 * on it is the same file every time. The welcome page is re-entered whenever
 * somebody walks back to it, and re-running a subprocess on every visit would
 * cost seconds to re-learn a constant.
 */
export function checkArchinstall(): Promise<ArchinstallVerdict> {
  if (!_pending) {
    _pending = probe().then(v => {
      _verdict = v
      return v
    })
  }
  return _pending
}

/**
 * What is known right now, or null while the first check is still running.
 *
 * ⚠️ Null does NOT block. A page whose Continue button is dead for the two
 * seconds a subprocess takes to start Python teaches people that the button is
 * broken; a verdict that arrives late still arrives three pages before the disk.
 */
export function archinstallVerdict(): ArchinstallVerdict | null {
  return _verdict
}

/** Whether this verdict means an install cannot be attempted at all. */
export function blocksInstall(v: ArchinstallVerdict | null): boolean {
  return v?.kind === "missing" || v?.kind === "rejected"
}
