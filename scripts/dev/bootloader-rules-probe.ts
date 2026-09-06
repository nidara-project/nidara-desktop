// bootloader-rules-probe — what we are allowed to touch on an EFI partition that
// is not only ours.
//
//   ./scripts/bundle.sh --js scripts/dev/bootloader-rules-probe.ts /tmp/bootloader-probe.js \
//     && gjs -m /tmp/bootloader-probe.js
//
// No window, no GTK, no disk, and it reads nothing about the machine it runs on:
// every input below is a string that would have come off an ESP.
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// An EFI system partition can be shared. Somebody installing Nidara beside an
// existing Windows, Ubuntu or Arch reuses the ESP that is already there — one
// firmware menu with everything on it, which is the whole point of reusing it —
// and `loader/entries/` then holds their entries next to ours.
//
// Until 2026-09-06 every edit in `lib/bootloader.ts` ran over `*.conf` and over
// `loader.conf` flat, so on such a machine we:
//
//   · retitled a neighbouring Arch install's entry to `Nidara`, leaving two
//     entries with our name, one of which boots somebody else's system (#443);
//   · appended OUR kernel command line to any foreign entry that did not already
//     say `quiet` (#443);
//   · overwrote a `loader.conf` that belonged to whoever installed first,
//     destroying their `default`, their `timeout` and their console settings —
//     the one place in the chain where both systemd's `bootctl install` and
//     archinstall are careful and we were not (#444);
//   · and answered "is there another OS?" by looking for Windows and only
//     Windows, so a machine whose neighbour is Linux got `timeout 0` and a menu
//     that never appears (#445).
//
// None of that is visible from this repo. It needs a machine with somebody
// else's system already on it, and the damage is to THAT system — which is why
// the rules are pure functions and why they are checked here, on every push,
// instead of on the day somebody reports that their Ubuntu is gone from the menu.

import {
  entryIsOurs,
  otherOsPresent,
  patchLoaderConf,
  retitleEntry,
  withSilentParams,
} from "../../ui/installer/lib/bootloader"

