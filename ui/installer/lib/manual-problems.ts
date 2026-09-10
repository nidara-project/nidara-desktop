// The rules a manual layout has to satisfy, and the words for each one it does not.
//
// ⚠️ This lives in `lib/` rather than in the page, and it is not a tidiness move:
// the page imports Gtk, and a rule that can only be evaluated with a display is a
// rule that can only be checked by clicking. Here it is a pure function of the
// table's rows, so `scripts/dev/disk-config-probe.ts` can put layouts through it
// — including the ones it must REFUSE, which is the half nothing could reach
// before.

import { t } from "./i18n"
import { espMount } from "./disk-config"
import { formatSize } from "./format-size"
import type { ManualPartitionMount } from "./answers"

/**
 * Where the EFI system partition goes on this install. One place, on purpose.
 *
 * ⚠️ This was a set of three — `/boot`, `/boot/efi`, `/efi` — and two of them
 * produced an install that finished, reported success and then stopped at the
 * boot menu with `Error loading /vmlinuz-linux: Not Found` (#430). We install
 * systemd-boot with `uki: false`, so the loader entry says `linux
 * /vmlinuz-linux`, a path relative to the partition the ENTRY is on; pacman and
 * mkinitcpio put that file in `/boot` on the root filesystem. Mount the ESP
 * anywhere but `/boot` and the entry is valid, the loader is installed, and the
 * file it names is on another partition.
 *
 * Decision A of #430. It stays a Set because it is the shape the two callers
 * want, and because a second legal spelling is a change of ONE line here rather
 * than a rule to re-derive.
 */
export const ESP_MOUNTS = new Set(["/boot"])

/**
 * The smallest EFI system partition this install can be put on.
 *
 * ⚠️ It is not a style rule, it is a capacity: we install systemd-boot with
 * `uki: false`, so the ESP is mounted at `/boot` and pacstrap puts the kernel and
 * BOTH initramfs images inside it. Measured on a running machine (2026-09-06):
 * a 512 MiB ESP carrying two kernels — `linux` and `linux-zen` — plus the loader
 * is **250 MB used, 49%**. One kernel and its two initramfs images is therefore
 * ~125 MB, half again as much as the ~95 MB the issue estimated from package
 * sizes, because a fallback initramfs carries every module.
 *
 * 300 MiB is that ~125 MB, plus the boot files of whatever system was already on
 * a shared ESP (a factory Windows one runs 30-50 MB), plus the headroom an
 * upgrade needs while the new kernel is written beside the old one.
 *
 * Where the number sits between the two we know:
 *
 *   200 MiB  archinstall refuses below this (`installer.py:249`) — and it refuses
 *            INSIDE the install, after our summary said everything was fine, so
 *            our floor may never be lower than theirs
 *   512 MiB  what entire-disk mode creates, and what the measurement above says
 *            is comfortable rather than merely possible
 *
 * The failure this refuses is the reason it is a refusal and not a warning: a
 * 100 MiB factory Windows ESP takes the layout, takes the repartitioning, and
 * then dies partway through pacstrap with the disk already rewritten.
 */
export const ESP_MIN_BYTES = 300 * 1024 * 1024

/**
 * Everything wrong with a manual layout right now, in the user's language.
 * Empty means installable — which is exactly what `ready()` asks.
 *
 * It exists as one function because the page and the Continue button have to
 * agree, and before this they did not agree about anything a user could see:
 * `ready()` knew the two requirements and said nothing (the button simply stayed
 * dead, D-16), and NOTHING knew about the third — two partitions could both be
 * given `/home`, or `/`, and the installer accepted it and then mounted one over
 * the other (D-17).
 *
 * ⚠️ `uefi` is passed in rather than read here, and that is what makes the
 * function testable: `/sys/firmware/efi` is a property of the machine the code
 * happens to be running on, so a rule that read it directly would give a
 * different answer on a probe runner than on the medium — and the BIOS half
 * would never be exercised at all.
 *
 * ⚠️ `swap` is deliberately not a duplicate. Several swap partitions on one
 * machine are a normal layout, and unlike a mount point swap is not a place —
 * `swapon` takes as many as it is given.
 */
export interface ManualProblem {
  message: string
  /**
   * The offending partition mount, or null when the problem is something missing
   * from the layout (no root, no ESP) rather than something wrong with a row.
   */
  entry: ManualPartitionMount | null
}

