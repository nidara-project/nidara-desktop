// summary-probe — what the last page before an irreversible click actually says.
//
//   cd ui/installer && npx --yes sass@1.97.3 --no-charset style.scss style.css && cd ../..
//   ./scripts/bundle.sh scripts/dev/summary-probe.ts /tmp/summary-probe && /tmp/summary-probe
//
//   SUMMARY_PROBE_SEED=swap      manual layout with a swap PARTITION (#456)
//   SUMMARY_PROBE_SEED=entire    entire-disk btrfs
//   SUMMARY_PROBE_SEED=manual    manual, no swap partition
//
// ⚠️ Needs `base.json` where `lib/base-config.ts` looks for it — the medium's
// path, or `./base.json` relative to the CWD you launch from. Without it the
// whole "what Nidara sets up for you" group is empty (it is one `if (config)`),
// and a probe reporting an empty group looks exactly like a page with nothing in
// it. Copy it from nidara-iso:
//
//   cp ~/Dev/nidara-iso/profile/airootfs/usr/share/nidara-installer/base.json .
//
// ⚠️ It mounts ONE STEP, never the installer — same rule and same reason as
// `disk-page-probe.ts` and `region-page-probe.ts`: `InstallerWindow` constructs
// `RunStep`, and the rule that the installer only runs in a VM is a rule about
// the PROCESS existing on somebody's machine, not about this code being reached.
//
// ─── WHY IT EXISTS ───────────────────────────────────────────────────────────
// The summary is composed from six sources — the answers, `base.json`, and a few
// facts stated nowhere else — and every defect found in it so far has been a
// mismatch between two of them: a country named from the raw tzdata table while
// the list used ICU (#452), a filesystem row in the "you chose" group after it
// stopped being a choice (#457), a Swap row reporting our zram while the person
// had just assigned a partition (#456).
//
// None of those is visible in the code of one function, and reaching this page
// by hand costs a six-page walk through synthetic clicks whose coordinates move
// under you as the layout reflows. So the page is seeded and printed instead.

import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import app from "../../ui/lib/host"
import { installAppearance } from "../../ui/lib/appearance-css"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { NidaraClamp, NidaraScrolled, NidaraWindow } from "../../ui/lib/nidara-kit"
import { WINDOW_LAYOUT } from "../../ui/lib/tokens"
import { SummaryStep } from "../../ui/installer/steps/summary"
import {
  setDiskAnswer, setAccountAnswer, setCountryAnswer, setLanguageAnswer,
  type ManualPartitionMount,
} from "../../ui/installer/lib/answers"

GLib.setenv("GTK_THEME", "nidara", true)

const here = GLib.get_current_dir()
const css = [`${here}/ui/installer/style.css`, "./ui/installer/style.css", "./style.css"]
  .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))

const MIB = 1024 * 1024
const GIB = 1024 * MIB

const mount = (
  path: string, mountpoint: string, size: number,
  extra: Partial<ManualPartitionMount> = {},
): ManualPartitionMount => ({
  name: path.replace("/dev/", ""), path, device: "/dev/vda",
  start: 1 * MIB, size, logicalSectorSize: 512,
  fsType: null, label: null, mountpoint, filesystem: "btrfs", format: true,
  ...extra,
})

/**
 * Every row is `NidaraRow(title, subtitle)`, so the page reads as a flat list of
 * labels in document order — which is also the order somebody reads them in.
 */
function labels(root: Gtk.Widget, out: string[] = []): string[] {
  if (root instanceof Gtk.Label) {
    const t = root.get_text()
    if (t) out.push(t)
  }
  let child = root.get_first_child()
  while (child) {
    labels(child, out)
    child = child.get_next_sibling()
  }
  return out
}

app.start({
  applicationId: "org.nidara.installer.summaryprobe",
  applicationName: "Summary probe",
  logDomain: "summary-probe",
  css,

  main() {
    applyCrispFontRendering()
    installAppearance()

    const seed = GLib.getenv("SUMMARY_PROBE_SEED") || "swap"

    setLanguageAnswer({ code: "en", label: "English" } as any)
    setCountryAnswer({ code: "GB", name: "Britain (UK)" })
    setAccountAnswer({
      fullName: "Nidara User", username: "nidara",
      password: "x", hostname: "nidara",
    })

    if (seed === "entire") {
      setDiskAnswer({
        mode: "entire_disk",
        disk: { name: "vda", path: "/dev/vda", size: 40 * GIB, model: null, rm: false, logicalSectorSize: 512 },
        filesystem: "btrfs",
      } as any)
    } else {
      const mounts = [
        mount("/dev/vda1", "/boot", 512 * MIB, { format: false, fsType: "vfat", filesystem: "vfat" }),
        mount("/dev/vda2", "/", 20 * GIB),
      ]
      // The case this probe was written for: a partition the person assigned to
      // swap, next to the zram `base.json` turns on without asking.
      if (seed === "swap") mounts.push(mount("/dev/vda4", "swap", 2 * GIB))
      setDiskAnswer({ mode: "manual", mounts })
    }

    const step = SummaryStep()
    const page = step.build!(() => {})

    // A widget with no root has no style context, and this page's rows are built
    // on entry — so it has to be in a window before anything is read out of it.
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["installer-body"] })
    body.append(page)
    const { widget: scrolled } = NidaraScrolled({
      child: NidaraClamp(body, WINDOW_LAYOUT.wizardContent, true, WINDOW_LAYOUT.wizardContent),
      reserveLane: false,
    })
    const win = NidaraWindow({
      app: this, title: "Summary probe", content: scrolled,
      width: WINDOW_LAYOUT.wizardContent + 96, height: 900,
    })
    win.window.present()
    step.onEnter?.()

    GLib.idle_add(GLib.PRIORITY_LOW, () => {
      print(`\n─── summary (seed: ${seed}) ───`)
      for (const l of labels(page)) print(`   ${l.replace(/\n/g, "\n     ")}`)
      print("")
      if (GLib.getenv("SUMMARY_PROBE_ONCE") === "1") app.quit()
      return GLib.SOURCE_REMOVE
    })
  },
})
