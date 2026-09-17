// stall-probe — when does the install page say it is waiting for the network,
// and when does a failed install say the network is why?
//
//   ./scripts/bundle.sh --js scripts/dev/stall-probe.ts /tmp/stall-probe.js && gjs -m /tmp/stall-probe.js
//
// No network, no archinstall. The rules live in lib/stall.ts. The costly
// mistakes, in order: warning during the desktop download — archinstall prints
// NOTHING for minutes while ~1.5 GB arrives, so silence alone must never count —
// and blaming the network for a failure that had nothing to do with it, which
// sends the person to fix a connection that works.
//
// The failure lines are copied from a real run (VM, 2026-09-17, link cut during
// the install), not written to fit the patterns.

import {
  STALL_IDLE_BYTES, STALL_QUIET_MS, failedDownloading, looksStalled,
} from "../../ui/installer/lib/stall"

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) print(`   ok           ${name}`)
  else { failures++; print(`   ✗ ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`) }
}

const MIN = 60 * 1000
const MB = 1024 * 1024

print("\nlooksStalled")
check("quiet for 5 min, nothing arriving → ask the connection",
  looksStalled({ sinceLastLineMs: 5 * MIN, downloadedInWindow: 2000 }), true)
check("silent desktop download: no line for 10 min, 40 MB arriving → not a stall",
  looksStalled({ sinceLastLineMs: 10 * MIN, downloadedInWindow: 40 * MB }), false)
check("slow link, still moving: 300 KiB in the window → not a stall",
  looksStalled({ sinceLastLineMs: 10 * MIN, downloadedInWindow: 300 * 1024 }), false)
check("idle network but the child just printed → not a stall",
  looksStalled({ sinceLastLineMs: 30 * 1000, downloadedInWindow: 0 }), false)
check("exactly the quiet window, exactly under the idle floor → ask",
  looksStalled({ sinceLastLineMs: STALL_QUIET_MS, downloadedInWindow: STALL_IDLE_BYTES - 1 }), true)
check("one ms short of the quiet window → not yet",
  looksStalled({ sinceLastLineMs: STALL_QUIET_MS - 1, downloadedInWindow: 0 }), false)
check("exactly the idle floor counts as traffic",
  looksStalled({ sinceLastLineMs: STALL_QUIET_MS, downloadedInWindow: STALL_IDLE_BYTES }), false)

print("\nfailedDownloading")
const LINK_CUT = [
  "archinstall.lib.exceptions.SysCallError: ['/usr/bin/arch-chroot', '-S', '/mnt', 'bash', '/var/tmp/user-command.3.sh'] exited with abnormal exit code [1]:  to downloaderror: failed retrieving file 'nidara-release-2-1-any.pkg.tar.zst' from nidara-project.github.io : Could not resolve host: nidara-project.github.io",
  "warning: fatal error from nidara-project.github.io, skipping for the remainder of this transaction",
  "error: failed to commit transaction (invalid url for server)",
]
check("the real link-cut failure → network", failedDownloading(LINK_CUT), true)
// The stalled run: 345 of these, then the sync gave up (same VM, HTTP/HTTPS dropped).
check("the real stalled-download failure → network", failedDownloading([
  "error: failed retrieving file 'core.db' from es.mirrors.cicku.me : Connection timed out after 10000 milliseconds",
  "warning: too many errors from es.mirrors.cicku.me, skipping for the remainder of this transaction",
  "error: failed to synchronize all databases (unexpected error)",
  "==> ERROR: Failed to install packages to new root",
]), true)
// Not the network, and they must not be blamed on it.
check("a retry dying on a swap still in use → not network",
  failedDownloading(["archinstall.lib.exceptions.SysCallError: ['/usr/bin/umount', '-R', '[SWAP]'] exited with abnormal exit code [32]: umount: [SWAP]: not mounted."]), false)
check("a package conflict → not network",
  failedDownloading(["error: failed to commit transaction (conflicting files)", "nidara-release: /etc/os-release exists in filesystem"]), false)
check("a traceback with no download in it → not network",
  failedDownloading(["Traceback (most recent call last):", "archinstall.lib.exceptions.DiskError: Partition /dev/vda2 not found"]), false)

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)
