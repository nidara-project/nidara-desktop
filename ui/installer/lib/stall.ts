// Has the install stopped moving because the network did?
//
// Measured in a VM on 2026-09-17, two ways of losing the network mid-install that
// look nothing alike from the page:
//
// - The link goes away entirely → pacman fails within about a minute with
//   `Could not resolve host`, archinstall prints a traceback, and the page said
//   "An error occurred during installation" — nothing about the network.
// - The link stays up and nothing arrives (HTTP/HTTPS dropped, DNS still
//   answering: a weak Wi-Fi, a portal) → `pacman -Sy` sat on
//   `:: Synchronizing package databases...` for 20 minutes with no output and no
//   error, under a page that still said "Installing the base system".
//
// What pacman was doing in that silence: trying the medium's mirrorlist — 431
// servers — one after another, 10 s each (`Connection timed out after 10000
// milliseconds`, 345 of them), marking each "skipping for the remainder of this
// transaction". archinstall passes none of that through until pacstrap returns.
// The connection came back after 20 minutes, which was too late: the list ran out
// four minutes later and the install failed with `failed to synchronize all
// databases`.
//
// Nor did it recover when the connection came back sooner: restored 108 s into a
// stall during the PACKAGE download, the page's warning went away 17 s later and
// the install still failed — the mirrors that timed out were already skipped, and
// the ones left answered the resumed `.part` downloads with HTTP 416. Not once, in
// four runs, did a stalled install finish.
//
// So the page does not promise a recovery. It says what is happening — the
// connection stopped answering, the download is stuck — and what to do: check it,
// and start again if the install stops. Nothing here kills archinstall either: it
// ends on its own, and the failure text (`failedDownloading`) then names the
// network instead of a traceback.
//
// ⚠️ "No output" alone is NOT a stall. archinstall runs the desktop's
// `pacman -Sy nidara-desktop …` as a custom command and prints nothing until it
// returns — 56 s on a fast VM link, many minutes for ~1.5 GB on a slow one. The
// rule therefore also requires download progress to be nil, and the page only speaks
// after NetworkManager, asked afresh, says the connection is not usable. A slow
// but working download grows pacman's download directories; a quiet local step
// (mkinitcpio, unpacking) has a working connection.
//
// ⚠️ Growth of the DOWNLOAD directories, not bytes received on the interface. The
// interface counter was the first version and it failed in the VM: the harness's
// own SSH reads, a few KiB every few seconds, crossed the idle floor and switched
// the warning off every other minute — and a real machine has the same kind of
// background chatter. `.part` files under the target's pacman cache and sync
// directories only grow when pacman is receiving.

/**
 * How long without a line AND without download progress before the connection is
 * asked.
 *
 * One minute, and it was two until it was measured. A stall during the PACKAGE
 * download fails on its own about three minutes in — pacman marks each mirror
 * "skipping for the remainder" after a few timeouts, and archinstall's retries
 * of pacstrap then fail on the database sync at once — so a two-minute window,
 * plus the 20 s tick and NetworkManager's own check, put the warning on screen
 * at 181-183 s, next to the failure (VM, twice). A stall during the DATABASE sync
 * ran past 20 minutes. One minute serves both; the connection check, not the
 * window, is what keeps a quiet local step from warning.
 */
export const STALL_QUIET_MS = 60 * 1000

/**
 * Below this much growth of the download directories over the quiet window,
 * nothing counts as arriving. Not zero, so a file touched in passing is not
 * progress; a real download grows them by megabytes a minute.
 */
export const STALL_IDLE_BYTES = 256 * 1024

/**
 * Where pacman writes what it downloads during an install: the target's package
 * cache (pacstrap's and the desktop's custom command alike, the latter from inside
 * the chroot) and its sync databases.
 */
export const DOWNLOAD_DIRS = ["/mnt/var/cache/pacman/pkg", "/mnt/var/lib/pacman/sync"]

export interface StallSample {
  /** Milliseconds since archinstall last printed a line. */
  sinceLastLineMs: number
  /** Growth, in bytes, of DOWNLOAD_DIRS over the last STALL_QUIET_MS. */
  downloadedInWindow: number
}

/** True when the install is quiet enough that the connection should be asked. */
export function looksStalled(s: StallSample): boolean {
  return s.sinceLastLineMs >= STALL_QUIET_MS && s.downloadedInWindow < STALL_IDLE_BYTES
}

/**
 * The lines by which a failed install says it could not download. pacman's own
 * words, and curl's inside them; matched on the child's output, never on ours.
 */
const DOWNLOAD_FAILURE = [
  /Could not resolve host/,
  /failed retrieving file/,
  /failed to synchronize all databases/,
  /Connection timed out after/,
  /Failed to connect to .* port \d+/,
]

/** Whether a failed run's output shows it died downloading, not on something else. */
export function failedDownloading(lines: string[]): boolean {
  return lines.some(l => DOWNLOAD_FAILURE.some(re => re.test(l)))
}
