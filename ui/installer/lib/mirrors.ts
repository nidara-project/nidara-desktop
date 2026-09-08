// Which mirrors this machine should download from, measured rather than guessed.
//
// `mirror_config` went out empty — no regions, no servers — so every install
// pulled `base`, the kernel and the firmware from whatever `/etc/pacman.d/
// mirrorlist` the medium happened to boot with. That is the biggest speed lever
// in the install and nobody was pulling it (#311).
//
// ─── WHY reflector AND NOT archinstall'S OWN SORTING ─────────────────────────
// archinstall accepts `mirror_regions` and advertises that it sorts them by
// speed — `MirrorConfiguration.regions_config(..., speed_sort=True)`. Read what
// that sorts by and the word means something else: `mirror_handler.py:82` sorts
// on `mirror.speed`, a field that arrives inside `https://archlinux.org/mirrors/
// status/json/`. It is the speed the Arch project measured **from its own
// probes**, not from this machine. A mirror that is fast for the archweb host
// can be the slow one from a flat in Vigo.
//
// `reflector --sort rate` downloads a real file from each candidate and ranks
// what it actually got. That is a measurement, and it is why the decision on
// #311 says measure rather than geolocate.
//
// ─── WHERE THE RESULT LANDS, AND WHY custom_servers IS THE RIGHT KEY ─────────
// `installer.py:600-607` PREPENDS `custom_servers` to the mirrorlist and leaves
// what was there underneath. So five measured servers go on top and the medium's
// own list survives as the fallback — if all five are unreachable by the time
// pacstrap runs, pacman walks down to the rest instead of failing. Writing
// `mirror_regions` instead would REPLACE the file (`installer.py:599`), and with
// the sorting above that would be a worse list, chosen more confidently.
//
// It is applied to the live system BEFORE `minimal_installation()` pacstraps
// (`scripts/guided.py:100-103`), which is what makes this affect the download
// everybody waits for and not just the installed machine's config file.

import Gio from "gi://Gio"
import GLib from "gi://GLib"

/** How many servers to ask reflector for. */
const WANT_SERVERS = 5

/**
 * Below this, a country-narrowed run is treated as too thin to stand on its own
 * and the worldwide run is done as well.
 *
 * ⚠️ It is not a quality bar, it is a redundancy one. `custom_servers` are
 * prepended and the medium's list survives underneath, so a short list is never
 * fatal — but a country with one mirror gives a machine one server to pacstrap
 * 548 packages from, and if it is down mid-install the person waits for every
 * retry before pacman gives up on it.
 */
const MIN_SERVERS = 3

/**
 * How long the whole measurement may take before the install goes on without it.
 *
 * Measured on 2026-09-08, on a home connection, against the real mirror list:
 *
 *     --country ES   4.5 s   (4 servers — Spain has four recently-synced https mirrors)
 *     no country    27.6 s   (5 servers, out of the 20 most recently synced worldwide)
 *
 * 45 s covers a narrowed run plus the worldwide fallback with room to spare, on
 * a connection slower than the one that produced those numbers. Past it the
 * install proceeds with the medium's mirrorlist, which is exactly what every
 * install did before this file existed — the failure mode is "no faster", never
 * "no install".
 */
export const MIRROR_BUDGET_MS = 45_000

/**
 * The reflector invocation for a country, or worldwide when `country` is null.
 *
 * ⚠️ `--latest` is applied AFTER `--country`, so the two numbers do different
 * jobs: worldwide it takes the 20 most recently synced anywhere and rate-tests
 * those; narrowed it usually takes every mirror the country has. That asymmetry
 * is the point — the country ACOTA, it does not decide, which is the same rule
 * the region page follows for timezones and locales.
 *
 * `--protocol https` because the target's mirrorlist is going to outlive this
 * install, and `--connection-timeout`/`--download-timeout` because a mirror that
 * hangs must cost seconds and not the whole budget.
 */
