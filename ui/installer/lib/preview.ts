// Preview mode — walk the whole installer on a machine somebody is using.
//
// ─── WHY THIS IS ITS OWN FLAG AND NOT "IT IS SAFE ANYWAY" ────────────────────
// Not arming is already load-bearing and already correct: `isArm` requires
// /run/archiso, so on a desktop `prepareDiskAndMounts` executes nothing at all
// (the gate is inside `runCmd`, so even the `umount -R /mnt` is only logged),
// `applyRealName` and `configureInstalledBootloader` return on their first line,
// and archinstall would be handed `--dry-run`.
//
// But that safety is the ABSENCE OF A FILE, which is the right shape for arming
// and the wrong shape for a licence to run this on somebody's desktop. Three
// things sit outside the `arm` gate entirely, because they are not installation
// steps — they are the installer talking to the session it is running in:
//
//   region.ts     `hyprctl keyword input:kb_layout` — changes the REAL keyboard
//   InstallerWindow  "Restart now" → `systemctl reboot` — reboots the machine
//   run.ts        spawns `sudo -n archinstall`, after writing the credentials
//                 file to /tmp
//
// Every one of those is correct on the live medium and unacceptable on a desktop.
// So preview is declared rather than inferred, and it can only ever make things
// SAFER: nothing here can arm anything, and `isArm` does not read it. A typo in
// the variable leaves you with the installer refusing to touch your session, not
// with an installer touching your disk.
//
// ⚠️ It also has to be VISIBLE. An installer that looks exactly like the real one
// and quietly does nothing is the instrument pretending to be the patient; the
// window wears a banner so a screenshot of a preview can never be mistaken for a
// screenshot of an install.
//
//   NIDARA_INSTALLER_PREVIEW=1 ./ui/installer/build/nidara-installer
//
// The welcome step still needs the product's `base.json`, which only the medium
// ships. `lib/base-config.ts` already falls back to `./base.json`, so:
//
//   cp ~/Dev/nidara-iso/profile/airootfs/usr/share/nidara-installer/base.json .
//
// — the REAL one, on purpose. A stub invented here would be a fourth thing that
// looks like the product and is not.

import GLib from "gi://GLib"

let _preview: boolean | null = null

/** Declared once, read everywhere. */
export function isPreview(): boolean {
  if (_preview === null) _preview = GLib.getenv("NIDARA_INSTALLER_PREVIEW") === "1"
  return _preview
}

/**
 * Log a side effect that preview refused to perform.
 *
 * Refusals go in the log rather than being silent, because the point of walking
 * the installer is to see what it would do — a step that quietly does nothing
 * reads as a step that has nothing to do.
 */
export function previewSkip(what: string): string {
  return `[PREVIEW] not executed: ${what}`
}
