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
export function connectivity(): Promise<Connectivity> {
  return execAsync(["nmcli", "-t", "networking", "connectivity"])
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
