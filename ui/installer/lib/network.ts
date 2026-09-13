// Is there a usable connection right now?
//
// The installer cannot finish without one and never asked: archinstall pacstraps
// from the Arch mirrors, base.json's custom_commands `curl` the repo signing key
// and then `pacman -Sy` three packages out of nidara-repo. A laptop that never
// joined a Wi-Fi network used to get all the way to a partitioned disk and fail
// in the middle of the install, with the log folded shut behind an expander.
//
// NetworkManager is on the medium and already answers exactly this question —
// including the captive-portal case, which a plain ping cannot tell from success.
// `nmcli networking connectivity` is one of: full, limited, portal, none, unknown.

import { execAsync } from "../../lib/process"

export type Connectivity = "full" | "limited" | "portal" | "none" | "unknown"

/**
 * Resolves to the current connectivity. Never rejects: a medium without
 * NetworkManager, or with its connectivity check switched off, answers
 * "unknown" — and "unknown" is deliberately treated as fine everywhere.
 *
 * ⚠️ Do not turn "unknown" into a warning. Arch ships NetworkManager's
 * connectivity check pointing at a Fedora URL that plenty of networks block, and
 * a warning that fires on a working connection teaches people to click past the
 * one that matters.
 */
export function connectivity(opts: { fresh?: boolean } = {}): Promise<Connectivity> {
  // ⚠️ Without `check`, nmcli answers NetworkManager's LAST result, which it only
  // refreshes every so often. Measured, 2026-09-14 VM: the internet cut off a few
  // seconds before Install, the run step read the cached "full", archinstall
  // started — and sat in `pacman -Sy` for 15 minutes behind "Preparing the disk".
  // `check` makes NetworkManager ask again, now, and waits for the answer. It is
  // a request to ping.archlinux.org, so it is for the one moment that decides
  // whether to start (the run step), not for a page polling every few seconds.
  return execAsync(["nmcli", "-t", "networking", "connectivity", ...(opts.fresh ? ["check"] : [])])
    .then(out => {
      const v = out.trim().toLowerCase()
      return (["full", "limited", "portal", "none", "unknown"].includes(v)
        ? v
        : "unknown") as Connectivity
    })
    .catch(() => "unknown" as Connectivity)
}

/** Everything except a connection we know is unusable. */
export function isUsable(c: Connectivity): boolean {
  return c === "full" || c === "unknown"
}