export function reflectorArgs(country: string | null): string[] {
  return [
    "reflector",
    "--protocol", "https",
    ...(country ? ["--country", country] : []),
    "--latest", "20",
    "--sort", "rate",
    "--number", String(WANT_SERVERS),
    "--connection-timeout", "3",
    "--download-timeout", "8",
  ]
}

/**
 * The server URLs in a reflector mirrorlist, in the order it ranked them.
 *
 * ⚠️ Everything else in that output is a comment, INCLUDING the header, and the
 * header contains the word `Server` inside a sentence. Matching on the line
 * shape (`Server = <url>`, optional leading blanks) rather than on the word is
 * what keeps a comment out of a pacman config file.
 *
 * A commented-out `#Server = …` is deliberately NOT accepted: that is how the
 * stock `pacman-mirrorlist` ships every entry, and reading those would turn "no
 * measurement happened" into "here are 400 servers in alphabetical order".
 */
export function parseServers(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split("\n")) {
    const m = /^\s*Server\s*=\s*(\S+)\s*$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

/** Run one reflector, resolving to its stdout, or to "" for any failure at all. */
function runReflector(args: string[], deadline: number): Promise<string> {
  return new Promise(resolve => {
    let proc: Gio.Subprocess
    try {
      proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
    } catch {
      // No reflector on this medium. It is in `packages.x86_64`, but a bundle
      // that assumes its own medium is how a missing package becomes a crash.
      resolve("")
      return
    }

    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    // ⚠️ The subprocess is KILLED, not merely abandoned. Letting it run past the
    // deadline leaves a process racing pacstrap for the same mirrors, on a
    // machine where the install is about to want all the bandwidth there is.
    // ⚠️ Rounded, and to an INTEGER of milliseconds: `GLib.get_monotonic_time()`
    // is microseconds, and `timeout_add` takes a guint — a fractional interval
    // is not a shorter wait, it is an argument of the wrong type.
    const budget = Math.max(0, Math.round(deadline - GLib.get_monotonic_time() / 1000))
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, budget, () => {
      if (!settled) proc.force_exit()
      finish("")
      return GLib.SOURCE_REMOVE
    })

    proc.communicate_utf8_async(null, null, (_: any, res: any) => {
      GLib.source_remove(timer)
      try {
        const [, stdout] = proc.communicate_utf8_finish(res)
        // ⚠️ A country with no mirrors exits 1 with an EMPTY stdout and
        // `error: no mirrors found` on stderr — measured with `--country BO`.
        // So the exit code is checked, and the empty answer it goes with is the
        // one that makes the caller try again without the country.
        finish(proc.get_successful() ? (stdout ?? "") : "")
      } catch {
        finish("")
      }
    })
  })
}

/**
 * The mirrors this machine measured as fastest, best first. `[]` means the
 * measurement did not happen, and `[]` is a complete answer: the plan then sends
 * no `custom_servers` and the medium's mirrorlist is used exactly as before.
 *
 * The country only narrows the field. If it yields fewer than `MIN_SERVERS` —
 * or if the country has no mirrors at all, which is most of them — the worldwide
 * run happens too and its results go on the end, so a thin country list is
 * backed by measured servers rather than by nothing.
 */
export async function measureMirrors(
  country: string | null,
  budgetMs: number = MIRROR_BUDGET_MS,
): Promise<string[]> {
  const deadline = GLib.get_monotonic_time() / 1000 + budgetMs

  const local = country ? parseServers(await runReflector(reflectorArgs(country), deadline)) : []
  if (local.length >= MIN_SERVERS) return local

  const worldwide = parseServers(await runReflector(reflectorArgs(null), deadline))

  // The country's own mirrors keep their place at the top even when there were
  // too few of them: they were measured on this machine too, and the second run
  // is here to give pacman somewhere to fall to, not to overrule the first.
  const seen = new Set(local)
  return [...local, ...worldwide.filter(u => !seen.has(u))]
}
