// How far the install has got, read from what it prints — pure, no GTK, no disk.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Until 2026-09-23 the run page had four phases and a bar that moved in quarters,
// and the longest wait of the whole install sat inside the third: the phase said
// "Installing the base system" while it was in fact installing the DESKTOP (477
// packages, 855 MiB measured on the 09-22 clean install), and the one moving line
// under it read `Executing custom command "set -o pipefail; …` for all of it. The
// owner called the page poor, and it was poor because it said nothing true.
//
// Both halves have real numbers, and neither is a guess (the desktop begins when
// COMMAND_LOG appears in the target — see `isPlumbing` for why not a stdout line):
//
//   base     archinstall runs pacstrap on a pty, so its STDOUT (what the run page
//            reads) carries pacman's counters: ` Total ( 12/158) …` while it
//            downloads and `( 40/158) installing foo` while it installs.
//   desktop  a custom command; archinstall keeps its output to itself, and ours
//            is teed to COMMAND_LOG (lib/command-log.ts). pacman writes there with
//            no tty — one ` foo-1.2-1-x86_64 downloading...` per package after
//            `Packages (N)`, and NO per-package line while installing. So the
//            install half is counted where pacman itself keeps count: one
//            directory per installed package under the target's
//            /var/lib/pacman/local. The caller counts; this file does the sums.
//
// ⚠️ The overall percentage is the only estimate here, and it is WEIGHTED, not
// measured per machine: each phase's share of the bar is fixed below, and what
// moves inside a phase is a real count. That is what lets the number go forward
// at a steady-ish pace instead of jumping 25 % at a time.

/** The five phases the page names, in order. Keys into the i18n catalog. */
export const RUN_PHASES = ["network", "disk", "base", "desktop", "config"] as const
export type RunPhase = typeof RUN_PHASES[number]

/**
 * Each phase's share of the bar. Download + installed size is what dominates a
 * real install, so the two package phases carry almost all of it: the desktop
 * pass is ~2.9 GiB installed against the base system's ~1.7 GiB (linux-firmware
 * alone is most of that). The other three are seconds, never minutes.
 */
export const PHASE_WEIGHTS: Record<RunPhase, number> = {
  network: 0.02,
  disk: 0.03,
  base: 0.33,
  desktop: 0.57,
  config: 0.05,
}

