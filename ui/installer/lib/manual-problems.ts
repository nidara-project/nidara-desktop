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
import type { ManualPartitionMount } from "./answers"

/** The three mount points that can hold the EFI system partition on this install. */
export const ESP_MOUNTS = new Set(["/boot", "/boot/efi", "/efi"])

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
export function manualProblems(mounts: ManualPartitionMount[], uefi: boolean): string[] {
  const problems: string[] = []
  if (!mounts.some(m => m.mountpoint === "/")) problems.push(t("diskErrNoRoot"))
  if (uefi && !mounts.some(m => ESP_MOUNTS.has(m.mountpoint))) problems.push(t("diskErrNoBoot"))

  // ⚠️ The EFI system partition has to be FAT32, and nothing said so: the
  // filesystem dropdown defaults to btrfs and applies to whatever the row was
  // given, so assigning a partition to /boot/efi and leaving Format ticked —
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
    problems.push(t("diskErrEfiNotFat"))
  }

  // ⚠️ Swap is the one row whose filesystem is not a choice, so an untick means
  // "it is already swap" — and if it is not, archinstall has nothing to activate:
  // a partition with no mount point and a type that is not `linux-swap` is
  // silently skipped, and the machine boots with no swap at all. That is the same
  // shape as the ESP check above: an answer accepted and then quietly dropped.
  if (mounts.some(m => m.mountpoint === "swap" && !m.format && m.fsType !== "swap")) {
    problems.push(t("diskErrSwapNotSwap"))
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
  if (root && !root.format) problems.push(t("diskErrRootNotFormatted"))

  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const m of mounts) {
    if (m.mountpoint === "" || m.mountpoint === "swap") continue
    if (seen.has(m.mountpoint)) dupes.add(m.mountpoint)
    seen.add(m.mountpoint)
  }
  if (dupes.size > 0) problems.push(t("diskErrDuplicateMount") + [...dupes].join(", "))

  return problems
}