export function manualProblems(mounts: ManualPartitionMount[], uefi: boolean): ManualProblem[] {
  const problems: ManualProblem[] = []
  if (!mounts.some(m => m.mountpoint === "/")) problems.push({ message: t("diskErrNoRoot"), entry: null })
  if (uefi && !mounts.some(m => ESP_MOUNTS.has(m.mountpoint))) problems.push({ message: t("diskErrNoBoot"), entry: null })

  // ⚠️ The EFI system partition has to be FAT32, and nothing said so: the
  // filesystem dropdown defaults to btrfs and applies to whatever the row was
  // given, so assigning a partition to /boot and leaving Format ticked —
  // which the smart default does FOR you on anything that is not already vfat —
  // formatted the ESP as btrfs. The install then ran to completion, reported
  // success, and produced a machine whose firmware cannot read its own boot
  // partition: the same shape as the legacy-BIOS case `ready()` refuses
  // outright, an install that finishes and then does not boot.
  //
  // Which mount IS the ESP depends on the layout, and getting that wrong would
  // refuse a valid one — the rule is `espMount`, shared with the layout that has
  // to flag that partition for archinstall, the summary that names it, and the
  // bootloader patching that has to write into it. Four answers that must agree,
  // so there is one.
  const esp = espMount(mounts)
  // Formatting it settles the question; keeping it means what lsblk already
  // reports has to be FAT — including the case where it reports nothing at all,
  // which is not a filesystem the firmware can read either.
  if (esp && (esp.format ? esp.filesystem !== "vfat" : esp.fsType !== "vfat")) {
    problems.push({ message: t("diskErrEfiNotFat"), entry: esp })
  }

  // ⚠️ And it has to be big enough to hold a kernel, which nothing checked (#446).
  // The size is stated in the message — both the one it needs and the one it
  // found — because "too small" without a number leaves the person guessing at
  // the one thing they have to go and change, in a partition editor, on another
  // screen.
  if (esp && esp.size < ESP_MIN_BYTES) {
    problems.push({ message: t("diskErrEfiTooSmall") + formatSize(esp.size) + ".", entry: esp })
  }

  // ⚠️ Swap is the one row whose filesystem is not a choice, so an untick means
  // "it is already swap" — and if it is not, archinstall has nothing to activate:
  // a partition with no mount point and a type that is not `linux-swap` is
  // silently skipped, and the machine boots with no swap at all. That is the same
  // shape as the ESP check above: an answer accepted and then quietly dropped.
  for (const m of mounts) {
    if (m.mountpoint === "swap" && !m.format && m.fsType !== "swap") {
      problems.push({ message: t("diskErrSwapNotSwap"), entry: m })
    }
  }

  // ⚠️ The Format tick is editable on every row, including the one assigned to
  // `/`, and unticking it there was accepted (H-04). `manualDiskConfig` sends
  // that row as `status: "existing"`, which archinstall skips in BOTH
  // `device_handler.partition()` and `_format_partitions()` — it is mounted and
  // nothing else — and then pacstrap runs onto whatever was already there.
  // pacman aborts on the first collision in /usr and leaves half a system on a
  // disk its owner believed they were keeping.
  //
  // The same untick also covers a partition with NO filesystem at all: lsblk
  // reports FSTYPE empty, `existingFsType` returns null, and there is nothing to
  // mount. One refusal closes both.
  //
  // Calamares blocks this outright (`PartitionViewStep.cpp:399-408`, unless it
  // recognises an official upgrade scenario, which Nidara does not have) and
  // subiquity does not offer it at all (`ROOT_MOUNTED`). Requiring the tick
  // costs nothing in the legitimate case — an empty partition is formatted in a
  // second — and an empty root cannot be told from a full one from this page
  // without mounting it, which this bundle deliberately no longer does.
  const root = mounts.find(m => m.mountpoint === "/")
  if (root && !root.format) problems.push({ message: t("diskErrRootNotFormatted"), entry: root })

  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const m of mounts) {
    if (m.mountpoint === "" || m.mountpoint === "swap") continue
    if (seen.has(m.mountpoint)) dupes.add(m.mountpoint)
    seen.add(m.mountpoint)
  }
  if (dupes.size > 0) {
    const msg = t("diskErrDuplicateMount") + [...dupes].join(", ")
    for (const m of mounts) {
      if (dupes.has(m.mountpoint)) {
        problems.push({ message: msg, entry: m })
      }
    }
  }

  return problems
}