/** Overall fraction for `phase` being `frac` of the way through. */
export function overallFraction(phase: number, frac: number): number {
  let total = 0
  RUN_PHASES.forEach((p, i) => {
    if (i < phase) total += PHASE_WEIGHTS[p]
    else if (i === phase) total += PHASE_WEIGHTS[p] * clamp01(frac)
  })
  return clamp01(total)
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

/** What a package phase is doing right now, in a shape the page can word. */
export interface PackageProgress {
  /** 0..1 inside the phase. */
  fraction: number
  /** null while there is no transaction yet — the page then shows the last line. */
  stage: "download" | "install" | null
  done: number
  total: number
}

/** Download is the cheaper half of a package: it counts for this much of it. */
const DOWNLOAD_SHARE = 0.35

// ── base: pacstrap on a pty ────────────────────────────────────────────────

/**
 * The FIRST pacstrap transaction is the base system; archinstall runs several
 * small ones afterwards (zram-generator 1/1, efibootmgr 2/2, networkmanager 20)
 * and each would otherwise drag the count back to the start. So the first total
 * seen is the one tracked, and once it is fully installed the phase is done.
 */
export class BaseProgress {
  private total = 0
  private downloaded = 0
  private installed = 0

  /** Feed one line of archinstall's stdout (already stripped of ANSI). */
  feed(line: string): void {
    const inst = /^\s*\(\s*(\d+)\/(\d+)\)\s+(?:installing|upgrading|reinstalling)\s/.exec(line)
    if (inst) {
      const [n, of] = [Number(inst[1]), Number(inst[2])]
      if (this.total === 0) this.total = of
      // Only the first transaction's total counts: a later (1/1) is another pass.
      if (of === this.total) { this.installed = n; this.downloaded = this.total }
      return
    }
    const dl = /Total\s*\(\s*(\d+)\/(\d+)\)/.exec(line)
    if (dl) {
      const [n, of] = [Number(dl[1]), Number(dl[2])]
      if (this.total === 0) this.total = of
      if (of === this.total) this.downloaded = n
    }
  }

  get progress(): PackageProgress {
    const t = this.total
    if (t === 0) return { fraction: 0, stage: null, done: 0, total: 0 }
    // Done counting: from here to the desktop archinstall builds the initramfs,
    // makes the users and runs smaller passes, and "158 of 158" frozen over a
    // minute of that reads as stuck. The page shows the last line instead.
    if (this.installed >= t) return { fraction: 1, stage: null, done: t, total: t }
    const installing = this.installed > 0
    return {
      fraction: clamp01(DOWNLOAD_SHARE * (this.downloaded / t) + (1 - DOWNLOAD_SHARE) * (this.installed / t)),
      stage: installing ? "install" : "download",
      done: installing ? this.installed : this.downloaded,
      total: t,
    }
  }
}

// ── desktop: the custom commands' log, and the target's package database ───

export interface DesktopLogState {
  /** Index (0-based) of the transaction in progress, -1 before the first. */
  tx: number
  /** Packages in the LARGEST transaction seen — the desktop itself. */
  total: number
  /** Index of that largest transaction. */
  mainTx: number
  downloaded: number
  /** pacman has moved on to installing (":: Processing package changes..."). */
  installing: boolean
  /** Its post-transaction hooks have started: the packages are all in. */
  finished: boolean
  /** The last non-empty line, for when there is nothing to count. */
  lastLine: string
}

/** Reads COMMAND_LOG as it grows. Pure: text in, state out. */
export function readDesktopLog(text: string): DesktopLogState {
  const s: DesktopLogState = {
    tx: -1, total: 0, mainTx: -1, downloaded: 0, installing: false, finished: false, lastLine: "",
  }
  let tx = -1
  let txTotal = 0, txDownloaded = 0, txInstalling = false, txFinished = false
  const settle = () => {
    // A transaction as big as or bigger than the main one becomes the main one.
    if (tx >= 0 && txTotal >= s.total) {
      s.total = txTotal; s.mainTx = tx
      s.downloaded = txDownloaded; s.installing = txInstalling; s.finished = txFinished
    }
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    s.lastLine = line
    const pk = /^Packages \((\d+)\)/.exec(line)
    if (pk) {
      settle()
      tx++
      txTotal = Number(pk[1]); txDownloaded = 0; txInstalling = false; txFinished = false
      continue
    }
    if (tx < 0) continue
    if (/ downloading\.\.\.$/.test(line)) txDownloaded++
    else if (line.startsWith(":: Processing package changes")) txInstalling = true
    else if (line.startsWith(":: Running post-transaction hooks")) txFinished = true
  }
  settle()
  s.tx = tx
  // A later, smaller transaction (nidara-release) means the big one is behind us.
  if (s.mainTx >= 0 && tx > s.mainTx) s.finished = true
  return s
}

/**
 * The desktop phase's progress: downloads from the log, installs from how many
 * packages the target's database gained since the main transaction began.
 */
export function desktopProgress(s: DesktopLogState, installedSinceMainTx: number): PackageProgress {
  if (s.total === 0) return { fraction: 0, stage: null, done: 0, total: 0 }
  if (s.finished) return { fraction: 1, stage: null, done: s.total, total: s.total }
  const downloaded = Math.min(s.downloaded, s.total)
  const installed = s.installing ? Math.min(Math.max(0, installedSinceMainTx), s.total) : 0
  return {
    fraction: clamp01(DOWNLOAD_SHARE * (downloaded / s.total) + (1 - DOWNLOAD_SHARE) * (installed / s.total)),
    stage: s.installing ? "install" : "download",
    done: s.installing ? installed : downloaded,
    total: s.total,
  }
}

/**
 * A line not worth showing under the bar: archinstall announcing a custom
 * command prints our wrapper verbatim (`set -o pipefail; { set +o pipefail; …`).
 *
 * ⚠️ It is NOT where the desktop phase starts. That line reached the page only
 * after the desktop install had finished (block-buffered Python, 2026-09-23); the
 * run page starts the phase when COMMAND_LOG appears in the target instead.
 */
export function isPlumbing(line: string): boolean {
  return line.startsWith("Executing custom command") || line.startsWith("[EXEC]")
}
