// run-progress-probe — the run page's numbers, fed the lines a real install prints.
//
//   ./scripts/bundle.sh --js scripts/dev/run-progress-probe.ts /tmp/run-progress.js \
//     && gjs -m /tmp/run-progress.js
//
// No window, no disk: `lib/run-progress.ts` is text in, numbers out, and the text
// here is excerpted from the entire-disk install of 2026-09-23 (the e2e's
// installer-log.txt and install-commands.txt), trimmed to the lines that move a
// count plus the ones that must NOT.
//
// ─── WHAT IT GUARDS ──────────────────────────────────────────────────────────
// · base: pacstrap's LATER passes (zram-generator 1/1, efibootmgr 2/2,
//   networkmanager 20) must not drag the count back to the start. They arrive
//   seconds after the base system finishes, and a bar that ran to 100 % and fell
//   to 5 % would read as the install starting over.
// · desktop: downloads are counted after `Packages (N)` only (the database sync
//   prints ` core downloading...` too); the big transaction stays the one tracked
//   when nidara-release's `Packages (1)` follows; the post-transaction hooks mean
//   everything is in.
// · the overall figure only ever moves forward through the phases and ends at 1.
import {
  BaseProgress, desktopProgress, isPlumbing, overallFraction, readDesktopLog,
} from "../../ui/installer/lib/run-progress"

let failures = 0
function fail(what: string, detail: string) { failures++; print(`FAIL  ${what} — ${detail}`) }
function eq(what: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(what, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  else print(`ok    ${what}`)
}

// ── base ─────────────────────────────────────────────────────────────────────
const base = new BaseProgress()
const feed = (lines: string[]) => lines.forEach(l => base.feed(l))
eq("base: nothing counted before pacstrap", base.progress.stage, null)
feed([
  "Installing packages: ['base', 'sudo', 'linux-firmware', 'mkinitcpio', 'linux', 'btrfs-progs']",
  "==> Installing packages to /mnt",
  " Total (  0/158)         0.0   B  0.00   B/s 00:00 [----------------------]   0%",
  " Total ( 79/158)       611.8 MiB  75.3 MiB/s 00:00 [###################---]  90%",
])
eq("base: downloading 79 of 158", [base.progress.stage, base.progress.done, base.progress.total], ["download", 79, 158])
feed([
  " Total (158/158)       702.0 MiB  75.3 MiB/s 00:00 [######################] 100%",
  ":: Processing package changes...",
  "(  1/158) installing iana-etc                      [######################] 100%",
  "( 40/158) installing glibc                         [######################] 100%",
])
eq("base: installing 40 of 158", [base.progress.stage, base.progress.done], ["install", 40])
const mid = base.progress.fraction
feed(["(158/158) installing btrfs-progs                   [######################] 100%"])
eq("base: complete at 158 of 158, and the counter steps aside", [base.progress.fraction, base.progress.stage], [1, null])
if (!(mid > 0.35 && mid < 1)) fail("base: mid-install fraction", `got ${mid}`)
feed([
  "Installing packages: ['zram-generator']",
  "(1/1) checking keys in keyring                     [######################] 100%",
  "(1/1) installing zram-generator                    [######################] 100%",
  " Total ( 0/20)           0.0   B  0.00   B/s 00:00 [----------------------]   0%",
  "( 1/20) installing libmm-glib                      [######################] 100%",
])
eq("base: later small passes do not reset it", [base.progress.fraction, base.progress.done, base.progress.total], [1, 158, 158])

// ── desktop ──────────────────────────────────────────────────────────────────
const LOG_HEAD = [
  ">> [nidara] the repository has an address",
  ">> [nidara] trusting the repo signing key",
  ">> installing the desktop",
  ":: Synchronizing package databases...",
  " core downloading...",
  " extra downloading...",
  " multilib downloading...",
]
eq("desktop: before `Packages`, nothing to count", desktopProgress(readDesktopLog(LOG_HEAD.join("\n")), 0).stage, null)
eq("desktop: last line is kept for the page", readDesktopLog(LOG_HEAD.join("\n")).lastLine, "multilib downloading...")

const downloads = Array.from({ length: 212 }, (_, i) => ` pkg${i}-1.0-1-x86_64 downloading...`)
const LOG_DL = [...LOG_HEAD, "Packages (477) aalib-1.4rc5-19  abseil-cpp-20260817.0-2", "", "Total Download Size:    854.51 MiB",
  ":: Proceed with installation? [Y/n] ", ":: Retrieving packages...", ...downloads]
const dl = desktopProgress(readDesktopLog(LOG_DL.join("\n")), 0)
eq("desktop: 212 of 477 downloaded (db sync lines not counted)", [dl.stage, dl.done, dl.total], ["download", 212, 477])

const all = Array.from({ length: 477 }, (_, i) => ` pkg${i}-1.0-1-x86_64 downloading...`)
const LOG_INST = [...LOG_HEAD, "Packages (477) aalib", ...all, ":: Processing package changes...", "Creating group 'polkitd' with GID 102."]
const inst = desktopProgress(readDesktopLog(LOG_INST.join("\n")), 300)
eq("desktop: installing 300 of 477", [inst.stage, inst.done], ["install", 300])
eq("desktop: a database count past the total is capped", desktopProgress(readDesktopLog(LOG_INST.join("\n")), 900).done, 477)

const LOG_DONE = [...LOG_INST, ":: Running post-transaction hooks...", "( 1/27) Configuring dynamic linker run-time bindings..."]
eq("desktop: hooks started = all packages in", desktopProgress(readDesktopLog(LOG_DONE.join("\n")), 12).fraction, 1)

const LOG_RELEASE = [...LOG_INST, ">> [nidara] the system says its own name", "Packages (1) nidara-release-2-1",
  " nidara-release-2-1-any downloading...", ":: Processing package changes..."]
const rel = readDesktopLog(LOG_RELEASE.join("\n"))
eq("desktop: nidara-release's transaction does not replace the desktop's", [rel.total, rel.mainTx, rel.finished], [477, 0, true])

// ── the line under the bar, and the phase boundary ───────────────────────────
const WRAPPER = `Executing custom command "set -o pipefail; { set +o pipefail; set -e; echo '>> installing the desktop'; pacman -Sy --noconfirm nidara-desktop`
eq("the command wrapper is never shown under the bar", isPlumbing(WRAPPER), true)
eq("an ordinary line is shown", isPlumbing("Creating user nidara"), false)

// ── overall ──────────────────────────────────────────────────────────────────
let prev = -1
let monotonic = true
for (let phase = 0; phase < 5; phase++) {
  for (const f of [0, 0.25, 0.5, 1]) {
    const v = overallFraction(phase, f)
    if (v + 1e-9 < prev) monotonic = false
    prev = v
  }
}
eq("overall only moves forward", monotonic, true)
eq("overall ends at 1", Math.round(overallFraction(4, 1) * 1000) / 1000, 1)

print(failures === 0 ? "\nALL RULES HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)