let failures = 0
function fail(name: string, msg: string): void {
  failures++
  print(`   ✗ ${name}: ${msg}`)
}
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) print(`   ok           ${name}`)
  else fail(name, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

const SILENT = "quiet splash loglevel=3"
const STARTED = "2026-09-06_20-30-00"

/** An entry as archinstall writes it (`installer.py:1224-1232`). */
const archEntry = (stamp: string, kernel = "linux", options = "root=UUID=abc rw") =>
  `# Created by: archinstall\n# Created on: ${stamp}\n`
  + `title\tArch Linux (${kernel})\nlinux\t/vmlinuz-${kernel}\n`
  + `initrd\t/initramfs-${kernel}.img\noptions ${options}\n`

print("\n── Whose entry is this? ────────────────────────────────────────────")

check("ours: this run's stamp",
  entryIsOurs(archEntry("2026-09-06_20-30-11"), STARTED), true)
check("ours: stamped in the same second we started",
  entryIsOurs(archEntry(STARTED), STARTED), true)
// The case the whole mechanism exists for: a neighbouring Arch, installed by
// archinstall months ago, whose entry is titled `Arch Linux (linux)` exactly like
// ours and which the old `sed` renamed.
check("theirs: an older archinstall install",
  entryIsOurs(archEntry("2026-04-01_09-12-00"), STARTED), false)
check("theirs: no archinstall header at all (Ubuntu, hand-written)",
  entryIsOurs("title\tUbuntu\nlinux\t/vmlinuz\noptions root=UUID=xyz ro quiet splash\n", STARTED), false)
check("theirs: our header, no stamp",
  entryIsOurs("# Created by: archinstall\ntitle\tArch Linux (linux)\n", STARTED), false)
// Fails SAFE: an unrecognised header means we edit nothing, which costs a title.
check("unknown format: not claimed",
  entryIsOurs("# Created by: something-else\n# Created on: 2027-01-01_00-00-00\n", STARTED), false)

print("\n── The title ───────────────────────────────────────────────────────")

check("the kernel keeps its name",
  retitleEntry(archEntry(STARTED)).split("\n")[2], "title\tNidara (linux)")
check("a fallback entry too",
  retitleEntry(archEntry(STARTED, "linux-fallback")).split("\n")[2], "title\tNidara (linux-fallback)")
check("a foreign title is not ours to rewrite",
  retitleEntry("title\tUbuntu\n"), "title\tUbuntu\n")

print("\n── The kernel command line ─────────────────────────────────────────")

check("appended once",
  withSilentParams(archEntry(STARTED), SILENT).includes(`options root=UUID=abc rw ${SILENT}`), true)
check("not appended twice",
  withSilentParams(withSilentParams(archEntry(STARTED), SILENT), SILENT).split("loglevel=3").length - 1, 1)
check("an entry that already boots quietly is left alone",
  withSilentParams(archEntry(STARTED, "linux", "root=UUID=abc rw quiet"), SILENT).includes("loglevel=3"), false)
// The old test was `grep -q quiet <file>`, which the header of a hand-written
// entry could satisfy on its own.
check("`quiet` in a comment is not the command line",
  withSilentParams("# boots quiet, allegedly\noptions root=UUID=abc rw\n", SILENT)
    .includes(`rw ${SILENT}`), true)
check("no options line: nothing to append to",
  withSilentParams("title\tNidara\n", SILENT), "title\tNidara\n")

print("\n── loader.conf ─────────────────────────────────────────────────────")

const OURS_ALONE = "default @saved\ntimeout 3\nconsole-mode keep\n"
check("no file yet: we write ours",
  patchLoaderConf(null, { timeout: 3, shared: false }), OURS_ALONE)
check("an empty file counts as no file",
  patchLoaderConf("\n", { timeout: 3, shared: false }), OURS_ALONE)
check("the ESP is ours alone: the canonical file",
  patchLoaderConf("default 2026_linux.conf\ntimeout 15\n", { timeout: 3, shared: false }), OURS_ALONE)

// Everything below is a SHARED ESP: one key changes, and only upwards.
const FOREIGN = "# Ubuntu's\ndefault ubuntu.conf\ntimeout 10\nconsole-mode max\neditor no\n"
check("shared, a longer menu than ours: untouched",
  patchLoaderConf(FOREIGN, { timeout: 3, shared: true }), FOREIGN)
check("shared, timeout 0: raised, and nothing else moves",
  patchLoaderConf("default ubuntu.conf\ntimeout 0\nconsole-mode max\n", { timeout: 3, shared: true }),
  "default ubuntu.conf\ntimeout 3\nconsole-mode max\n")
// systemd reads a commented key as absent, so its number is not a preference —
// and an absent timeout means no menu unless a key is held, which is #445 again.
check("shared, a commented-out timeout: still no menu, so ours goes in",
  patchLoaderConf("default ubuntu.conf\n#timeout 15\n", { timeout: 3, shared: true }),
  "default ubuntu.conf\ntimeout 3\n")
check("shared, no timeout key at all: appended, the rest survives",
  patchLoaderConf("default ubuntu.conf\nconsole-mode max\n", { timeout: 3, shared: true }),
  "default ubuntu.conf\nconsole-mode max\ntimeout 3\n")
check("shared: their default is never ours to change",
  patchLoaderConf(FOREIGN, { timeout: 3, shared: true }).includes("default ubuntu.conf"), true)
check("shared: a key we have never heard of survives",
  patchLoaderConf(FOREIGN, { timeout: 3, shared: true }).includes("editor no"), true)
// `timeout` takes words as well as seconds (`menu-force`, `menu-hidden`). A
// setting we do not understand is not a setting we may overwrite.
check("shared, a timeout that is not a number: left alone",
  patchLoaderConf("default ubuntu.conf\ntimeout menu-force\n", { timeout: 3, shared: true }),
  "default ubuntu.conf\ntimeout menu-force\n")

print("\n── Is anybody else on this machine? ────────────────────────────────")

const alone = { foreignEntries: 0, vendorDirs: ["systemd", "BOOT"], windowsFilesystem: false }
check("a disk we erased: nobody", otherOsPresent(alone), false)
check("Windows, by its vendor directory",
  otherOsPresent({ ...alone, vendorDirs: ["systemd", "BOOT", "Microsoft"] }), true)
check("Windows, by its filesystem",
  otherOsPresent({ ...alone, windowsFilesystem: true }), true)
// The three the old detector could not see, and each of them is a machine that
// silently lost its boot menu.
check("Ubuntu, by its vendor directory",
  otherOsPresent({ ...alone, vendorDirs: ["systemd", "BOOT", "ubuntu"] }), true)
check("Fedora, by its vendor directory",
  otherOsPresent({ ...alone, vendorDirs: ["systemd", "BOOT", "fedora"] }), true)
check("another Arch, by its loader entry",
  otherOsPresent({ ...alone, foreignEntries: 1 }), true)
// An ESP is FAT: which case `ls` reports is not ours to predict.
check("case does not decide whether a system exists",
  otherOsPresent({ ...alone, vendorDirs: ["SYSTEMD", "boot"] }), false)

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)

// Non-zero, or the CI step above it is a gate that can only pass — the lesson
// `disk-config-probe` learned on 2026-09-05.
imports.system.exit(failures === 0 ? 0 : 1)
